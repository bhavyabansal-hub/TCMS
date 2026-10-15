// Activity-logs service — business logic for the activity feed endpoints.
//
// Owns: the view_activity_logs permission gate on the paginated feed, the
// user-existence rule for the per-user feed, filter assembly and
// serialization. Data access goes exclusively through the resource
// repository; responses are produced exclusively through serializeActivityLog.

import { ApiError, getPagination, paginate, type PaginatedResponse } from '@/lib/api'
import { ensurePermission, type SessionUser } from '@/lib/auth'
import { serializeActivityLog, type SerializedActivityLog } from '@/lib/serializers'
import {
  countActivityLogs,
  findUserExists,
  listActivityLogs,
  listRecentActivityLogs,
  type ActivityLogFilters,
} from './activity-logs.repository'

/** Legacy take: both scoped feeds (entity / user) return the last 50 logs. */
const RECENT_ACTIVITY_LIMIT = 50

/** GET ?action=entity&type=...&id=... — last 50 logs for one entity, newest
 *  first. AUDIT FIX (2026-10-09): these scoped feeds used to be auth-only
 *  (legacy) and leaked IP/user-agent/snapshots to ANY signed-in user — they
 *  now require the same view_activity_logs permission as the main feed. */
export async function getEntityActivityLogs(
  me: SessionUser,
  entityType: string,
  entityId: string
): Promise<SerializedActivityLog[]> {
  ensurePermission(me, 'view_activity_logs', 'Only roles with view-activity-log rights (VP / Manager)')
  const rows = await listRecentActivityLogs(RECENT_ACTIVITY_LIMIT, { entityType, entityId })
  return rows.map(serializeActivityLog)
}

/** GET ?action=user&id=... — last 50 logs authored by one user, newest first.
 *  404 when the user does not exist (legacy message preserved). Same
 *  view_activity_logs gate as the entity feed (audit fix 2026-10-09). */
export async function getUserActivityLogs(
  me: SessionUser,
  userId: string
): Promise<SerializedActivityLog[]> {
  ensurePermission(me, 'view_activity_logs', 'Only roles with view-activity-log rights (VP / Manager)')
  if (!(await findUserExists(userId))) throw ApiError.notFound('User not found')
  const rows = await listRecentActivityLogs(RECENT_ACTIVITY_LIMIT, { userId })
  return rows.map(serializeActivityLog)
}

/** GET (default — also the legacy fall-through for unknown/unpaired actions) —
 *  paginated, filtered activity feed. Requires view_activity_logs (legacy
 *  message 'Team lead or admin only'). Empty-string filters count as absent
 *  (legacy truthy-check tolerance); date bounds arrive validated. */
export async function listActivityLogsPaginated(
  me: SessionUser,
  q: Record<string, string>
): Promise<PaginatedResponse<SerializedActivityLog>> {
  ensurePermission(me, 'view_activity_logs', 'Only roles with view-activity-log rights (VP / Manager)')
  const filters: ActivityLogFilters = {
    userId: q.userId,
    entityType: q.entityType,
    action: q.action,
    dateFrom: q.dateFrom ? new Date(q.dateFrom) : undefined,
    dateTo: q.dateTo ? new Date(q.dateTo) : undefined,
  }
  const { page, pageSize, offset } = getPagination(q, 50)
  const [total, rows] = await Promise.all([
    countActivityLogs(filters),
    listActivityLogs(filters, pageSize, offset),
  ])
  return paginate(rows.map(serializeActivityLog), total, page, pageSize)
}
