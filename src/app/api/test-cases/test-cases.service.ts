// Test-case service — business logic and orchestration.
//
// Owns: permission checks, the draft→review→verdict status flow, version
// bumps + history snapshots, activity logging and reviewer notifications.
// Data access goes exclusively through the repositories; responses are
// produced exclusively through the serializers.

import type { RequestMeta } from '@/lib/activity'
import { resolveExpectedUpdatedAt } from '@/lib/server/optimistic-lock'
import { ApiError, paginate, type PaginatedResponse } from '@/lib/api'
import { can, ensurePermission, type SessionUser } from '@/lib/auth'
import { logActivity, parseJson } from '@/lib/activity'
import { createNotification } from '@/lib/notifications'
import { logger } from '@/lib/logger'
import { db } from '@/lib/db'
import { serializeTestCase, serializeTestCaseHistory, serializeReviewRequest, type SerializedTestCase, type SerializedTestCaseHistory, type SerializedReviewRequest } from '@/lib/serializers'
import { findFirstActiveReviewer, findUserById } from '@/lib/server/user.repository'
import { findModuleById } from '../modules/modules.repository'
import { MAX_IMPORT_ROWS, parseCsvDocument, parseCsvTags, type CsvMatrix } from '@/lib/server/csv'
import type { ImportRowResult, ImportTestCasesResult, ImportTemplate } from '@/types'
import {
  countTestCases,
  findTestCaseById,
  hardDeleteTestCase,
  insertTestCase,
  insertTestCaseHistory,
  listTestCaseHistory,
  listTestCases,
  listTestCasesByIds,
  updateTestCaseIfVersion,
  updateTestCaseStatus,
  type TestCaseFilters,
  type TestCaseUpdateFields,
} from './test-cases.repository'
import {
  findLatestCycleForTestCase,
  insertReviewRequest,
  listEventsByRequestIds,
  listReviewsByTestCase,
} from '../reviews/reviews.repository'

// ---------- Queries ----------

export async function listTestCasesPaginated(
  q: Record<string, string>
): Promise<PaginatedResponse<SerializedTestCase>> {
  const filters: TestCaseFilters = {
    moduleId: q.moduleId,
    status: q.status,
    priority: q.priority,
    authorId: q.authorId,
    search: q.search,
  }
  const page = Math.max(1, parseInt(q.page ?? '1', 10) || 1)
  const pageSize = Math.min(100, Math.max(1, parseInt(q.pageSize ?? '20', 10) || 20))
  const [total, rows] = await Promise.all([
    countTestCases(filters),
    listTestCases(filters, pageSize, (page - 1) * pageSize),
  ])
  return paginate(rows.map(serializeTestCase), total, page, pageSize)
}

export async function getTestCase(testCaseId: string): Promise<SerializedTestCase> {
  const tc = await findTestCaseById(testCaseId)
  if (!tc) throw ApiError.notFound('Test case not found')
  return serializeTestCase(tc)
}

export async function getTestCaseHistory(testCaseId: string): Promise<SerializedTestCaseHistory[]> {
  return (await listTestCaseHistory(testCaseId)).map(serializeTestCaseHistory)
}

export async function getTestCaseReviews(testCaseId: string): Promise<SerializedReviewRequest[]> {
  const reviews = await listReviewsByTestCase(testCaseId)
  const events = await listEventsByRequestIds(reviews.map((r) => r.review_request_id))
  const eventsByRequest = new Map<string, typeof events>()
  for (const event of events) {
    const list = eventsByRequest.get(event.review_request_id) ?? []
    list.push(event)
    eventsByRequest.set(event.review_request_id, list)
  }
  return reviews.map((r) => serializeReviewRequest({ ...r, events: eventsByRequest.get(r.review_request_id) ?? [] }))
}

// ---------- Commands ----------

