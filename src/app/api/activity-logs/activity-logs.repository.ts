// Activity-logs repository — raw SQL access to activity_logs.
// Shared resource boundary: the activity-logs resource owns queries here, and
// the stats resource (dashboard recent activity) reads through it too.

import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import type { ActivityLogSqlRow } from '@/types/sql-rows'

/** Standard JOIN select — activity log plus acting-user ref. */
const ACTIVITY_SELECT = Prisma.sql`
  SELECT l.*,
    u.user_id AS user_user_id, u.full_name AS user_full_name, u.avatar_url AS user_avatar_url
  FROM activity_logs l
  LEFT JOIN users u ON u.user_id = l.user_id`

export interface ActivityLogFilters {
  userId?: string
  entityType?: string
  entityId?: string
  action?: string
  dateFrom?: Date
  dateTo?: Date
}

function buildWhere(filters: ActivityLogFilters): Prisma.Sql {
  const parts: Prisma.Sql[] = []
  if (filters.userId) parts.push(Prisma.sql`l.user_id = ${filters.userId}`)
  if (filters.entityType) parts.push(Prisma.sql`l.entity_type = ${filters.entityType}`)
  if (filters.entityId) parts.push(Prisma.sql`l.entity_id = ${filters.entityId}`)
  if (filters.action) parts.push(Prisma.sql`l.action = ${filters.action}`)
  if (filters.dateFrom) parts.push(Prisma.sql`l.created_at >= ${filters.dateFrom}`)
  if (filters.dateTo) parts.push(Prisma.sql`l.created_at <= ${filters.dateTo}`)
  return parts.length ? Prisma.sql`WHERE ${Prisma.join(parts, ' AND ')}` : Prisma.empty
}

export async function countActivityLogs(filters: ActivityLogFilters): Promise<number> {
  const rows = await db.$queryRaw<{ total: number | bigint }[]>`
    SELECT COUNT(*) AS total FROM activity_logs l ${buildWhere(filters)}`
  return Number(rows[0]?.total ?? 0)
}

export async function listActivityLogs(
  filters: ActivityLogFilters,
  limit: number,
  offset: number
): Promise<ActivityLogSqlRow[]> {
  return db.$queryRaw<ActivityLogSqlRow[]>(Prisma.sql`
    ${ACTIVITY_SELECT} ${buildWhere(filters)}
    ORDER BY l.created_at DESC
    LIMIT ${limit} OFFSET ${offset}`)
}

/** Newest logs, optionally scoped (used for dashboard recent activity). */
export async function listRecentActivityLogs(limit: number, filters: ActivityLogFilters = {}): Promise<ActivityLogSqlRow[]> {
  return db.$queryRaw<ActivityLogSqlRow[]>(Prisma.sql`
    ${ACTIVITY_SELECT} ${buildWhere(filters)}
    ORDER BY l.created_at DESC
    LIMIT ${limit}`)
}

/** Newest logs WITHOUT the heavy JSON snapshots / diff and request metadata — the
 *  dashboard feed shows only action, entity, actor and time (perf audit 2026-10-17). */
export async function listRecentActivitySummaries(limit: number, filters: ActivityLogFilters = {}): Promise<ActivityLogSqlRow[]> {
  return db.$queryRaw<ActivityLogSqlRow[]>(Prisma.sql`
    SELECT l.activity_log_id, l.user_id, l.action, l.entity_type, l.entity_id, l.entity_name, l.created_at,
      NULL AS before_snapshot, NULL AS after_snapshot, NULL AS diff, NULL AS ip_address, NULL AS user_agent,
      u.user_id AS user_user_id, u.full_name AS user_full_name, u.avatar_url AS user_avatar_url
    FROM activity_logs l
    LEFT JOIN users u ON u.user_id = l.user_id
    ${buildWhere(filters)}
    ORDER BY l.created_at DESC
    LIMIT ${limit}`)
}

export async function findUserExists(userId: string): Promise<boolean> {
  // MySQL EXISTS returns 1/0 (bigint) — normalized to a JS boolean here.
  const rows = await db.$queryRaw<{ exists: number | bigint }[]>`
    SELECT EXISTS(SELECT 1 FROM users WHERE user_id = ${userId}) AS \`exists\``
  return Boolean(rows[0]?.exists)
}
