// Module-review repository — raw SQL access to module_review_requests plus
// the module-review side of review_requests ("case reviews").
//
// Shared resource boundary: the modules resource legitimately needs to CREATE
// a module review (submit-review action) and the module-reviews resource
// reads/completes them, so all module_review_requests access lives here.
// Business rules (cycle numbering, verdicts, state machine) live in services;
// this file contains ONLY data access.

import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { insertReturningId } from '@/lib/server/insert'
import type { ModuleReviewRequestSqlRow, ReviewRequestSqlRow } from '@/types/sql-rows'
import type { SqlExecutor } from '../test-cases/test-cases.repository'

/** Module-review row plus the number of case reviews attached to it. */
export type ModuleReviewRequestWithCountSqlRow = ModuleReviewRequestSqlRow & {
  case_review_count: number
}

/** Raw pre-normalization shape: MySQL COUNT() may arrive as bigint. */
type ModuleReviewRequestWithCountRaw = ModuleReviewRequestSqlRow & {
  case_review_count: number | bigint
}

/** Normalizes the COUNT() subselect to a plain number (R: MySQL aggregates). */
function withNumberCaseReviewCount(rows: ModuleReviewRequestWithCountRaw[]): ModuleReviewRequestWithCountSqlRow[] {
  return rows.map((r) => ({ ...r, case_review_count: Number(r.case_review_count) }))
}

/** Standard JOIN select — module review plus module/reviewer/requester refs. */
const MODULE_REVIEW_SELECT = Prisma.sql`
  SELECT mrr.*,
    m.module_id AS module_module_id, m.name AS module_name, m.parent_id AS module_parent_id,
    ru.user_id AS reviewer_user_id, ru.full_name AS reviewer_full_name, ru.email AS reviewer_email, ru.avatar_url AS reviewer_avatar_url,
    qu.user_id AS requester_user_id, qu.full_name AS requester_full_name, qu.avatar_url AS requester_avatar_url
  FROM module_review_requests mrr
  LEFT JOIN modules m ON m.module_id = mrr.module_id
  LEFT JOIN users ru ON ru.user_id = mrr.reviewer_id
  LEFT JOIN users qu ON qu.user_id = mrr.requester_id`

/** JOIN select that additionally counts the attached case reviews. */
const MODULE_REVIEW_WITH_COUNT_SELECT = Prisma.sql`
  SELECT mrr.*,
    m.module_id AS module_module_id, m.name AS module_name, m.parent_id AS module_parent_id,
    ru.user_id AS reviewer_user_id, ru.full_name AS reviewer_full_name, ru.email AS reviewer_email, ru.avatar_url AS reviewer_avatar_url,
    qu.user_id AS requester_user_id, qu.full_name AS requester_full_name, qu.avatar_url AS requester_avatar_url,
    (SELECT COUNT(*) FROM review_requests cr
      WHERE cr.module_review_id = mrr.module_review_request_id) AS case_review_count
  FROM module_review_requests mrr
  LEFT JOIN modules m ON m.module_id = mrr.module_id
  LEFT JOIN users ru ON ru.user_id = mrr.reviewer_id
  LEFT JOIN users qu ON qu.user_id = mrr.requester_id`

/** Standard JOIN select for case reviews (reviewer + requester refs). */
const CASE_REVIEW_SELECT = Prisma.sql`
  SELECT r.*,
    ru.user_id AS reviewer_user_id, ru.full_name AS reviewer_full_name, ru.email AS reviewer_email, ru.avatar_url AS reviewer_avatar_url,
    qu.user_id AS requester_user_id, qu.full_name AS requester_full_name, qu.avatar_url AS requester_avatar_url
  FROM review_requests r
  LEFT JOIN users ru ON ru.user_id = r.reviewer_id
  LEFT JOIN users qu ON qu.user_id = r.requester_id`

function caseReviewFilter(moduleReviewId: string, statuses?: string[]): Prisma.Sql {
  const base = Prisma.sql`WHERE r.module_review_id = ${moduleReviewId}`
  if (!statuses || statuses.length === 0) return base
  return Prisma.sql`${base} AND r.status IN (${Prisma.join(statuses)})`
}

// ---------- Inserts ----------

export interface ModuleReviewRequestInsert {
  moduleId: string
  reviewerId: string
  requesterId: string
  dueDate: Date | null
  cycle: number
}

/** Creates a pending module review request. The key comes from LAST_INSERT_ID()
 *  (MySQL: no RETURNING — insert, then read back).
 *  created_at/updated_at are set explicitly: updated_at has no DB default
 *  and raw SQL bypasses Prisma's @updatedAt. */
export async function insertModuleReviewRequest(
  input: ModuleReviewRequestInsert,
  tx: SqlExecutor = db
): Promise<ModuleReviewRequestSqlRow> {
  const moduleReviewRequestId = await insertReturningId(Prisma.sql`
    INSERT INTO module_review_requests
      (module_id, reviewer_id, requester_id, status, due_date, cycle, created_at, updated_at)
    VALUES
      (${input.moduleId}, ${input.reviewerId}, ${input.requesterId}, 'pending',
       ${input.dueDate}, ${input.cycle}, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`, tx)
  const rows = await tx.$queryRaw<ModuleReviewRequestSqlRow[]>`
    SELECT * FROM module_review_requests WHERE module_review_request_id = ${moduleReviewRequestId} LIMIT 1`
  if (!rows[0]) throw new Error('Inserted module review request could not be read back')
  return rows[0]
}