export async function createTestCase(
  me: SessionUser,
  input: {
    moduleId?: string | null
    title: string
    description?: string
    preconditions?: string
    expectedResult?: string
    priority: string
    tags: string[]
    assigneeId?: string | null
  },
  meta: RequestMeta
): Promise<SerializedTestCase> {
  ensurePermission(me, 'create_test_case')
  // Fail fast with a clean 404 (same contract as module create for parentId):
  // a nonexistent moduleId/assigneeId must never surface as a raw FK 500.
  if (input.moduleId) {
    const mod = await findModuleById(input.moduleId)
    if (!mod) throw ApiError.notFound('Module not found')
  }
  if (input.assigneeId) {
    const assignee = await findUserById(input.assigneeId)
    if (!assignee) throw ApiError.notFound('Assignee not found')
  }
  const created = await insertTestCase({
    moduleId: input.moduleId ?? null,
    title: input.title,
    description: input.description ?? null,
    preconditions: input.preconditions ?? null,
    expectedResult: input.expectedResult ?? null,
    priority: input.priority,
    tags: input.tags,
    authorId: me.userId,
    lastEditedById: me.userId,
    assigneeId: input.assigneeId ?? null,
  })
  await logActivity({
    userId: me.userId,
    action: 'CREATE',
    entityType: 'test_case',
    entityId: created.test_case_id,
    entityName: input.title,
    after: { title: input.title, moduleId: input.moduleId ?? null, priority: input.priority },
    meta,
  })
  return serializeTestCase(created)
}

export async function updateTestCaseFields(
  me: SessionUser,
  testCaseId: string,
  input: Partial<{
    moduleId?: string | null
    title?: string
    description?: string
    preconditions?: string
    expectedResult?: string
    priority?: string
    tags?: string[]
    assigneeId?: string | null
    expectedUpdatedAt?: string
  }>,
  meta: RequestMeta
): Promise<SerializedTestCase> {
  const tc = await findTestCaseById(testCaseId)
  if (!tc) throw ApiError.notFound('Test case not found')
  // Optimistic lock on what the CLIENT loaded (B2); the version guard below
  // additionally covers the read -> write window inside this request.
  const expected = resolveExpectedUpdatedAt(input.expectedUpdatedAt, tc.updated_at)
  if (expected.getTime() !== tc.updated_at.getTime()) throw ApiError.staleEdit()
  const isAuthor = tc.author_id === me.userId
  if (!ensureCanEdit(me, isAuthor)) throw ApiError.forbidden('You can only edit your own test cases')
  // Same fail-fast contract as create: unknown FK targets 404, never a 500.
  if (input.moduleId) {
    const mod = await findModuleById(input.moduleId)
    if (!mod) throw ApiError.notFound('Module not found')
  }
  if (input.assigneeId) {
    const assignee = await findUserById(input.assigneeId)
    if (!assignee) throw ApiError.notFound('Assignee not found')
  }

  // Snapshot the current version and apply the edit in ONE transaction with
  // optimistic locking:
  //   - the guarded UPDATE runs FIRST, so it takes the row's exclusive lock before
  //     the history insert takes the FK's shared lock: a parallel save waits, then
  //     loses the version race with a clean 409 (the reverse order deadlocked, 1213);
  //   - a crash between the two statements rolls back the whole edit (no orphan
  //     history row, no half-applied version bump — i.e. no corruption).
  const updated = await db.$transaction(async (tx) => {
    const fields: TestCaseUpdateFields = {
      version: tc.version + 1,
      lastEditedById: me.userId,
    }
    if (input.title !== undefined) fields.title = input.title
    if (input.description !== undefined) fields.description = input.description
    if (input.preconditions !== undefined) fields.preconditions = input.preconditions
    if (input.expectedResult !== undefined) fields.expectedResult = input.expectedResult
    if (input.priority !== undefined) fields.priority = input.priority
    if (input.tags !== undefined) fields.tags = input.tags
    if (input.moduleId !== undefined) fields.moduleId = input.moduleId ?? null
    if (input.assigneeId !== undefined) fields.assigneeId = input.assigneeId ?? null

    const applied = await updateTestCaseIfVersion(testCaseId, tc.version, fields, tx)
    if (!applied) throw ApiError.staleEdit()

    await insertTestCaseHistory(
      {
        testCaseId,
        version: tc.version,
        snapshot: {
          title: tc.title,
          description: tc.description,
          preconditions: tc.preconditions,
          expectedResult: tc.expected_result,
          priority: tc.priority,
          tags: parseJson<string[]>(tc.tags, []),
          moduleId: tc.module_id,
          assigneeId: tc.assignee_id,
        },
        changedById: me.userId,
        changeSummary: input.title ? `Updated: ${input.title}` : 'Field update',
      },
      tx
    )
    return findTestCaseById(testCaseId, tx)
  })
  if (!updated) throw new Error('Updated test case could not be read back')

  await logActivity({
    userId: me.userId,
    action: 'UPDATE',
    entityType: 'test_case',
    entityId: testCaseId,
    entityName: updated.title,
    before: serializeTestCase(tc) as unknown as Record<string, unknown>,
    after: serializeTestCase(updated) as unknown as Record<string, unknown>,
    meta,
  })

  if (input.assigneeId && input.assigneeId !== tc.assignee_id) {
    if (input.assigneeId !== me.userId) {
      await createNotification({
        userId: input.assigneeId,
        type: 'test_case_updated',
        title: 'Test case assigned to you',
        body: `${me.fullName} assigned "${updated.title}" to you for review.`,
        entityType: 'test_case',
        entityId: testCaseId,
      })
    }
  }
  return serializeTestCase(updated)
}

