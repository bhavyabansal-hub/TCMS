// Bug service — business logic and orchestration.
//
// Owns: bug permissions (create via the permission matrix, reassignment
// restricted to team_lead/admin, hard delete admin-only), the resolved/closed
// resolved_at rule, bug <-> test-case link management, activity logging and
// assignee notifications. Data access goes exclusively through repositories;
// responses are produced exclusively through the serializers.

import type { RequestMeta } from '@/lib/activity'
import { ApiError, getPagination, paginate, type PaginatedResponse } from '@/lib/api'
import { canAny, ensurePermission, type SessionUser } from '@/lib/auth'
import { logActivity } from '@/lib/activity'
import { createNotification } from '@/lib/notifications'
import { logger } from '@/lib/logger'
import { serializeBug, type SerializedBug } from '@/lib/serializers'
import { listTestCasesByIds, findTestCaseById } from '../test-cases/test-cases.repository'
import { findModuleById } from '../modules/modules.repository'
import { findUserById } from '@/lib/server/user.repository'
import { resolveExpectedUpdatedAt } from '@/lib/server/optimistic-lock'
import {
  countBugs,
  deleteBugById,
  deleteBugTestCaseLinks,
  findBugById,
  insertBug,
  insertBugTestCaseLinks,
  listBugTestCaseLinks,
  listBugOptionRows,
  listBugs,
  updateBugIfUnchanged,
  type BugFilters,
  type BugUpdateFields,
} from './bugs.repository'
import type { CreateBugInput, UpdateBugInput } from './bugs.validation'

// ---------- Shapes ----------

/** Reduced test-case ref attached to bug links (legacy links shape:
 *  { id, title, status, priority } — ids now carry the entity name). */
export interface BugLinkTestCaseRef {
  testCaseId: string
  title: string
  status: string
  priority: string
}

export interface BugTestCaseLinkView {
  bugId: string
  testCaseId: string
  createdAt: Date
  testCase: BugLinkTestCaseRef | null
}

/** Single-bug payload: the serialized bug plus its test-case links
 *  (the legacy single-bug response embedded testCaseLinks). */
export type BugWithLinks = SerializedBug & { testCaseLinks: BugTestCaseLinkView[] }

// ---------- Queries ----------

/** Light picker list (id + title) — e.g. linking a work-log line to a bug. */
export async function listBugOptions(input: { limit: number }): Promise<{ bugId: string; title: string }[]> {
  const rows = await listBugOptionRows(input.limit)
  return rows.map((r) => ({ bugId: r.bug_id, title: r.title }))
}

export async function listBugsPaginated(
  q: Record<string, string>
): Promise<PaginatedResponse<SerializedBug>> {
  const filters: BugFilters = {
    status: q.status,
    severity: q.severity,
    moduleId: q.moduleId,
    assignedToId: q.assignedToId,
    reportedById: q.reportedById,
    search: q.search,
  }
  // Legacy bugs list defaulted to pageSize 100.
  const { page, pageSize, offset } = getPagination(q, 100)
  const [total, rows] = await Promise.all([countBugs(filters), listBugs(filters, pageSize, offset)])
  return paginate(rows.map(serializeBug), total, page, pageSize)
}

export async function getBug(bugId: string): Promise<BugWithLinks> {
  const bug = await findBugById(bugId)
  if (!bug) throw ApiError.notFound('Bug not found')
  return { ...serializeBug(bug), testCaseLinks: await buildLinkViews(bugId) }
}

/** GET ?id=...&action=links — legacy did NOT 404 on unknown bugs here (an
 *  unknown bug simply has no links), so no existence check. */
export async function getBugTestCaseLinks(bugId: string): Promise<BugTestCaseLinkView[]> {
  return buildLinkViews(bugId)
}

// ---------- Commands ----------