// ---------- Reads ----------

export async function findModuleReviewRequestById(
  moduleReviewRequestId: string
): Promise<ModuleReviewRequestSqlRow | null> {
  const rows = await db.$queryRaw<ModuleReviewRequestSqlRow[]>`
    ${MODULE_REVIEW_SELECT} WHERE mrr.module_review_request_id = ${moduleReviewRequestId} LIMIT 1`
  return rows[0] ?? null
}

/** Highest review cycle number used for a module (module-review cycles are
 *  per MODULE, not per test case — legacy semantics). */
export async function findLatestModuleReviewCycle(moduleId: string, tx: SqlExecutor = db): Promise<number> {
  const rows = await tx.$queryRaw<{ cycle: number | bigint }[]>`
    SELECT COALESCE(MAX(cycle), 0) AS cycle
    FROM module_review_requests WHERE module_id = ${moduleId}`
  return Number(rows[0]?.cycle ?? 0)
}

/** A reviewer's queue (given statuses), newest first, with case counts. */
export async function listModuleReviewRequestsByReviewer(
  reviewerId: string,
  statuses: string[]
): Promise<ModuleReviewRequestWithCountSqlRow[]> {
  return withNumberCaseReviewCount(await db.$queryRaw<ModuleReviewRequestWithCountRaw[]>(Prisma.sql`
    ${MODULE_REVIEW_WITH_COUNT_SELECT}
    WHERE mrr.reviewer_id = ${reviewerId}
      AND mrr.status IN (${Prisma.join(statuses)})
    ORDER BY mrr.created_at DESC`))
}

/** All module reviews, newest first (optionally status-filtered).
 *  With participantId set, visibility is ownership-scoped: only rows where
 *  the user is the assigned reviewer or the requester. */
export async function listModuleReviewRequests(
  statuses: string[] | null,
  limit: number,
  participantId?: string
): Promise<ModuleReviewRequestWithCountSqlRow[]> {
  const parts: Prisma.Sql[] = []
  if (statuses && statuses.length > 0) {
    parts.push(Prisma.sql`mrr.status IN (${Prisma.join(statuses)})`)
  }
  if (participantId) {
    parts.push(Prisma.sql`(mrr.reviewer_id = ${participantId} OR mrr.requester_id = ${participantId})`)
  }
  const where = parts.length ? Prisma.sql`WHERE ${Prisma.join(parts, ' AND ')}` : Prisma.empty
  return withNumberCaseReviewCount(await db.$queryRaw<ModuleReviewRequestWithCountRaw[]>(Prisma.sql`
    ${MODULE_REVIEW_WITH_COUNT_SELECT} ${where}
    ORDER BY mrr.created_at DESC
    LIMIT ${limit}`))
}

/** All module reviews raised for one module, newest first. */
export async function listModuleReviewRequestsByModule(
  moduleId: string
): Promise<ModuleReviewRequestWithCountSqlRow[]> {
  return withNumberCaseReviewCount(await db.$queryRaw<ModuleReviewRequestWithCountRaw[]>(Prisma.sql`
    ${MODULE_REVIEW_WITH_COUNT_SELECT}
    WHERE mrr.module_id = ${moduleId}
    ORDER BY mrr.created_at DESC`))
}

/** Case reviews belonging to one module review, oldest first. */
export async function listCaseReviewsByModuleReview(
  moduleReviewId: string,
  statuses?: string[],
  tx: SqlExecutor = db,
  { lock = false }: { lock?: boolean } = {}
): Promise<ReviewRequestSqlRow[]> {
  // lock: holds the case-review rows until the caller's transaction ends.
  return tx.$queryRaw<ReviewRequestSqlRow[]>(Prisma.sql`
    ${CASE_REVIEW_SELECT} ${caseReviewFilter(moduleReviewId, statuses)}
    ORDER BY r.created_at ASC${lock ? Prisma.sql` FOR UPDATE OF r` : Prisma.empty}`)
}

/** Number of case reviews of one module review (optionally by status). */
export async function countCaseReviews(
  moduleReviewId: string,
  statuses?: string[]
): Promise<number> {
  const rows = await db.$queryRaw<{ total: number | bigint }[]>(Prisma.sql`
    SELECT COUNT(*) AS total FROM review_requests r ${caseReviewFilter(moduleReviewId, statuses)}`)
  return Number(rows[0]?.total ?? 0)
}

// ---------- Updates ----------