export async function submitTestCaseForReview(
  me: SessionUser,
  testCaseId: string,
  input: { reviewerId?: string | null; dueDate?: string | null },
  meta: RequestMeta
): Promise<SerializedReviewRequest> {
  const tc = await findTestCaseById(testCaseId)
  if (!tc) throw ApiError.notFound('Test case not found')
  ensurePermission(me, 'submit_review')

  // Resolve the reviewer: explicit choice -> assignee -> first active lead/admin.
  let reviewerId = input.reviewerId
  if (reviewerId) {
    const reviewer = await findUserById(reviewerId)
    if (!reviewer || !reviewer.is_active) throw ApiError.badRequest('Reviewer not found or inactive')
  } else if (tc.assignee_id) {
    reviewerId = tc.assignee_id
  } else {
    // Auto-pick: skip the submitter so a submitter never auto-reviews their own case.
    reviewerId = (await findFirstActiveReviewer(me.userId))?.user_id
  }
  if (!reviewerId) throw ApiError.badRequest('No reviewer available. Assign a reviewer first.')

  const cycle = (await findLatestCycleForTestCase(testCaseId)) + 1
  // Review request + status flip commit together: a crash can never leave a
  // pending review whose test case still reads "draft" (or vice versa).
  const review = await db.$transaction(async (tx) => {
    const created = await insertReviewRequest(
      {
        testCaseId,
        reviewerId,
        requesterId: me.userId,
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        cycle,
      },
      tx
    )
    await updateTestCaseStatus(testCaseId, 'in_review', tx)
    return created
  })

  await logActivity({
    userId: me.userId,
    action: 'REVIEW_SUBMITTED',
    entityType: 'test_case',
    entityId: testCaseId,
    entityName: tc.title,
    after: { reviewerId, cycle },
    meta,
  })
  if (reviewerId !== me.userId) {
    await createNotification({
      userId: reviewerId,
      type: 'review_assigned',
      title: 'New review assigned',
      body: `${me.fullName} submitted test case "${tc.title}" for your review (cycle ${cycle}).`,
      entityType: 'review',
      entityId: review.review_request_id,
    })
  }
  return serializeReviewRequest(review)
}

/** DELETE /api/test-cases?id=... — PERMANENT deletion.
 *  Removes the test_cases row itself; the schema's ON DELETE CASCADE keys
 *  take care of everything attached to it (history, review requests and
 *  their events, bug links). Nothing about the case survives except the
 *  immutable activity-log audit entries. */
export async function deleteTestCasePermanently(
  me: SessionUser,
  testCaseId: string,
  meta: RequestMeta
): Promise<{ success: true }> {
  const tc = await findTestCaseById(testCaseId)
  if (!tc) throw ApiError.notFound('Test case not found')

  // Role-based: author or any role holding delete-test-case rights.
  const isAuthor = tc.author_id === me.userId
  const canDelete = can(me.role, 'delete_test_case')
  if (!isAuthor && !canDelete) {
    throw ApiError.forbidden('Only the author of this test case or a role with delete rights can delete it.')
  }

  const removed = await hardDeleteTestCase(testCaseId)
  if (removed === 0) throw ApiError.notFound('Test case not found')

  await logActivity({
    userId: me.userId,
    action: 'DELETE',
    entityType: 'test_case',
    entityId: testCaseId,
    entityName: tc.title,
    before: { status: tc.status },
    after: { status: 'permanently_deleted' },
    meta,
  })
  return { success: true }
}

/**
 * DELETE /api/test-cases?action=bulk-delete  body: { ids: [...] }
 *
 * OWNER REQUEST (2026-10-09): delete several test cases at once — tick any
 * rows in the list (or select the whole page) and remove them completely.
 * Same rule per case as the single delete (author OR delete_test_case), one
 * atomic transaction, one summary activity entry, hard delete with cascade.
 */
