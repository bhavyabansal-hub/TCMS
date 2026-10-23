// Modules service — business logic and orchestration for the module resource.
//
// Owns: the creator-is-owner rule, materialised path/depth computation,
// tree building from flat rows, delete rights (creator or senior), the
// module-level review submission flow (per-module cycles, reviewer
// auto-resolution, case-review fan-out, status updates), activity logging
// and reviewer notifications. Data access goes exclusively through the
// repositories; responses are produced exclusively through the serializers.

import type { RequestMeta } from '@/lib/activity'
import { ApiError } from '@/lib/api'
import { db } from '@/lib/db'
import { can, ensurePermission, type SessionUser } from '@/lib/auth'
import { logActivity } from '@/lib/activity'
import { createNotification } from '@/lib/notifications'
import {
  serializeModule,
  serializeModuleWithJoins,
  serializeModuleReviewRequest,
  serializeTestCase,
  type SerializedModule,
  type SerializedModuleReviewRequest,
  type SerializedTestCase,
} from '@/lib/serializers'
import { findFirstActiveReviewer, findUserById } from '@/lib/server/user.repository'
import { resolveExpectedUpdatedAt } from '@/lib/server/optimistic-lock'
import { REFERENCE_CACHE_PREFIX, REFERENCE_CACHE_TTL_MS, withCache } from '@/lib/server/cache'
import {
  deleteModule,
  findModuleById,
  insertModule,
  listDescendantModuleIds,
  lockModule,
  listModulesWithOwnerAndCaseCount,
  listSubmodules,
  updateModuleIfUnchanged,
  type ModuleUpdateFields,
} from './modules.repository'
import {
  countTestCasesInModules,
  listTestCases,
  listTestCasesInModuleTree,
  listTestCasesInModules,
  lockCaseIdsInModules,
  resetCasesReviewedInModules,
  updateTestCaseStatusMany,
} from '../test-cases/test-cases.repository'
import { closeOpenReviewsForTestCases, insertReviewRequestsForModuleReview } from '../reviews/reviews.repository'
import {
  completeModuleReviewsWithNothingOpen,
  findLatestModuleReviewCycle,
  insertModuleReviewRequest,
  listModuleReviewIdsForModules,
  listOpenModuleReviewIdsForCases,
  lockCaseReviewsOfCases,
  lockCaseReviewsOfModuleReviews,
  lockModuleReviews,
} from '../module-reviews/module-reviews.repository'

// Test cases eligible for a module review submission — already-approved cases
// are skipped (legacy rule).
const ELIGIBLE_REVIEW_STATUSES = ['draft', 'needs_revision']

// Module detail page size for BOTH test-case lists (direct + subtree). Keeps
// the Crew Desk landing page fast when a module holds hundreds of cases —
// the UI pages through with "Load more" instead of one giant payload.
export const MODULE_DETAIL_PAGE_SIZE = 100


/** `flat` = every module once, WITHOUT children (the client builds the tree from it,
 *  src/lib/client/api.ts modulesApi.tree). `tree` stays in the response for backward
 *  compatibility: browser tabs still running the previous client read `tree` directly
 *  (owner bug 2026-10-17: removing it crashed /modules). Remove it only after a release
 *  in which no client reads it (backlog B30). */
export type ModuleTreeNode = SerializedModule & { children: ModuleTreeNode[] }

export interface ModuleTreeResponse {
  /** @deprecated read `flat`; kept so open tabs on the previous client keep working. */
  tree: ModuleTreeNode[]
  flat: SerializedModule[]
}

export interface ModuleDetailCasePage {
  limit: number
  offset: number
  /** Test cases anywhere in the module tree (this module + descendants). */
  total: number
  /** Test cases sitting DIRECTLY on this module (not its submodules). */
  directTotal: number
  hasMore: boolean
}

export interface ModuleDetail {
  module: SerializedModule
  /** Direct test cases of this module (first page, legacy shape kept for
   *  the modules view master-detail panel). */
  testCases: SerializedTestCase[]
  /** Test cases from the WHOLE module tree (this module + all descendants),
   *  newest first, paged — what a Crew Desk reader expects on this page. */
  subtreeTestCases: SerializedTestCase[]
  submodules: SerializedModule[]
  casePage: ModuleDetailCasePage
}

