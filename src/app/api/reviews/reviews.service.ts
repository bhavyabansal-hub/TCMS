// Review service — business logic and orchestration.
//
// Owns: review-queue/listing rules, the verdict flow (permission, ownership,
// comment rule, review/test-case status machine), sibling-module-review
// completion, activity logging and reviewer/author notifications.
// Data access goes exclusively through the repositories; responses are
// produced exclusively through the serializers.

import type { RequestMeta } from '@/lib/activity'
import { ApiError, getPagination, paginate, type PaginatedResponse } from '@/lib/api'
import { can, ensurePermission, type SessionUser } from '@/lib/auth'
import { logActivity } from '@/lib/activity'
import { createNotification, type NotificationType } from '@/lib/notifications'
import { logger } from '@/lib/logger'
import { db } from '@/lib/db'
import { findUserById } from '@/lib/server/user.repository'
import {
  serializeReviewEvent,
  serializeReviewRequest,
  type SerializedReviewEvent,
  type SerializedReviewRequest,
} from '@/lib/serializers'
import {
  findTestCaseById,
  listTestCasesByIds,
  updateTestCaseStatus,
} from '../test-cases/test-cases.repository'
import {
  countCaseReviews,
  findModuleReviewRequestById,
  updateModuleReviewRequestStatus,
} from '../module-reviews/module-reviews.repository'
import type { ReviewRequestSqlRow } from '@/types/sql-rows'
import {
  countReviewRequests,
  findReviewRequestById,
  insertReviewEvent,
  listReviewEventsByRequest,
  listReviewRequests,
  listReviewRequestsByReviewer,
  updateReviewRequestReviewerIfOpen,
  updateReviewRequestStatusIfOpen,
  type ReviewRequestFilters,
} from './reviews.repository'

// ---------- Queries ----------

/** Read gate shared by every cross-user review read (detail, all list):
 *  STRICT — only roles with perform_review may browse reviews at all. A
 *  submit-only user tracks their submissions through test-case status and
 *  notifications instead; the reviews workspace belongs to reviewers.
 *  Self-scoped reads (my queue) stay ungated — they return own rows only.
 *
 *  OWNER RULE (2026-10-09, clarified): within this gate, VISIBILITY IS
 *  PERMISSION-BASED — a perform_review holder sees ALL review requests,
 *  not just the ones they participate in. Assignment is a separate axis:
 *  it decides who can ACT (verdict), never who can see. */
function ensureReviewBrowser(me: SessionUser): void {
  if (!can(me.role, 'perform_review')) {
    throw ApiError.forbidden('Only roles with perform-review rights can view reviews')
  }
}

/** GET /api/reviews?id=... — one review with its test case + verdict events.
 *  Visibility is permission-based (owner rule): any perform_review holder may
 *  open ANY review. Acting on it still requires the assignment — the verdict
 *  endpoint enforces that separately. */
export async function getReviewDetail(
  me: SessionUser,
  reviewId: string
): Promise<SerializedReviewRequest> {
  ensureReviewBrowser(me)
  const review = await findReviewRequestById(reviewId)
  if (!review) throw ApiError.notFound('Review not found')
  const [testCase, events] = await Promise.all([
    findTestCaseById(review.test_case_id),
    listReviewEventsByRequest(review.review_request_id),
  ])
  return serializeReviewRequest({ ...review, testCase: testCase ?? null, events })
}

/** GET /api/reviews?action=queue — my open (pending/in_progress) reviews. */
export async function listReviewQueue(me: SessionUser): Promise<SerializedReviewRequest[]> {
  const reviews = await listReviewRequestsByReviewer(me.userId, ['pending', 'in_progress'])
  return attachTestCases(reviews)
}

/** GET /api/reviews — paginated listing with legacy filters. */
export async function listReviewsPaginated(
  me: SessionUser,
  q: Record<string, string>
): Promise<PaginatedResponse<SerializedReviewRequest>> {
  ensureReviewBrowser(me)
  // PERMISSION = VISIBILITY (owner rule 2026-10-09): a perform_review holder
  // lists ALL review requests — that is the whole point of the All Reviews
  // tab. The assignment still decides who can act, and forwarding is the
  // path to get a request assigned to you. (participantId survives only as a
  // defensive scope for any future non-perform_review caller of this list.)
  const canBrowseAll = can(me.role, 'perform_review')
  const filters: ReviewRequestFilters = {
    status: q.status,
    reviewerId: q.reviewerId,
    testCaseId: q.testCaseId,
    participantId: canBrowseAll ? undefined : me.userId,
  }
  const { page, pageSize, offset } = getPagination(q, 50)
  const [total, rows] = await Promise.all([
    countReviewRequests(filters),
    listReviewRequests(filters, pageSize, offset),
  ])
  const data = await attachTestCases(rows)
  return paginate(data, total, page, pageSize)
}

// ---------- Commands ----------