export async function createBug(
  me: SessionUser,
  input: CreateBugInput,
  meta: RequestMeta
): Promise<SerializedBug> {
  ensurePermission(me, 'create_bug')
  // Fail fast with a clean 404: unknown module/assignee must never surface as
  // a raw FK 500 (same contract as module create for parentId).
  if (input.moduleId) {
    const mod = await findModuleById(input.moduleId)
    if (!mod) throw ApiError.notFound('Module not found')
  }
  if (input.assignedToId) {
    // Choosing an assignee is an assignment: same right as a reassign (deep-test R2-2).
    ensurePermission(me, 'assign_bug', 'Only roles with assign-bug rights (VP / Manager) can assign bugs')
    const assignee = await findUserById(input.assignedToId)
    if (!assignee) throw ApiError.notFound('Assignee not found')
  }
  // Validate linked test-case ids up front so a bad id fails fast (400)
  // instead of half-applying the creation like the legacy FK error did.
  const testCaseIds = await ensureTestCasesExist(input.testCaseIds)

  const created = await insertBug({
    title: input.title,
    description: input.description ?? null,
    severity: input.severity,
    environment: input.environment ?? null,
    stepsToReproduce: input.stepsToReproduce ?? null,
    expectedBehaviour: input.expectedBehaviour ?? null,
    actualBehaviour: input.actualBehaviour ?? null,
    moduleId: input.moduleId ?? null,
    assignedToId: input.assignedToId ?? null,
    reportedById: me.userId,
  })
  await insertBugTestCaseLinks(created.bug_id, testCaseIds)

  logger.info('Bug created', { bugId: created.bug_id, title: created.title, severity: created.severity })
  await logActivity({
    userId: me.userId,
    action: 'CREATE',
    entityType: 'bug',
    entityId: created.bug_id,
    entityName: created.title,
    after: { title: created.title, severity: created.severity, assignedToId: created.assigned_to_id },
    meta,
  })
  if (created.assigned_to_id && created.assigned_to_id !== me.userId) {
    await createNotification({
      userId: created.assigned_to_id,
      type: 'bug_assigned',
      title: 'Bug assigned to you',
      body: `${me.fullName} assigned "${created.title}" (${created.severity}) to you.`,
      entityType: 'bug',
      entityId: created.bug_id,
    })
  }
  return serializeBug(created)
}

export async function updateBugFields(
  me: SessionUser,
  bugId: string,
  input: UpdateBugInput,
  meta: RequestMeta
): Promise<SerializedBug> {
  const before = await findBugById(bugId)
  if (!before) throw ApiError.notFound('Bug not found')

  // Matrix rule — bug triage (status/severity/field edits) belongs to bug
  // participants: create_bug OR assign_bug holders. A role granted NEITHER
  // (e.g. viewer) reads bugs but can never change them. Reassignment stays
  // strictly assign_bug-gated below — one feature's toggle never leaks.
  if (!canAny(me.role, ['create_bug', 'assign_bug'])) {
    throw ApiError.forbidden('Only roles with bug rights (create / assign) can edit bugs')
  }
  // assign_bug is needed only when the assignee really changes (deep-test T1-2):
  // resending the current assignee (or null for an unassigned bug) is a no-op.
  const isReassign = input.assignedToId !== undefined && (input.assignedToId ?? null) !== before.assigned_to_id
  if (isReassign) {
    ensurePermission(me, 'assign_bug', 'Only roles with assign-bug rights (VP / Manager) can reassign bugs')
    // Fail fast: unknown assignee 404s instead of a raw FK 500 mid-update.
    if (input.assignedToId) {
      const assignee = await findUserById(input.assignedToId)
      if (!assignee) throw ApiError.notFound('Assignee not found')
    }
  }
  if (input.moduleId) {
    const mod = await findModuleById(input.moduleId)
    if (!mod) throw ApiError.notFound('Module not found')
  }

  const fields: BugUpdateFields = {}
  if (input.title !== undefined) fields.title = input.title
  if (input.description !== undefined) fields.description = input.description
  if (input.severity !== undefined) fields.severity = input.severity
  if (input.status !== undefined) fields.status = input.status
  if (input.environment !== undefined) fields.environment = input.environment
  if (input.stepsToReproduce !== undefined) fields.stepsToReproduce = input.stepsToReproduce
  if (input.expectedBehaviour !== undefined) fields.expectedBehaviour = input.expectedBehaviour
  if (input.actualBehaviour !== undefined) fields.actualBehaviour = input.actualBehaviour
  if (input.moduleId !== undefined) fields.moduleId = input.moduleId ?? null
  if (isReassign) fields.assignedToId = input.assignedToId ?? null
  // Legacy rule, preserved exactly: whenever the update sets the status to
  // resolved/closed, resolved_at is stamped with now (any body value loses).
  if (input.status === 'resolved' || input.status === 'closed') {
    fields.resolvedAt = new Date()
  } else if (input.resolvedAt !== undefined) {
    fields.resolvedAt = input.resolvedAt === null ? null : new Date(input.resolvedAt)
  }

  const expected = resolveExpectedUpdatedAt(input.expectedUpdatedAt, before.updated_at)
  const updated = await updateBugIfUnchanged(bugId, fields, expected)
  if (!updated) throw ApiError.staleEdit()

  // testCaseIds in the body REPLACE the bug's links (delete + insert).
  if (input.testCaseIds !== undefined) {
    await replaceBugTestCaseLinks(bugId, input.testCaseIds)
  }

  logger.info('Bug updated', { bugId, status: updated.status, by: me.userId })
  await logActivity({
    userId: me.userId,
    action: 'UPDATE',
    entityType: 'bug',
    entityId: bugId,
    entityName: updated.title,
    before: serializeBug(before) as unknown as Record<string, unknown>,
    after: serializeBug(updated) as unknown as Record<string, unknown>,
    meta,
  })
  if (input.assignedToId && input.assignedToId !== before.assigned_to_id) {
    if (input.assignedToId !== me.userId) {
      await createNotification({
        userId: input.assignedToId,
        type: 'bug_assigned',
        title: 'Bug assigned to you',
        body: `${me.fullName} assigned "${updated.title}" to you.`,
        entityType: 'bug',
        entityId: bugId,
      })
    }
  }
  return serializeBug(updated)
}