export async function deleteTestCasesPermanently(
  me: SessionUser,
  ids: string[],
  meta: RequestMeta
): Promise<{ deleted: number; missing: string[] }> {
  const uniqueIds = [...new Set(ids.filter((id) => typeof id === 'string' && id.trim()))]
  if (uniqueIds.length === 0) {
    throw ApiError.badRequest('No test cases selected for deletion')
  }
  if (uniqueIds.length > 200) {
    throw ApiError.badRequest('Delete at most 200 test cases per batch')
  }

  const rows = await listTestCasesByIds(uniqueIds)
  const foundIds = new Set(rows.map((tc) => tc.test_case_id))
  const missing = uniqueIds.filter((id) => !foundIds.has(id))
  const canDeleteAny = can(me.role, 'delete_test_case')
  const deletable = canDeleteAny ? rows : rows.filter((tc) => tc.author_id === me.userId)
  if (deletable.length === 0) {
    throw ApiError.forbidden(
      canDeleteAny
        ? 'None of the selected test cases exist.'
        : 'Only the author of a test case or a role with delete rights can delete it.'
    )
  }

  const deleted = await db.$transaction(async (tx) => {
    let count = 0
    for (const tc of deletable) {
      count += await hardDeleteTestCase(tc.test_case_id, tx)
    }
    return count
  })

  await logActivity({
    userId: me.userId,
    action: 'DELETE',
    entityType: 'test_case',
    entityId: deletable[0].test_case_id,
    entityName: `${deleted} test case(s) bulk-deleted`,
    before: { count: deletable.length },
    after: {
      status: 'permanently_deleted',
      titles: deletable.slice(0, 10).map((tc) => tc.title),
      requestedCount: uniqueIds.length,
    },
    meta,
  })

  return { deleted, missing }
}

// Edit rule: matrix-driven — edit_any_test_case edits anything;
// edit_own_test_case edits one's own work. Both are runtime-togglable.
function ensureCanEdit(me: SessionUser, isAuthor: boolean): boolean {
  const canEditAny = can(me.role, 'edit_any_test_case')
  const canEditOwn = can(me.role, 'edit_own_test_case')
  return canEditAny || (isAuthor && canEditOwn)
}

// ---------- CSV import ----------

const IMPORT_TEMPLATE_FILE_NAME = 'tcms-test-case-import-template.csv'

/** The downloadable sample file: `#` instruction lines + a header row using
 *  the website's own field names + three example rows. Steps are no longer
 *  part of the template — title + description are the required core. */
const IMPORT_TEMPLATE_CSV = [
  '# TCMS - Test Case Import Template',
  '# How to use this file:',
  '#   1. Keep the header row exactly as it is (column ORDER does not matter, column NAMES do).',
  '#   2. Write ONE test case per row. "title" and "description" are required - every other column is optional.',
  '#   3. The target module is chosen in the app before you upload (one file imports into ONE module).',
  '#   4. tags: separate multiple tags with ;   Example: smoke;login;critical',
  '#   5. priority must be one of: P0, P1, P2, P3 (leave empty for P2).',
  '#   6. Lines starting with # are instructions and are ignored during import - you may delete or keep them.',
  'title,description,priority,expected_result,tags',
  'Verify login with valid credentials,Check that a registered user can sign in and lands on the dashboard,P1,User lands on the dashboard,smoke;login',
  'Verify login blocks wrong password,Negative check that an invalid password is rejected with an inline error,P2,Error message is shown and the user stays on the login page,negative;login',
  'Verify logout,Check that signing out clears the session and returns to the sign-in screen,P3,User is returned to the sign-in screen,smoke',
].join('\n')

/** Header aliases -> canonical field name. Header ORDER in the file is
 *  irrelevant — rows are mapped by resolved column index, not position.
 *  NOTE: steps were removed from the product; a `steps` column in an old
 *  CSV is deliberately IGNORED (not an error) so legacy files still import. */
const IMPORT_HEADER_ALIASES: Record<string, 'title' | 'description' | 'preconditions' | 'priority' | 'expectedResult' | 'tags'> = {
  title: 'title',
  description: 'description',
  preconditions: 'preconditions',
  priority: 'priority',
  expectedresult: 'expectedResult',
  expected_result: 'expectedResult',
  expected: 'expectedResult',
  tags: 'tags',
}

/** Download payload for the Import tab's "Download sample CSV" button. */
export async function getTestCasesImportTemplate(me: SessionUser): Promise<ImportTemplate> {
  ensurePermission(me, 'create_test_case')
  return { fileName: IMPORT_TEMPLATE_FILE_NAME, csv: IMPORT_TEMPLATE_CSV }
}

