// Module-reviews service — business logic and orchestration.
//
// Owns: the module-review read paths (single review with nested case reviews,
// the reviewer's queue, the admin list) and the bulk-approve verdict flow
// (one approved ReviewEvent per open case review, case-review completion,
// test-case status flip, module-review completion, activity log, requester
// notification). Data access goes exclusively through the repositories;
// responses are produced exclusively through the serializers.

import type { RequestMeta } from '@/lib/activity'
import { ApiError } from '@/lib/api'
import { resolveExpectedUpdatedAt } from '@/lib/server/optimistic-lock'
import { can, ensurePermission, type SessionUser } from '@/lib/auth'
import { logActivity } from '@/lib/activity'
import { createNotification, type NotificationType } from '@/lib/notifications'
import { logger } from '@/lib/logger'
import { db } from '@/lib/db'
import { findUserById } from '@/lib/server/user.repository'
import {
  serializeModuleReviewRequest,
  type SerializedModuleReviewRequest,
} from '@/lib/serializers'
import type { ReviewEventSqlRow, TestCaseSqlRow } from '@/types/sql-rows'
import {
  findModuleReviewRequestById,
  listCaseReviewsByModuleReview,
  listModuleReviewRequests,
  listModuleReviewRequestsByReviewer,
  updateModuleReviewRequestReviewerIfOpen,
  updateModuleReviewRequestStatusIfUnchanged,
  type ModuleReviewRequestWithCountSqlRow,
} from './module-reviews.repository'
import {
  insertReviewEvent,
  listEventsByRequestIds,
  updateReviewRequestReviewerIfOpen,
  updateReviewRequestStatus,
} from '../reviews/reviews.repository'
import { listTestCasesByIds, updateTestCaseStatus } from '../test-cases/test-cases.repository'

// Legacy constants preserved verbatim.
const DEFAULT_BULK_COMMENT = 'Bulk approved with module review.'
const ALL_LIST_LIMIT = 100
const OPEN_CASE_REVIEW_STATUSES = ['pending', 'in_progress']

// ---------- Queries ----------

/** GET ?id=... — one module review with module/reviewer/requester refs, nested
 *  caseReviews (each with its test case + events, oldest first) and caseCount.
 *  Cross-user read, so it carries the same STRICT perform_review gate as the
 *  all-list; the queue stays self-scoped and ungated.
 *  VISIBILITY IS PERMISSION-BASED (owner rule 2026-10-09): a perform_review
 *  holder may open ANY module review — assignment only gates approve-all. */
export async function getModuleReviewDetail(
  me: SessionUser,
  moduleReviewId: string
): Promise<SerializedModuleReviewRequest> {
  if (!can(me.role, 'perform_review')) {
    throw ApiError.forbidden('Only roles with perform-review rights can view module reviews')
  }
  const review = await findModuleReviewRequestById(moduleReviewId)
  if (!review) throw ApiError.notFound('Module review not found')

  const caseReviews = await listCaseReviewsByModuleReview(moduleReviewId)
  const [events, testCases] = await Promise.all([
    listEventsByRequestIds(caseReviews.map((cr) => cr.review_request_id)),
    listTestCasesByIds([...new Set(caseReviews.map((cr) => cr.test_case_id))]),
  ])

  const eventsByRequest = new Map<string, ReviewEventSqlRow[]>()
  for (const event of events) {
    const list = eventsByRequest.get(event.review_request_id) ?? []
    list.push(event)
    eventsByRequest.set(event.review_request_id, list)
  }
  const testCasesById = new Map<string, TestCaseSqlRow>(
    testCases.map((tc) => [tc.test_case_id, tc])
  )

  return serializeModuleReviewRequest({
    ...review,
    caseReviews: caseReviews.map((cr) => ({
      ...cr,
      testCase: testCasesById.get(cr.test_case_id) ?? null,
      events: eventsByRequest.get(cr.review_request_id) ?? [],
    })),
  })
}