export async function linkTestCaseToBug(
  me: SessionUser,
  bugId: string,
  input: { testCaseId: string }
): Promise<{ success: true }> {
  // AUDIT FIX (2026-10-09, finding H1): this mutation used to run with NO
  // permission check — even a viewer could attach test cases to any bug.
  // Linking is an authoring action, so it now requires the same rights as
  // editing a bug: create_bug OR assign_bug.
  if (!canAny(me.role, ['create_bug', 'assign_bug'])) {
    throw ApiError.forbidden('Only roles with bug-authoring rights can link test cases')
  }
  // Unknown ids are now an explicit 404 (was: legacy silent success that
  // made broken client calls invisible). The insert itself stays idempotent.
  const bug = await findBugById(bugId)
  if (!bug) throw ApiError.notFound('Bug not found')
  const testCase = await findTestCaseById(input.testCaseId)
  if (!testCase) throw ApiError.notFound('Test case not found')
  await insertBugTestCaseLinks(bugId, [input.testCaseId])
  return { success: true }
}

export async function deleteBug(
  me: SessionUser,
  bugId: string | undefined,
  meta: RequestMeta
): Promise<{ success: true }> {
  // Check order preserved from legacy: the permission gate fires BEFORE the id check.
  ensurePermission(me, 'delete_bug', 'Only roles with delete-bug rights (VP / Manager) can delete bugs')
  if (!bugId) throw ApiError.badRequest('Missing bug id')

  const before = await findBugById(bugId)
  if (!before) throw ApiError.notFound('Bug not found')

  // HARD delete — the only one in the app; links cascade in the database.
  await deleteBugById(bugId)
  logger.info('Bug hard-deleted', { bugId, title: before.title, by: me.userId })
  await logActivity({
    userId: me.userId,
    action: 'DELETE',
    entityType: 'bug',
    entityId: bugId,
    entityName: before.title,
    meta,
  })
  return { success: true }
}

// ---------- Helpers ----------

/** Fetch the bug's link rows and enrich each with the reduced test-case ref.
 *  Cross-resource reads go through the test-cases repository — this file
 *  never touches test_cases with its own SQL. */
async function buildLinkViews(bugId: string): Promise<BugTestCaseLinkView[]> {
  const links = await listBugTestCaseLinks(bugId)
  const testCases = await listTestCasesByIds(links.map((link) => link.test_case_id))
  const byId = new Map(testCases.map((tc) => [tc.test_case_id, tc]))
  return links.map((link) => {
    const tc = byId.get(link.test_case_id)
    return {
      bugId: link.bug_id,
      testCaseId: link.test_case_id,
      createdAt: link.created_at,
      testCase: tc
        ? { testCaseId: tc.test_case_id, title: tc.title, status: tc.status, priority: tc.priority }
        : null,
    }
  })
}

/** Validates that every id refers to an existing test case; returns deduped ids. */
async function ensureTestCasesExist(testCaseIds: string[] | undefined): Promise<string[]> {
  const uniqueIds = Array.from(new Set(testCaseIds ?? []))
  if (!uniqueIds.length) return []
  const found = await listTestCasesByIds(uniqueIds)
  if (found.length === uniqueIds.length) return uniqueIds
  const foundIds = new Set(found.map((tc) => tc.test_case_id))
  throw ApiError.badRequest('One or more test case ids do not exist', {
    missing: uniqueIds.filter((id) => !foundIds.has(id)),
  })
}

/** REPLACE semantics for PUT testCaseIds: wipe the bug's links, insert the new set. */
async function replaceBugTestCaseLinks(bugId: string, testCaseIds: string[]): Promise<void> {
  const uniqueIds = await ensureTestCasesExist(testCaseIds)
  await deleteBugTestCaseLinks(bugId)
  await insertBugTestCaseLinks(bugId, uniqueIds)
}