export interface SubmitModuleReviewResult {
  moduleReview: SerializedModuleReviewRequest
  caseReviewCount: number
  testCaseIds: string[]
}

// ---------- Queries ----------

/** Flat module list (with owner + test-case counts) plus the nested tree
 *  built from parentId. flat entries and tree nodes share the same objects,
 *  exactly like legacy. */
export async function listModuleTree(): Promise<ModuleTreeResponse> {
  // Cache-aside: every page with a module picker reads this; logActivity clears it.
  const rows = await withCache(`${REFERENCE_CACHE_PREFIX}module-tree`, REFERENCE_CACHE_TTL_MS, listModulesWithOwnerAndCaseCount)
  const flat = rows.map((row) => serializeModuleWithJoins(row))
  // Compatibility tree: separate node objects, so `flat` never repeats the children.
  const nodes: ModuleTreeNode[] = flat.map((module) => ({ ...module, children: [] }))
  const byId = new Map(nodes.map((node) => [node.moduleId, node]))
  const tree: ModuleTreeNode[] = []
  for (const node of nodes) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined
    if (parent) parent.children.push(node)
    else tree.push(node)
  }
  return { tree, flat }
}

/** Module detail: module with user refs, its test cases, its direct
 *  submodules, and the AGGREGATED test cases of the whole module tree.
 *  A parent module itself often holds zero direct cases (they live in its
 *  submodules), so the Crew Desk landing page needs the subtree view.
 *  Access is role-based only — no per-module permission lists. */
export async function getModuleDetail(
  moduleId: string,
  opts?: { caseOffset?: number }
): Promise<ModuleDetail> {
  const mod = await findModuleById(moduleId)
  if (!mod) throw ApiError.notFound('Module not found')
  const limit = MODULE_DETAIL_PAGE_SIZE
  const offset = Math.max(0, Math.floor(opts?.caseOffset ?? 0) || 0)
  const [descendantIds, submoduleRows] = await Promise.all([
    listDescendantModuleIds(moduleId),
    listSubmodules(moduleId),
  ])
  const treeIds = [moduleId, ...descendantIds]
  const [counts, directRows, subtreeRows] = await Promise.all([
    countTestCasesInModules(treeIds, moduleId),
    listTestCases({ moduleId }, limit, offset),
    listTestCasesInModuleTree(treeIds, limit, offset),
  ])
  return {
    module: serializeModuleWithJoins(mod),
    testCases: directRows.map(serializeTestCase),
    subtreeTestCases: subtreeRows.map(serializeTestCase),
    submodules: submoduleRows.map(serializeModuleWithJoins),
    casePage: {
      limit,
      offset,
      total: counts.total,
      directTotal: counts.direct,
      hasMore: offset + subtreeRows.length < counts.total,
    },
  }
}

// ---------- Commands ----------

export async function createModule(
  me: SessionUser,
  input: { name: string; description?: string; parentId?: string | null },
  meta: RequestMeta
): Promise<SerializedModule> {
  ensurePermission(me, 'create_module')

  // Materialised path/depth (legacy formula): root modules get an empty path,
  // children append the parent's id to the parent's path.
  let path = ''
  let depth = 0
  if (input.parentId) {
    const parent = await findModuleById(input.parentId)
    if (!parent) throw ApiError.notFound('Parent module not found')
    path = `${parent.path}.${input.parentId}`
    depth = parent.depth + 1
  }

  // The creator IS the owner — no manual override allowed.
  const moduleId = await insertModule({
    name: input.name,
    description: input.description ?? null,
    parentId: input.parentId ?? null,
    path,
    depth,
    ownerId: me.userId,
    createdById: me.userId,
    updatedById: me.userId,
  })
  const created = await findModuleById(moduleId)
  if (!created) throw new Error('Inserted module could not be read back')

  await logActivity({
    userId: me.userId,
    action: 'CREATE',
    entityType: 'module',
    entityId: created.module_id,
    entityName: input.name,
    after: { name: input.name, parentId: input.parentId ?? null, ownerId: me.userId },
    meta,
  })
  return serializeModuleWithJoins(created)
}