/**
 * POST /api/reviews?id=...&action=forward — re-assign an OPEN review to
 * another TCMS user.
 *
 * OWNER RULE (2026-10-09, clarified): a review that is not assigned to you
 * can never be decided by you — but the approve permission carries the power
 * to RE-ROUTE any open review to any active TCMS user. That includes
 * forwarding it to YOURSELF, which is exactly how a permission holder
 * "makes the review assigned to him"; from that moment the verdict powers
 * apply. The only rejected forwards are no-ops (target == current reviewer),
 * dead targets (unknown/inactive users) and completed reviews.
 */
export async function forwardReview(
  me: SessionUser,
  reviewId: string,
  input: { reviewerId: string },
  meta: RequestMeta
): Promise<SerializedReviewRequest> {
  ensurePermission(me, 'perform_review', 'Only roles with perform-review rights can forward a review')

  const review = await findReviewRequestById(reviewId)
  if (!review) throw ApiError.notFound('Review not found')

  if (review.status === 'completed') {
    throw ApiError.badRequest('This review has already been completed — nothing to forward')
  }
  // Self-forward is ALLOWED (owner rule) — taking over a review assigned to
  // someone else is the sanctioned way to get it assigned to you. What is a
  // pure no-op is forwarding to the user who already holds it (which also
  // covers "forward to me" while I am already the assignee).
  if (input.reviewerId === review.reviewer_id) {
    throw ApiError.badRequest('This review is already assigned to that reviewer')
  }
  const target = await findUserById(input.reviewerId)
  if (!target || !target.is_active) {
    throw ApiError.badRequest('Reviewer not found or inactive')
  }

  // Guarded re-assign: a verdict landing at the same moment wins and the
  // forward reports a conflict instead of overwriting a finished review.
  const changed = await updateReviewRequestReviewerIfOpen(reviewId, input.reviewerId)
  if (changed === 0) {
    throw ApiError.conflict('This review was just completed — it can no longer be forwarded.')
  }

  const testCase = await findTestCaseById(review.test_case_id)
  await logActivity({
    userId: me.userId,
    action: 'REVIEW_FORWARDED',
    entityType: 'test_case',
    entityId: review.test_case_id,
    entityName: testCase?.title ?? null,
    before: { reviewerId: review.reviewer_id },
    after: { reviewerId: input.reviewerId, cycle: review.cycle },
    meta,
  })
  // Notify the new reviewer — unless they are the actor (self-takeover needs
  // no "forwarded to you" ping for their own action).
  if (input.reviewerId !== me.userId) {
    await createNotification({
      userId: input.reviewerId,
      type: 'review_assigned',
      title: 'Review forwarded to you',
      body: `${me.fullName} forwarded the review of test case "${testCase?.title ?? ''}" to you (cycle ${review.cycle}).`,
      entityType: 'review',
      entityId: reviewId,
    })
  }

  logger.info('Review forwarded', { reviewRequestId: reviewId, from: me.userId, to: input.reviewerId })
  const fresh = await findReviewRequestById(reviewId)
  if (!fresh) throw ApiError.notFound('Review not found')
  const [testCaseFull, events] = await Promise.all([
    findTestCaseById(fresh.test_case_id),
    listReviewEventsByRequest(fresh.review_request_id),
  ])
  return serializeReviewRequest({ ...fresh, testCase: testCaseFull ?? null, events })
}