/** GET ?action=queue — module reviews where I am the reviewer and the review is
 *  not completed yet (pending/in_progress), newest first, with case counts. */
export async function getMyModuleReviewQueue(
  me: SessionUser
): Promise<SerializedModuleReviewRequest[]> {
  const rows = await listModuleReviewRequestsByReviewer(me.userId, OPEN_CASE_REVIEW_STATUSES)
  return rows.map(serializeModuleReviewListRow)
}

/** GET ?action=all — module reviews visible to me, newest first, latest 100.
 *  VISIBILITY IS PERMISSION-BASED (owner rule 2026-10-09): perform_review
 *  holders browse ALL module reviews. STRICT gate: perform_review only — one
 *  feature's toggle must never affect another. */
export async function listAllModuleReviews(
  me: SessionUser
): Promise<SerializedModuleReviewRequest[]> {
  if (!can(me.role, 'perform_review')) {
    throw ApiError.forbidden('Only roles with perform-review rights can view all module reviews')
  }
  const rows = await listModuleReviewRequests(null, ALL_LIST_LIMIT)
  return rows.map(serializeModuleReviewListRow)
}

// List rows carry the SQL-computed case_review_count. The serializer derives
// caseCount only from an attached caseReviews array, so the contract field is
// filled from the aggregate here (keeps the legacy _count.caseReviews data).
function serializeModuleReviewListRow(
  row: ModuleReviewRequestWithCountSqlRow
): SerializedModuleReviewRequest {
  const serialized = serializeModuleReviewRequest(row)
  serialized.caseCount = row.case_review_count
  return serialized
}

// ---------- Commands ----------

/** Verdict -> test-case status, author notification type, and whether the
 *  verdict CLOSES the case review (needs_revision keeps it open for the
 *  reviewer to re-check after the author revises). Mirrors submitVerdict. */
const BULK_VERDICT_OUTCOMES: Record<
  'approved' | 'failed' | 'needs_revision',
  { testCaseStatus: string; notificationType: NotificationType; closes: boolean }
> = {
  approved: { testCaseStatus: 'approved', notificationType: 'review_approved', closes: true },
  failed: { testCaseStatus: 'needs_revision', notificationType: 'review_failed', closes: true },
  needs_revision: { testCaseStatus: 'needs_revision', notificationType: 'review_needs_revision', closes: false },
}

/**
 * POST ?id=...&action=bulk-verdict — apply ONE verdict to every open case
 * review of this module review in a single atomic action (approve all /
 * fail all / needs-revision all).
 *
 * OWNER RULE (2026-10-09): bulk authority is the ASSIGNED REVIEWER, exactly
 * mirroring the single-verdict rule. approve keeps its optional comment
 * (default text); fail / needs-revision REQUIRE a written comment — "a
 * proper msg there is to write". approve and fail complete the module
 * review; needs-revision keeps it open. Every affected case author AND the
 * requester receive notifications.
 */