export async function updateModuleFields(
  me: SessionUser,
  moduleId: string,
  input: { name?: string; description?: string; ownerId?: string; expectedUpdatedAt?: string },
  meta: RequestMeta
): Promise<SerializedModule> {
  ensurePermission(me, 'edit_module')
  const before = await findModuleById(moduleId)
  if (!before) throw ApiError.notFound('Module not found')

  // Only fields present in the body change; updatedById is always bumped.
  // ownerId may be reassigned (e.g. ownership transfer), but the *creator*
  // (created_by_id) is immutable and governs delete rights.
  const fields: ModuleUpdateFields = { updatedById: me.userId }
  if (input.name !== undefined) fields.name = input.name
  if (input.description !== undefined) fields.description = input.description
  // AUDIT FIX (2026-10-09): validate the new owner exists — an arbitrary id
  // used to sail through to the FK and surface as an ugly 500.
  if (input.ownerId !== undefined) {
    const owner = await findUserById(input.ownerId)
    if (!owner || !owner.is_active) throw ApiError.badRequest('New owner must be an existing active user')
    fields.ownerId = input.ownerId
  }

  const expected = resolveExpectedUpdatedAt(input.expectedUpdatedAt, before.updated_at)
  const updated = await updateModuleIfUnchanged(moduleId, fields, expected)
  if (!updated) throw ApiError.staleEdit()
  await logActivity({
    userId: me.userId,
    action: 'UPDATE',
    entityType: 'module',
    entityId: moduleId,
    entityName: before.name,
    before: { name: before.name, description: before.description, ownerId: before.owner_id },
    after: { name: updated.name, description: updated.description, ownerId: updated.owner_id },
    meta,
  })
  return serializeModule(updated)
}

export async function submitModuleForReview(
  me: SessionUser,
  moduleId: string,
  input: { reviewerId?: string; dueDate?: string; includeSubmodules: boolean },
  meta: RequestMeta
): Promise<SubmitModuleReviewResult> {
  ensurePermission(me, 'submit_review')
  const mod = await findModuleById(moduleId)
  if (!mod) throw ApiError.notFound('Module not found')

  // Resolve the reviewer: explicit choice -> first active VP/Manager
  // (excluding the submitter so a submitter never auto-reviews their own module).
  let reviewerId = input.reviewerId
  if (!reviewerId) reviewerId = (await findFirstActiveReviewer(me.userId))?.user_id
  if (!reviewerId) throw ApiError.badRequest('No reviewer available. Assign a VP or Manager.')

  // Target modules: this one plus all descendants when requested.
  const targetModuleIds = input.includeSubmodules
    ? [moduleId, ...(await listDescendantModuleIds(moduleId))]
    : [moduleId]

  const testCases = await listTestCasesInModules(targetModuleIds, ELIGIBLE_REVIEW_STATUSES)
  if (testCases.length === 0) {
    throw ApiError.badRequest('No eligible test cases (draft or needs_revision) found in this module.')
  }
  const dueDate = input.dueDate ? new Date(input.dueDate) : null

  // ATOMIC (chaos test 2026-10-22): the module row and every eligible case row are
  // locked and re-read first, so a parallel submit, single-case submit or module
  // delete either waits or wins cleanly — never two open reviews for one case and
  // never a case left "in_review" without a review.
  const { moduleReview, caseIds, cycle } = await db.$transaction(async (tx) => {
    if (!(await lockModule(moduleId, tx))) throw ApiError.notFound('Module not found')
    // Lock order: module -> module reviews -> case reviews -> cases (see lockModuleReviews).
    const candidateIds = testCases.map((tc) => tc.test_case_id)
    await lockModuleReviews(await listOpenModuleReviewIdsForCases(candidateIds, tx), tx)
    await lockCaseReviewsOfCases(candidateIds, tx)
    const caseIds = await lockCaseIdsInModules(targetModuleIds, ELIGIBLE_REVIEW_STATUSES, tx)
    if (caseIds.length === 0) {
      throw ApiError.badRequest('No eligible test cases (draft or needs_revision) found in this module.')
    }
    // The cycle number belongs to the MODULE (not to each test case).
    const cycle = (await findLatestModuleReviewCycle(moduleId, tx)) + 1
    const moduleReview = await insertModuleReviewRequest({ moduleId, reviewerId, requesterId: me.userId, dueDate, cycle }, tx)

    // A resubmit supersedes each case's old open review cycle (R2-1); an older
    // module review left with nothing to review is completed.
    const supersededModuleReviews = await listOpenModuleReviewIdsForCases(caseIds, tx)
    await lockModuleReviews(supersededModuleReviews, tx) // no-op for the ones locked above
    await closeOpenReviewsForTestCases(caseIds, tx)
    await completeModuleReviewsWithNothingOpen(supersededModuleReviews, tx)

    // One case review per eligible test case, linked to the module review.
    await insertReviewRequestsForModuleReview(
      caseIds.map((testCaseId) => ({
        testCaseId,
        reviewerId,
        requesterId: me.userId,
        dueDate,
        cycle,
        moduleReviewId: moduleReview.module_review_request_id,
      })),
      tx
    )

    // Move all submitted test cases into "in_review" — one statement for the module.
    await updateTestCaseStatusMany(caseIds, 'in_review', tx)
    return { moduleReview, caseIds, cycle }
  })

  await logActivity({
    userId: me.userId,
    action: 'REVIEW_SUBMITTED',
    entityType: 'module',
    entityId: moduleId,
    entityName: mod.name,
    after: { reviewerId, cycle, caseCount: caseIds.length, includeSubmodules: input.includeSubmodules },
    meta,
  })

  if (reviewerId !== me.userId) {
    await createNotification({
      userId: reviewerId,
      type: 'review_assigned',
      title: 'New module review assigned',
      body: `${me.fullName} submitted module "${mod.name}" with ${caseIds.length} test case(s) for your review (cycle ${cycle}).`,
      entityType: 'module_review',
      entityId: moduleReview.module_review_request_id,
    })
  }

  return {
    moduleReview: serializeModuleReviewRequest(moduleReview),
    caseReviewCount: caseIds.length,
    testCaseIds: caseIds,
  }
}

