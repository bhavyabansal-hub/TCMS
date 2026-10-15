// Stats repository — raw SQL aggregates for the dashboard and reports views.
//
// The stats resource is a cross-cutting, read-only aggregation surface; its
// COUNT / GROUP BY queries live here. Related data that already has a resource
// home is read through that resource's repository instead:
//   - recent activity rows  -> ../activity-logs/activity-logs.repository
//   - weekly-hours source rows -> ../task-reports/task-reports.repository
// Contains ONLY data access: no permission checks, no shaping, no HTTP.

import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import type { Severity, TestCaseStatus, BugStatus, Priority } from '@/types'

/** Legacy open-bug set — `db.bug.count({ where: { status: { in: [...] } } })`. */
const OPEN_BUG_STATUSES = ['open', 'in_progress']
/** Legacy pending-review set for the current user's dashboard counter. */
const PENDING_REVIEW_STATUSES = ['pending', 'in_progress']

// ---------- Canonical status universes (STRICT completeness) ----------
// GROUP BY only returns statuses that HAVE rows, so a fresh database would
// report no "draft" bucket at all and a dashboard could silently drop a
// status chip. Every summary below is zero-filled against these lists so the
// payload ALWAYS carries every legal status with an explicit count (>= 0).
// The `satisfies`-style typing keeps the lists compile-time in sync with the
// union types in @/types (a typo here is a type error, not a wrong chart).
const TEST_CASE_STATUSES: readonly TestCaseStatus[] = [
  'draft', 'in_review', 'needs_revision', 'approved', 'active', 'deprecated',
]
const BUG_STATUSES: readonly BugStatus[] = ['open', 'in_progress', 'resolved', 'closed', 'wont_fix']
const TEST_CASE_PRIORITIES: readonly Priority[] = ['P0', 'P1', 'P2', 'P3']
const BUG_SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low']

/** Zero-fills a GROUP BY result against the canonical value list.
 *  MySQL aggregates may arrive as bigint/string — normalized to number here. */
function fillCounts<T extends string, R extends { count: number | bigint }>(
  universe: readonly T[],
  rows: R[],
  keyOf: (row: R) => string
): { key: T; count: number }[] {
  const byKey = new Map(rows.map((r) => [keyOf(r), r.count]))
  return universe.map((key) => ({ key, count: Number(byKey.get(key) ?? 0) }))
}

export interface StatusCountSqlRow {
  status: string
  count: number
}

export interface PriorityCountSqlRow {
  priority: string
  count: number
}

export interface SeverityCountSqlRow {
  severity: string
  count: number
}

/** Total test cases — legacy counted ALL rows (no WHERE, deprecated included). */
export async function countTotalTestCases(): Promise<number> {
  const rows = await db.$queryRaw<{ total: number | bigint }[]>`
    SELECT COUNT(*) AS total FROM test_cases`
  return Number(rows[0]?.total ?? 0)
}

/** Every legal test-case status with an explicit count — zero statuses are
 *  included (never dropped), so dashboards and reports are strictly correct. */
export async function summarizeTestCasesByStatus(): Promise<StatusCountSqlRow[]> {
  const rows = await db.$queryRaw<{ status: string; count: number | bigint }[]>`
    SELECT status, COUNT(*) AS \`count\` FROM test_cases
    GROUP BY status ORDER BY status`
  return fillCounts(TEST_CASE_STATUSES, rows, (r) => r.status).map(({ key, count }) => ({ status: key, count }))
}

/** Every legal priority with an explicit count (zero-filled). */
export async function summarizeTestCasesByPriority(): Promise<PriorityCountSqlRow[]> {
  const rows = await db.$queryRaw<{ priority: string; count: number | bigint }[]>`
    SELECT priority, COUNT(*) AS \`count\` FROM test_cases
    GROUP BY priority ORDER BY priority`
  return fillCounts(TEST_CASE_PRIORITIES, rows, (r) => r.priority).map(({ key, count }) => ({ priority: key, count }))
}

export async function countOpenBugs(): Promise<number> {
  const rows = await db.$queryRaw<{ total: number | bigint }[]>`
    SELECT COUNT(*) AS total FROM bugs
    WHERE status IN (${Prisma.join(OPEN_BUG_STATUSES)})`
  return Number(rows[0]?.total ?? 0)
}

/** Every legal severity with an explicit count (zero-filled). */
export async function summarizeBugsBySeverity(): Promise<SeverityCountSqlRow[]> {
  const rows = await db.$queryRaw<{ severity: string; count: number | bigint }[]>`
    SELECT severity, COUNT(*) AS \`count\` FROM bugs
    GROUP BY severity ORDER BY severity`
  return fillCounts(BUG_SEVERITIES, rows, (r) => r.severity).map(({ key, count }) => ({ severity: key, count }))
}

/** Every legal bug status with an explicit count (zero-filled). */
export async function summarizeBugsByStatus(): Promise<StatusCountSqlRow[]> {
  const rows = await db.$queryRaw<{ status: string; count: number | bigint }[]>`
    SELECT status, COUNT(*) AS \`count\` FROM bugs
    GROUP BY status ORDER BY status`
  return fillCounts(BUG_STATUSES, rows, (r) => r.status).map(({ key, count }) => ({ status: key, count }))
}

/** Review requests assigned to `reviewerId` that are still pending/in_progress
 *  — the dashboard's myPendingReviews counter (legacy WHERE preserved). */
export async function countPendingReviewsForReviewer(reviewerId: string): Promise<number> {
  const rows = await db.$queryRaw<{ total: number | bigint }[]>`
    SELECT COUNT(*) AS total FROM review_requests
    WHERE reviewer_id = ${reviewerId}
      AND status IN (${Prisma.join(PENDING_REVIEW_STATUSES)})`
  return Number(rows[0]?.total ?? 0)
}