/** Marks a module review's status + bumps updated_at (part of verdict flow). */
/** Open module reviews that hold an open case review of one of these cases. */
export async function listOpenModuleReviewIdsForCases(testCaseIds: string[], tx: SqlExecutor = db): Promise<string[]> {
  if (testCaseIds.length === 0) return []
  const rows = await tx.$queryRaw<{ module_review_id: string }[]>`
    SELECT DISTINCT r.module_review_id FROM review_requests r
    JOIN module_review_requests m ON m.module_review_request_id = r.module_review_id
    WHERE r.test_case_id IN (${Prisma.join(testCaseIds)})
      AND r.status <> 'completed' AND m.status <> 'completed'`
  return rows.map((row) => String(row.module_review_id))
}

/** Row-locks these module reviews (id order) until the transaction ends.
 *  Lock order for every review write (chaos test 2026-10-22), so two writers
 *  never deadlock: module -> module reviews -> case reviews -> test cases —
 *  the order the single and bulk verdicts already used. */
export async function lockModuleReviews(moduleReviewIds: string[], tx: SqlExecutor): Promise<void> {
  if (moduleReviewIds.length === 0) return
  await tx.$queryRaw`
    SELECT module_review_request_id FROM module_review_requests
    WHERE module_review_request_id IN (${Prisma.join(moduleReviewIds)})
    ORDER BY module_review_request_id
    FOR UPDATE`
}

/** Row-locks every case review of these test cases (id order). */
export async function lockCaseReviewsOfCases(testCaseIds: string[], tx: SqlExecutor): Promise<void> {
  if (testCaseIds.length === 0) return
  await tx.$queryRaw`
    SELECT review_request_id FROM review_requests
    WHERE test_case_id IN (${Prisma.join(testCaseIds)})
    ORDER BY review_request_id
    FOR UPDATE`
}

/** Row-locks every case review inside these module reviews (id order). */
export async function lockCaseReviewsOfModuleReviews(moduleReviewIds: string[], tx: SqlExecutor): Promise<void> {
  if (moduleReviewIds.length === 0) return
  await tx.$queryRaw`
    SELECT review_request_id FROM review_requests
    WHERE module_review_id IN (${Prisma.join(moduleReviewIds)})
    ORDER BY review_request_id
    FOR UPDATE`
}

/** Ids of every module review raised on one of these modules (any status). */
export async function listModuleReviewIdsForModules(moduleIds: string[], tx: SqlExecutor = db): Promise<string[]> {
  if (moduleIds.length === 0) return []
  const rows = await tx.$queryRaw<{ module_review_request_id: string }[]>`
    SELECT module_review_request_id FROM module_review_requests WHERE module_id IN (${Prisma.join(moduleIds)})`
  return rows.map((row) => String(row.module_review_request_id))
}

/** Completes the given module reviews that have no open case review left —
 *  after a resubmit closed or a delete removed their last one (chaos test
 *  2026-10-22: such a module review stayed open forever). Returns how many. */
export async function completeModuleReviewsWithNothingOpen(moduleReviewIds: string[], tx: SqlExecutor = db): Promise<number> {
  if (moduleReviewIds.length === 0) return 0
  const changed = await tx.$executeRaw`
    UPDATE module_review_requests m
    SET m.status = 'completed', m.updated_at = UTC_TIMESTAMP(3)
    WHERE m.module_review_request_id IN (${Prisma.join(moduleReviewIds)})
      AND m.status <> 'completed'
      AND NOT EXISTS (SELECT 1 FROM review_requests r
        WHERE r.module_review_id = m.module_review_request_id AND r.status <> 'completed')`
  return Number(changed)
}

export async function updateModuleReviewRequestStatus(
  moduleReviewRequestId: string,
  status: string,
  tx: SqlExecutor = db
): Promise<void> {
  await tx.$executeRaw`
    UPDATE module_review_requests SET status = ${status}, updated_at = UTC_TIMESTAMP(3)
    WHERE module_review_request_id = ${moduleReviewRequestId}`
}

/** Guarded status write for the bulk verdict (B2): applies only while the module
 *  review is open AND still carries the loaded updated_at. Returns rows changed
 *  (0 = another verdict or edit landed first). */
export async function updateModuleReviewRequestStatusIfUnchanged(
  moduleReviewRequestId: string,
  status: string,
  expectedUpdatedAt: Date,
  tx: SqlExecutor = db
): Promise<number> {
  const affected = await tx.$executeRaw`
    UPDATE module_review_requests SET status = ${status}, updated_at = UTC_TIMESTAMP(3)
    WHERE module_review_request_id = ${moduleReviewRequestId} AND status <> 'completed'
      AND updated_at = ${expectedUpdatedAt}`
  return Number(affected)
}

/** Re-assigns the reviewer of an OPEN module review (change-reviewer flow).
 *  Guarded against completed rows for the same double-action safety as the
 *  status write. Returns rows changed (0 = completed in the meantime). */
export async function updateModuleReviewRequestReviewerIfOpen(
  moduleReviewRequestId: string,
  reviewerId: string,
  tx: SqlExecutor = db
): Promise<number> {
  const affected = await tx.$executeRaw`
    UPDATE module_review_requests SET reviewer_id = ${reviewerId}, updated_at = UTC_TIMESTAMP(3)
    WHERE module_review_request_id = ${moduleReviewRequestId} AND status <> 'completed'`
  return Number(affected)
}
