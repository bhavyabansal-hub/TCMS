// Review-request repository — raw SQL access to review_requests/review_events.
//
// Shared resource boundary: the reviews resource owns this table, but the
// test-cases resource legitimately needs to CREATE a review (submit-review
// action), so the insertion lives here and is imported cross-resource.
// Business rules (cycles, verdicts, state machine) live in the services.

import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { newId } from '@/lib/server/id'
import type { ReviewRequestSqlRow, ReviewEventSqlRow } from '@/types/sql-rows'
import type { SqlExecutor } from '../test-cases/test-cases.repository'

/** Standard JOIN select for review requests (reviewer + requester refs). */
const REVIEW_SELECT = Prisma.sql`
  SELECT r.*,
    ru.user_id AS reviewer_user_id, ru.full_name AS reviewer_full_name, ru.email AS reviewer_email, ru.avatar_url AS reviewer_avatar_url,
    qu.user_id AS requester_user_id, qu.full_name AS requester_full_name, qu.avatar_url AS requester_avatar_url
  FROM review_requests r
  LEFT JOIN users ru ON ru.user_id = r.reviewer_id
  LEFT JOIN users qu ON qu.user_id = r.requester_id`

export async function findReviewRequestById(id: string): Promise<ReviewRequestSqlRow | null> {
  const rows = await db.$queryRaw<ReviewRequestSqlRow[]>`
    ${REVIEW_SELECT} WHERE r.review_request_id = ${id} LIMIT 1`
  return rows[0] ?? null
}

export async function findLatestCycleForTestCase(testCaseId: string): Promise<number> {
  const rows = await db.$queryRaw<{ cycle: number | bigint }[]>`
    SELECT COALESCE(MAX(cycle), 0) AS cycle
    FROM review_requests WHERE test_case_id = ${testCaseId}`
  return Number(rows[0]?.cycle ?? 0)
}

export async function insertReviewRequest(
  input: {
    testCaseId: string
    reviewerId: string
    requesterId: string
    dueDate: Date | null
    cycle: number
  },
  tx: SqlExecutor = db
): Promise<ReviewRequestSqlRow> {
  // MySQL has no RETURNING: generate the PK app-side, insert, then read back.
  const reviewRequestId = newId()
  await tx.$executeRaw`
    INSERT INTO review_requests (review_request_id, test_case_id, reviewer_id, requester_id, status, due_date, cycle, created_at, updated_at)
    VALUES (${reviewRequestId}, ${input.testCaseId}, ${input.reviewerId}, ${input.requesterId}, 'pending', ${input.dueDate}, ${input.cycle}, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`
  const rows = await tx.$queryRaw<ReviewRequestSqlRow[]>`
    ${REVIEW_SELECT} WHERE r.review_request_id = ${reviewRequestId} LIMIT 1`
  if (!rows[0]) throw new Error('Inserted review request could not be read back')
  return rows[0]
}

/** All review requests for one test case, newest first. */
export async function listReviewsByTestCase(testCaseId: string): Promise<ReviewRequestSqlRow[]> {
  return db.$queryRaw<ReviewRequestSqlRow[]>`
    ${REVIEW_SELECT} WHERE r.test_case_id = ${testCaseId}
    ORDER BY r.created_at DESC`
}

/** Review events for many review requests, oldest first (grouped by caller). */
export async function listEventsByRequestIds(requestIds: string[]): Promise<ReviewEventSqlRow[]> {
  if (requestIds.length === 0) return []
  return db.$queryRaw<ReviewEventSqlRow[]>(Prisma.sql`
    SELECT e.*, ru.user_id AS reviewer_user_id, ru.full_name AS reviewer_full_name, ru.avatar_url AS reviewer_avatar_url
    FROM review_events e
    LEFT JOIN users ru ON ru.user_id = e.reviewer_id
    WHERE e.review_request_id IN (${Prisma.join(requestIds)})
    ORDER BY e.created_at ASC`)
}

export async function listReviewEventsByRequest(requestId: string): Promise<ReviewEventSqlRow[]> {
  return listEventsByRequestIds([requestId])
}

/** Marks a test case's review status + bumps updated_at (part of verdict flow). */
export async function updateReviewRequestStatus(
  reviewRequestId: string,
  status: string,
  tx: SqlExecutor = db
): Promise<void> {
  await tx.$executeRaw`
    UPDATE review_requests SET status = ${status}, updated_at = UTC_TIMESTAMP(3)
    WHERE review_request_id = ${reviewRequestId}`
}

/** Concurrency-guarded status write: applies ONLY when the review is not
 *  already completed. Returns the number of rows changed (0 = another verdict
 *  landed first), so two simultaneous reviewers can never double-close a
 *  review or record two verdicts for one open request. */
export async function updateReviewRequestStatusIfOpen(
  reviewRequestId: string,
  status: string,
  tx: SqlExecutor = db
): Promise<number> {
  const affected = await tx.$executeRaw`
    UPDATE review_requests SET status = ${status}, updated_at = UTC_TIMESTAMP(3)
    WHERE review_request_id = ${reviewRequestId} AND status <> 'completed'`
  return Number(affected)
}

/** Re-assigns the reviewer of an OPEN review (forward flow). Guarded against
 *  completed rows for the same double-action safety as the status write.
 *  Returns the number of rows changed (0 = the review was completed in the
 *  meantime). */