export async function bulkCaseReviewVerdict(
  me: SessionUser,
  moduleReviewId: string,
  input: { verdict: 'approved' | 'failed' | 'needs_revision'; comment?: string | null; expectedUpdatedAt?: string },
  meta: RequestMeta
): Promise<{ verdict: string; affectedCount: number; moduleReviewStatus: string }> {
  ensurePermission(me, 'perform_review', 'Only roles with perform-review rights can review')

  const moduleReview = await findModuleReviewRequestById(moduleReviewId)
  if (!moduleReview) throw ApiError.notFound('Module review not found')

  // Bulk verdict authority is the ASSIGNED REVIEWER, mirroring the single
  // verdict rule: perform_review only makes a role eligible to review.
  if (moduleReview.reviewer_id !== me.userId) {
    throw ApiError.forbidden('Only the assigned reviewer can record verdicts for this module review')
  }
  if (moduleReview.status === 'completed') {
    throw ApiError.badRequest('This module review has already been completed')
  }

  // Comment rule: approve stays optional (legacy default text); fail and
  // needs-revision demand a written message so the author knows what to fix.
  const comment = input.verdict === 'approved'
    ? (input.comment?.trim() || DEFAULT_BULK_COMMENT)
    : input.comment?.trim()
  if (!comment) {
    throw ApiError.badRequest('Comment is required for this verdict — write what needs to change')
  }

  const caseReviews = await listCaseReviewsByModuleReview(moduleReviewId, OPEN_CASE_REVIEW_STATUSES)
  if (caseReviews.length === 0) {
    throw ApiError.badRequest('No open case reviews to record a verdict on.')
  }

  const outcome = BULK_VERDICT_OUTCOMES[input.verdict]
  const newCaseStatus = outcome.closes ? 'completed' : 'in_progress'
  const newModuleStatus = outcome.closes ? 'completed' : 'in_progress'

  // ATOMIC bulk verdict: the module-review status, every event, every case-review
  // status and every test case flip commit together or not at all — a crash
  // halfway can never leave the module half-decided. The guarded module-review
  // UPDATE runs FIRST (B2): a second bulk verdict waits on its row lock, then
  // finds the row changed and gets 409 instead of recording verdicts twice.
  const expected = resolveExpectedUpdatedAt(input.expectedUpdatedAt, moduleReview.updated_at)
  await db.$transaction(async (tx) => {
    const changed = await updateModuleReviewRequestStatusIfUnchanged(moduleReviewId, newModuleStatus, expected, tx)
    if (changed === 0) throw ApiError.staleEdit()
    for (const caseReview of caseReviews) {
      await insertReviewEvent(
        {
          reviewRequestId: caseReview.review_request_id,
          reviewerId: me.userId,
          verdict: input.verdict,
          comment,
          flaggedFields: [],
        },
        tx
      )
      await updateReviewRequestStatus(caseReview.review_request_id, newCaseStatus, tx)
      await updateTestCaseStatus(caseReview.test_case_id, outcome.testCaseStatus, tx)
    }
  })

  await logActivity({
    userId: me.userId,
    action: 'REVIEW_VERDICT',
    entityType: 'module',
    entityId: moduleReview.module_id,
    entityName: moduleReview.module_name ?? null,
    before: { reviewStatus: moduleReview.status },
    after: { reviewStatus: newModuleStatus, verdict: input.verdict, caseCount: caseReviews.length },
    meta,
  })

  // Notifications: every affected case author (deduped, self skipped) and the
  // requester who raised the module review — each with the actual verdict.
  const testCases = await listTestCasesByIds([...new Set(caseReviews.map((c) => c.test_case_id))])
  const byAuthor = new Map<string, string[]>()
  for (const tc of testCases) {
    if (!tc.author_id || tc.author_id === me.userId) continue
    const titles = byAuthor.get(tc.author_id) ?? []
    titles.push(tc.title)
    byAuthor.set(tc.author_id, titles)
  }
  for (const [authorId, titles] of byAuthor) {
    await createNotification({
      userId: authorId,
      type: outcome.notificationType,
      title: `Review ${input.verdict.replace('_', ' ')}`,
      body: `${me.fullName} recorded a "${input.verdict}" verdict on ${titles.length} of your test case(s) in module "${moduleReview.module_name ?? ''}" (cycle ${moduleReview.cycle}). Comment: "${comment}"`,
      entityType: 'module_review',
      entityId: moduleReviewId,
    })
  }
  if (moduleReview.requester_id !== me.userId) {
    await createNotification({
      userId: moduleReview.requester_id,
      type: outcome.notificationType,
      title: `Module review ${input.verdict.replace('_', ' ')}`,
      body: `${me.fullName} recorded "${input.verdict}" on all ${caseReviews.length} open test case(s) in module "${moduleReview.module_name ?? ''}" (cycle ${moduleReview.cycle}). Comment: "${comment}"`,
      entityType: 'module_review',
      entityId: moduleReviewId,
    })
  }

  logger.info('Module review bulk verdict recorded', {
    moduleReviewId,
    verdict: input.verdict,
    affectedCount: caseReviews.length,
    reviewerId: me.userId,
    moduleReviewStatus: newModuleStatus,
  })

  return { verdict: input.verdict, affectedCount: caseReviews.length, moduleReviewStatus: newModuleStatus }
}