interface ImportTestCaseInput {
  moduleId: string
  title: string
  description?: string
  preconditions?: string
  expectedResult?: string
  priority: string
  tags: string[]
}

/** Maps the header row to canonical column indexes. Throws when required
 *  columns are missing so the user fixes the file instead of the results. */
function resolveImportColumns(header: string[]): Record<string, number> {
  const columns: Partial<Record<string, number>> = {}
  header.forEach((cell, idx) => {
    const field = IMPORT_HEADER_ALIASES[cell.trim().toLowerCase()]
    if (field && columns[field] === undefined) columns[field] = idx
  })
  if (columns.title === undefined) {
    throw ApiError.badRequest('The CSV file needs a "title" column in its header row')
  }
  return columns as Record<string, number>
}

/** Validates one CSV row and converts it into createTestCase input.
 *  Pure function: returns either the input or a user-facing row error.
 *  title + description are required. */
function mapCsvRowToInput(
  cells: string[],
  columns: Record<string, number>,
): { ok: true; input: ImportTestCaseInput } | { ok: false; error: string } {
  const get = (field: string) => {
    const idx = columns[field]
    return idx === undefined ? '' : (cells[idx] ?? '').trim()
  }

  const title = get('title')
  if (!title) return { ok: false, error: 'title is required' }

  const description = get('description')
  if (!description) return { ok: false, error: 'description is required' }

  const priority = get('priority').toUpperCase() || 'P2'
  if (!['P0', 'P1', 'P2', 'P3'].includes(priority)) {
    return { ok: false, error: `priority must be one of P0, P1, P2, P3 (got "${get('priority')}")` }
  }

  return {
    ok: true,
    input: {
      moduleId: '',
      title,
      description: get('description') || undefined,
      preconditions: get('preconditions') || undefined,
      expectedResult: get('expectedResult') || undefined,
      priority,
      tags: parseCsvTags(get('tags')),
    },
  }
}

/** Imports a whole CSV document as draft test cases inside ONE target module
 *  or submodule. Every row reuses createTestCase, so permissions, raw-SQL
 *  inserts, activity logging and serialization stay in exactly one place
 *  (DRY). Rows are independent: a bad row never blocks the good ones — the
 *  summary reports both. */
export async function importTestCasesFromCsv(
  me: SessionUser,
  input: { moduleId: string; fileName: string; csv: string },
  meta: RequestMeta,
): Promise<ImportTestCasesResult> {
  ensurePermission(me, 'create_test_case')

  const targetModule = await findModuleById(input.moduleId)
  if (!targetModule) throw ApiError.notFound('Target module or submodule not found')

  const matrix: CsvMatrix = parseCsvDocument(input.csv)
  if (matrix.length < 2) {
    throw ApiError.badRequest('No data rows found — keep the header row and add at least one test case below it')
  }
  if (matrix.length - 1 > MAX_IMPORT_ROWS) {
    throw ApiError.badRequest(`Too many rows (${matrix.length - 1}) — import at most ${MAX_IMPORT_ROWS} test cases per file`)
  }

  const columns = resolveImportColumns(matrix[0])
  const results: ImportRowResult[] = []

  for (let i = 1; i < matrix.length; i++) {
    const rowNumber = i // 1-based data-row number as seen by the user
    const rowTitle = matrix[i][columns.title]?.trim() || '(untitled)'
    const mapped = mapCsvRowToInput(matrix[i], columns)
    if (!mapped.ok) {
      results.push({ row: rowNumber, title: rowTitle, status: 'failed', error: mapped.error })
      continue
    }
    try {
      const created = await createTestCase(
        me,
        { ...mapped.input, moduleId: input.moduleId },
        meta,
      )
      results.push({ row: rowNumber, title: created.title, status: 'created', testCaseId: created.testCaseId })
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Could not create this test case'
      results.push({ row: rowNumber, title: rowTitle, status: 'failed', error: message })
    }
  }

  const imported = results.filter((r) => r.status === 'created').length
  // Audit-relevant operation: log every CSV import (who, where, how many).
  logger.info('CSV import finished', {
    moduleId: targetModule.module_id,
    moduleName: targetModule.name,
    totalRows: results.length,
    imported,
    failed: results.length - imported,
    by: me.userId,
  })
  return {
    moduleId: targetModule.module_id,
    moduleName: targetModule.name,
    totalRows: results.length,
    imported,
    failed: results.length - imported,
    results,
  }
}