export async function updateReviewRequestReviewerIfOpen(
  reviewRequestId: string,
  reviewerId: string,
  tx: SqlExecutor = db
): Promise<number> {
  const affected = await tx.$executeRaw`
    UPDATE review_requests SET reviewer_id = ${reviewerId}, status = 'pending', updated_at = UTC_TIMESTAMP(3)
    WHERE review_request_id = ${reviewRequestId} AND status <> 'completed'`
  return Number(affected)
}

// ---------- Module-level review fan-out (used by the modules resource) ----------

/** Input for creating the per-test-case reviews of a module-level review. */
export interface ModuleCaseReviewInsert {
  testCaseId: string
  reviewerId: string
  requesterId: string
  dueDate: Date | null
  cycle: number
  moduleReviewId: string
}

/** Batch-inserts the case reviews linked to a module-level review (single
 *  INSERT, the raw-SQL equivalent of the legacy createMany). PKs are generated
 *  app-side (MySQL raw INSERT supplies no RETURNING). Timestamps are
 *  set explicitly: updated_at has no DB default and raw SQL bypasses
 *  Prisma's @updatedAt. */
export async function insertReviewRequestsForModuleReview(
  inputs: ModuleCaseReviewInsert[]
): Promise<void> {
  if (inputs.length === 0) return
  const values = inputs.map(
    (input) => Prisma.sql`(${newId()}, ${input.testCaseId}, ${input.reviewerId}, ${input.requesterId},
      'pending', ${input.dueDate}, ${input.cycle}, ${input.moduleReviewId}, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`
  )
  await db.$executeRaw`
    INSERT INTO review_requests
      (review_request_id, test_case_id, reviewer_id, requester_id, status, due_date, cycle, module_review_id,
       created_at, updated_at)
    VALUES ${Prisma.join(values, ', ')}`
}

// ---------- Reviewer queue + filtered listing ----------

/** A reviewer's open reviews (given statuses), newest first. */
export async function listReviewRequestsByReviewer(
  reviewerId: string,
  statuses: string[]
): Promise<ReviewRequestSqlRow[]> {
  return db.$queryRaw<ReviewRequestSqlRow[]>(Prisma.sql`
    ${REVIEW_SELECT}
    WHERE r.reviewer_id = ${reviewerId}
      AND r.status IN (${Prisma.join(statuses)})
    ORDER BY r.created_at DESC`)
}

/** Filters for the paginated review listing. */
export interface ReviewRequestFilters {
  status?: string
  reviewerId?: string
  testCaseId?: string
  /** Visibility scope: only reviews where this user is the assigned reviewer
   *  or the requester who submitted the case (ownership-based visibility). */
  participantId?: string
}

function buildReviewRequestWhere(filters: ReviewRequestFilters): Prisma.Sql {
  const parts: Prisma.Sql[] = []
  if (filters.status) parts.push(Prisma.sql`r.status = ${filters.status}`)
  if (filters.reviewerId) parts.push(Prisma.sql`r.reviewer_id = ${filters.reviewerId}`)
  if (filters.testCaseId) parts.push(Prisma.sql`r.test_case_id = ${filters.testCaseId}`)
  if (filters.participantId) {
    parts.push(
      Prisma.sql`(r.reviewer_id = ${filters.participantId} OR r.requester_id = ${filters.participantId})`
    )
  }
  return parts.length ? Prisma.sql`WHERE ${Prisma.join(parts, ' AND ')}` : Prisma.empty
}

export async function countReviewRequests(filters: ReviewRequestFilters): Promise<number> {
  const rows = await db.$queryRaw<{ total: number | bigint }[]>`
    SELECT COUNT(*) AS total FROM review_requests r ${buildReviewRequestWhere(filters)}`
  return Number(rows[0]?.total ?? 0)
}

export async function listReviewRequests(
  filters: ReviewRequestFilters,
  limit: number,
  offset: number
): Promise<ReviewRequestSqlRow[]> {
  return db.$queryRaw<ReviewRequestSqlRow[]>(Prisma.sql`
    ${REVIEW_SELECT} ${buildReviewRequestWhere(filters)}
    ORDER BY r.created_at DESC
    LIMIT ${limit} OFFSET ${offset}`)
}

// ---------- Review events (verdict flow) ----------

export interface ReviewEventInsert {
  reviewRequestId: string
  reviewerId: string
  verdict: string
  comment: string | null
  flaggedFields: string[]
}

/** Creates a verdict event; the JSON column is the camelCase
 *  flagged_fields (the schema @maps flaggedFields -> flagged_fields).
 *  MySQL: no RETURNING — generate the PK app-side, insert, then read back. */
export async function insertReviewEvent(input: ReviewEventInsert, tx: SqlExecutor = db): Promise<ReviewEventSqlRow> {
  const reviewEventId = newId()
  await tx.$executeRaw`
    INSERT INTO review_events (review_event_id, review_request_id, reviewer_id, verdict, comment, flagged_fields, created_at)
    VALUES (${reviewEventId}, ${input.reviewRequestId}, ${input.reviewerId}, ${input.verdict}, ${input.comment},
            CAST(${JSON.stringify(input.flaggedFields)} AS JSON), UTC_TIMESTAMP(3))`
  const rows = await tx.$queryRaw<ReviewEventSqlRow[]>`
    SELECT * FROM review_events WHERE review_event_id = ${reviewEventId} LIMIT 1`
  if (!rows[0]) throw new Error('Inserted review event could not be read back')
  return rows[0]
}