/** POST /api/reviews?id=... — record a reviewer's verdict and cascade statuses. */
export async function submitVerdict(
  me: SessionUser,
  reviewId: string,
  input: { verdict: string; comment?: string; flaggedFields: string[] },
  meta: RequestMeta
): Promise<{
  event: SerializedReviewEvent
  reviewStatus: string
  testCaseStatus: string
  moduleReviewCompleted: boolean
}> {
  ensurePermission(me, 'perform_review', 'Only roles with perform-review rights can review')

  if (input.verdict !== 'approved' && !input.comment) {
    throw ApiError.badRequest('Comment is required when verdict is not "approved"')
  }

  const review = await findReviewRequestById(reviewId)
  if (!review) throw ApiError.notFound('Review not found')
  // Verdict authority is the ASSIGNED REVIEWER: perform_review only makes a
  // role eligible to review, the assignment decides who decides this request.
  if (review.reviewer_id !== me.userId) {
    throw ApiError.forbidden('Only the assigned reviewer can submit a verdict for this review')
  }
  if (review.status === 'completed') {
    throw ApiError.badRequest('This review has already been completed')
  }

  const testCase = await findTestCaseById(review.test_case_id)
  if (!testCase) throw ApiError.notFound('Test case not found')

  // Review status: needs_revision keeps the review open, everything else closes it.
  const newReviewStatus = input.verdict === 'needs_revision' ? 'in_progress' : 'completed'

  // Verdict -> test-case status + author notification type.
  const VERDICT_OUTCOMES: Record<string, { testCaseStatus: string; notificationType: NotificationType }> = {
    approved: { testCaseStatus: 'approved', notificationType: 'review_approved' },
    failed: { testCaseStatus: 'needs_revision', notificationType: 'review_failed' },
    needs_revision: { testCaseStatus: 'needs_revision', notificationType: 'review_needs_revision' },
  }
  const { testCaseStatus: newTcStatus, notificationType } = VERDICT_OUTCOMES[input.verdict]

  // The whole verdict — event row, review closure, test-case status — commits
  // as ONE unit, and the closure is GUARDED (status <> 'completed'): a double
  // click or two reviewers hitting Enter together can only ever record ONE
  // verdict; the loser gets a clear 409 instead of corrupting the history.
  const event = await db.$transaction(async (tx) => {
    const recorded = await insertReviewEvent(
      {
        reviewRequestId: reviewId,
        reviewerId: me.userId,
        verdict: input.verdict,
        comment: input.comment ?? null,
        flaggedFields: input.flaggedFields,
      },
      tx
    )
    const closed = await updateReviewRequestStatusIfOpen(reviewId, newReviewStatus, tx)
    if (closed === 0) {
      throw ApiError.conflict('This review was already completed by someone else just now.')
    }
    await updateTestCaseStatus(review.test_case_id, newTcStatus, tx)
    return recorded
  })

  await logActivity({
    userId: me.userId,
    action: 'REVIEW_VERDICT',
    entityType: 'test_case',
    entityId: review.test_case_id,
    entityName: testCase.title,
    before: { status: testCase.status },
    after: { status: newTcStatus, verdict: input.verdict },
    meta,
  })

  // Notify the test-case author (skip self-reviews — no self-notification).
  if (testCase.author_id !== me.userId) {
    await createNotification({
      userId: testCase.author_id,
      type: notificationType,
      title: `Review ${input.verdict.replace('_', ' ')}`,
      body: `${me.fullName} recorded a "${input.verdict}" verdict on your test case "${testCase.title}".${input.comment ? ` Comment: "${input.comment}"` : ''}`,
      entityType: 'review',
      entityId: reviewId,
    })
  }

  // The person who RAISED the review request hears the verdict too (owner
  // rule 2026-10-09: "proper notification goes to the person who raised the
  // request") — deduped against the author and the actor.
  if (review.requester_id !== testCase.author_id && review.requester_id !== me.userId) {
    await createNotification({
      userId: review.requester_id,
      type: notificationType,
      title: `Review ${input.verdict.replace('_', ' ')}`,
      body: `${me.fullName} recorded a "${input.verdict}" verdict on the test case "${testCase.title}" you sent for review (cycle ${review.cycle}).${input.comment ? ` Comment: "${input.comment}"` : ''}`,
      entityType: 'review',
      entityId: reviewId,
    })
  }

  // Cascade into the parent module review when this verdict belongs to one.
  const moduleReviewCompleted = review.module_review_id
    ? await syncModuleReviewAfterVerdict(review.module_review_id, me)
    : false

  logger.info('Review verdict recorded', {
    reviewRequestId: reviewId,
    verdict: input.verdict,
    testCaseId: review.test_case_id,
    reviewStatus: newReviewStatus,
    testCaseStatus: newTcStatus,
    moduleReviewCompleted,
  })

  return {
    event: serializeReviewEvent(event),
    reviewStatus: newReviewStatus,
    testCaseStatus: newTcStatus,
    moduleReviewCompleted,
  }
}

// ---------- Helpers ----------

/** Attaches each review's test case (one batched lookup, mapped by id). */
async function attachTestCases(reviews: ReviewRequestSqlRow[]): Promise<SerializedReviewRequest[]> {
  const testCaseIds = [...new Set(reviews.map((r) => r.test_case_id))]
  const testCases = await listTestCasesByIds(testCaseIds)
  const byId = new Map(testCases.map((tc) => [tc.test_case_id, tc]))
  return reviews.map((r) => serializeReviewRequest({ ...r, testCase: byId.get(r.test_case_id) ?? null }))
}

/** When every case review of a module review is completed, completes the
 *  module review and notifies its requester; otherwise keeps it in progress.
 *  Returns true only when it flipped to completed. */
async function syncModuleReviewAfterVerdict(moduleReviewId: string, actor: SessionUser): Promise<boolean> {
  const [completedCount, totalCount] = await Promise.all([
    countCaseReviews(moduleReviewId, ['completed']),
    countCaseReviews(moduleReviewId),
  ])

  if (totalCount > 0 && completedCount === totalCount) {
    await updateModuleReviewRequestStatus(moduleReviewId, 'completed')
    const moduleReview = await findModuleReviewRequestById(moduleReviewId)
    if (moduleReview && moduleReview.requester_id !== actor.userId) {
      await createNotification({
        userId: moduleReview.requester_id,
        type: 'review_approved',
        title: 'Module review completed',
        body: `${actor.fullName} completed the review of all test cases in module "${moduleReview.module_name ?? ''}" (cycle ${moduleReview.cycle}).`,
        entityType: 'module_review',
        entityId: moduleReview.module_review_request_id,
      })
    }
    return true
  }

  await updateModuleReviewRequestStatus(moduleReviewId, 'in_progress')
  return false
}
