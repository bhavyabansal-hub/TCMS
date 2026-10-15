// Stats service — orchestration + assembly of the DashboardStats / ReportsStats
// payloads (frozen contract in @/types). Pure read aggregation: no writes, no
// notifications; the only permission gate is the legacy view_all_task_reports
// check on the reports action.

import { can, ensurePermission, type SessionUser } from '@/lib/auth'
import { serializeActivityLog, type SerializedActivityLog } from '@/lib/serializers'
import { withCache } from '@/lib/server/cache'
import type { DashboardStats, ReportsStats } from '@/types'
import {
  countOpenBugs,
  countPendingReviewsForReviewer,
  countTotalTestCases,
  summarizeBugsBySeverity,
  summarizeBugsByStatus,
  summarizeTestCasesByPriority,
  summarizeTestCasesByStatus,
  type SeverityCountSqlRow,
  type StatusCountSqlRow,
  type PriorityCountSqlRow,
} from './stats.repository'
import { listRecentActivityLogs } from '../activity-logs/activity-logs.repository'
import { listTaskReportsSince } from '../task-reports/task-reports.repository'

/** Legacy dashboard recent-activity take. */
const RECENT_ACTIVITY_LIMIT = 10
/** Legacy reports window — task reports of the last 30 days feed weeklyHours. */
const REPORTS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/** CACHING (design principle): the six global aggregates behind dashboard AND
 *  reports are pure COUNT/GROUP-BY reads that every user re-requests on every
 *  page view. They are cached under ONE key with promise coalescing (a burst
 *  of hits = ONE query set) and invalidated by logActivity after every write,
 *  so values are fresh right after any mutation. The 5s TTL is only a safety
 *  net for unlogged edge paths. Per-user values (myPendingReviews) and large
 *  per-user lists (recentActivity, weeklyHours) are NEVER cached. */
const STATS_CACHE_TTL_MS = 5_000
const STATS_AGGREGATES_KEY = 'stats:global-aggregates'

interface GlobalAggregates {
  totalTestCases: number
  testCaseStatusCounts: StatusCountSqlRow[]
  testCasePriorityCounts: PriorityCountSqlRow[]
  openBugs: number
  bugSeverityCounts: SeverityCountSqlRow[]
  bugStatusCounts: StatusCountSqlRow[]
}

async function getGlobalAggregates(): Promise<GlobalAggregates> {
  return withCache(STATS_AGGREGATES_KEY, STATS_CACHE_TTL_MS, async () => {
    const [totalTestCases, testCaseStatusCounts, testCasePriorityCounts, openBugs, bugSeverityCounts, bugStatusCounts] =
      await Promise.all([
        countTotalTestCases(),
        summarizeTestCasesByStatus(),
        summarizeTestCasesByPriority(),
        countOpenBugs(),
        summarizeBugsBySeverity(),
        summarizeBugsByStatus(),
      ])
    return { totalTestCases, testCaseStatusCounts, testCasePriorityCounts, openBugs, bugSeverityCounts, bugStatusCounts }
  })
}

// Same shape as the frozen DashboardStats contract; recentActivity carries the
// serializer-layer SerializedActivityLog (createdAt: Date is ISO-stringified by
// the JSON boundary exactly like the legacy Prisma response).
type DashboardStatsPayload = Omit<DashboardStats, 'recentActivity'> & {
  recentActivity: SerializedActivityLog[]
  bugStatusBreakdown?: { status: string; count: number }[]
  priorityBreakdown?: { priority: string; count: number }[]
}

export async function getDashboardStats(me: SessionUser): Promise<DashboardStatsPayload> {
  // AUDIT FIX (2026-10-09): the dashboard used to hand EVERY authenticated
  // user the global activity feed — rows carry IP, user-agent and full
  // before/after snapshots. Users without view_activity_logs now get only
  // their OWN recent rows; permission holders keep the full feed.
  const activityFilters = can(me.role, 'view_activity_logs') ? undefined : { userId: me.userId }
  const [aggregates, myPendingReviews, recentActivity] = await Promise.all([
    getGlobalAggregates(),
    countPendingReviewsForReviewer(me.userId),
    listRecentActivityLogs(RECENT_ACTIVITY_LIMIT, activityFilters),
  ])
  return {
    totalTestCases: aggregates.totalTestCases,
    statusBreakdown: aggregates.testCaseStatusCounts.map((row) => ({ status: row.status, count: row.count })),
    openBugs: aggregates.openBugs,
    severityBreakdown: aggregates.bugSeverityCounts.map((row) => ({ severity: row.severity, count: row.count })),
    // Additive Command Center aggregates — both already computed by the
    // shared aggregate query, so exposing them costs zero extra round trips.
    bugStatusBreakdown: aggregates.bugStatusCounts.map((row) => ({ status: row.status, count: row.count })),
    priorityBreakdown: aggregates.testCasePriorityCounts.map((row) => ({ priority: row.priority, count: row.count })),
    myPendingReviews,
    recentActivity: recentActivity.map(serializeActivityLog),
  }
}

export async function getReportsStats(me: SessionUser): Promise<ReportsStats> {
  ensurePermission(me, 'view_all_task_reports', 'Only roles with view-all-reports rights (VP / Manager)')
  const since = new Date(Date.now() - REPORTS_WINDOW_MS)
  const [aggregates, reports] = await Promise.all([getGlobalAggregates(), listTaskReportsSince(since)])

  // Legacy weekly bucketing, ported verbatim: a week starts on Sunday (the
  // report's day-of-week is subtracted in LOCAL time), buckets are keyed by
  // `user|week-start`, and first-seen map insertion order is preserved.
  const weeklyMap = new Map<string, { user: string; week: string; minutes: number }>()
  for (const r of reports) {
    const d = new Date(r.report_date)
    const weekStart = new Date(d)
    weekStart.setDate(d.getDate() - d.getDay())
    const week = weekStart.toISOString().slice(0, 10)
    // reported_by_id FK-cascades to users, so the joined name is always there.
    const user = r.reported_by_full_name ?? ''
    const key = `${user}|${week}`
    const existing = weeklyMap.get(key) ?? { user, week, minutes: 0 }
    existing.minutes += r.total_minutes
    weeklyMap.set(key, existing)
  }

  return {
    testCasesByStatus: aggregates.testCaseStatusCounts.map((row) => ({ status: row.status, count: row.count })),
    testCasesByPriority: aggregates.testCasePriorityCounts.map((row) => ({ priority: row.priority, count: row.count })),
    bugsByStatus: aggregates.bugStatusCounts.map((row) => ({ status: row.status, count: row.count })),
    weeklyHours: Array.from(weeklyMap.values()).map((v) => ({
      user: v.user,
      week: v.week,
      hours: +(v.minutes / 60).toFixed(2),
    })),
  }
}