/** Legacy shape kept for the existing approve-all action — delegates to the
 *  generalized bulk verdict with verdict='approved'. */
export async function approveAllCaseReviews(
  me: SessionUser,
  moduleReviewId: string,
  input: { comment?: string | null; expectedUpdatedAt?: string },
  meta: RequestMeta
): Promise<{ approvedCount: number; moduleReviewStatus: string }> {
  const res = await bulkCaseReviewVerdict(
    me,
    moduleReviewId,
    { verdict: 'approved', comment: input.comment, expectedUpdatedAt: input.expectedUpdatedAt },
    meta
  )
  return { approvedCount: res.affectedCount, moduleReviewStatus: res.moduleReviewStatus }
}

/**
 * POST ?id=...&action=change-reviewer — re-assign the module review AND every
 * open case review inside it to another TCMS user.
 *
 * OWNER RULE (2026-10-09): "a change reviewer option — the person who is
 * doing review (or any permission holder) can hand the whole module to
 * someone else and the tests go to that person." The module-level twin of
 * the case-level forward; guarded against completed reviews and dead
 * targets, atomic across the module row and its open case reviews.
 */
export async function changeModuleReviewer(
  me: SessionUser,
  moduleReviewId: string,
  input: { reviewerId: string },
  meta: RequestMeta
): Promise<SerializedModuleReviewRequest> {
  ensurePermission(me, 'perform_review', 'Only roles with perform-review rights can change the reviewer')

  const review = await findModuleReviewRequestById(moduleReviewId)
  if (!review) throw ApiError.notFound('Module review not found')
  if (review.status === 'completed') {
    throw ApiError.badRequest('This module review has already been completed — nothing to reassign')
  }
  if (input.reviewerId === review.reviewer_id) {
    throw ApiError.badRequest('This module review is already assigned to that reviewer')
  }
  const target = await findUserById(input.reviewerId)
  if (!target || !target.is_active) {
    throw ApiError.badRequest('Reviewer not found or inactive')
  }

  const openCaseReviews = await listCaseReviewsByModuleReview(moduleReviewId, OPEN_CASE_REVIEW_STATUSES)
  await db.$transaction(async (tx) => {
    const changed = await updateModuleReviewRequestReviewerIfOpen(moduleReviewId, input.reviewerId, tx)
    if (changed === 0) {
      throw ApiError.conflict('This module review was just completed — it can no longer be reassigned.')
    }
    for (const caseReview of openCaseReviews) {
      // Guarded per case: a verdict landing mid-flight wins over the swap.
      await updateReviewRequestReviewerIfOpen(caseReview.review_request_id, input.reviewerId, tx)
    }
  })

  await logActivity({
    userId: me.userId,
    action: 'REVIEW_FORWARDED',
    entityType: 'module',
    entityId: review.module_id,
    entityName: review.module_name ?? null,
    before: { reviewerId: review.reviewer_id },
    after: { reviewerId: input.reviewerId, cycle: review.cycle, caseReviews: openCaseReviews.length },
    meta,
  })
  if (input.reviewerId !== me.userId) {
    await createNotification({
      userId: input.reviewerId,
      type: 'review_assigned',
      title: 'Module review assigned to you',
      body: `${me.fullName} assigned the module review of "${review.module_name ?? ''}" to you (${openCaseReviews.length} open test case(s), cycle ${review.cycle}).`,
      entityType: 'module_review',
      entityId: moduleReviewId,
    })
  }

  logger.info('Module review reviewer changed', {
    moduleReviewId,
    from: me.userId,
    to: input.reviewerId,
    openCaseReviews: openCaseReviews.length,
  })

  // Full fresh detail (module + nested case reviews + events) as the response.
  return getModuleReviewDetail(me, moduleReviewId)
}