export async function deleteModuleById(
  me: SessionUser,
  moduleId: string,
  meta: RequestMeta
): Promise<{ success: true }> {
  const before = await findModuleById(moduleId)
  if (!before) throw ApiError.notFound('Module not found')

  // Role-based only: delete needs edit-module rights, or be the creator.
  if (!canDeleteModule(me.userId === before.created_by_id, can(me.role, 'edit_module'))) {
    throw ApiError.forbidden('Only the creator of this module or a role with edit-module rights can delete it.')
  }

  // The module's reviews cascade away with it: in the same transaction, cases still
  // "in_review" through them go back to "draft" (chaos test 2026-10-22).
  const resetCount = await db.$transaction(async (tx) => {
    if (!(await lockModule(moduleId, tx))) throw ApiError.notFound('Module not found')
    const treeIds = [moduleId, ...(await listDescendantModuleIds(moduleId, tx))]
    // Lock order: module -> module reviews -> case reviews -> cases (see lockModuleReviews).
    const treeModuleReviews = await listModuleReviewIdsForModules(treeIds, tx)
    await lockModuleReviews(treeModuleReviews, tx)
    await lockCaseReviewsOfModuleReviews(treeModuleReviews, tx)
    const reset = await resetCasesReviewedInModules(treeIds, tx)
    await deleteModule(moduleId, tx)
    return reset
  })
  await logActivity({
    userId: me.userId,
    action: 'DELETE',
    entityType: 'module',
    entityId: moduleId,
    entityName: before.name,
    before: { name: before.name, parentId: before.parent_id },
    after: resetCount > 0 ? { casesBackToDraft: resetCount } : undefined,
    meta,
  })
  return { success: true }
}

// Returns true if the user may delete a module: holds edit-module rights
// (role-based, togglable) or created the module.
function canDeleteModule(isCreator: boolean, hasEditModule: boolean): boolean {
  return hasEditModule || isCreator
}
