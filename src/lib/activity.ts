// Activity logging service + JSON helpers.
//
// logActivity() records WHO changed WHAT (before/after snapshots + diff) into
// the activity_logs table via its repository. It is a fire-and-forget side
// effect: a logging failure must NEVER break the main operation, so errors
// are swallowed and logged instead of rethrown.

import { logger } from './logger'
import { invalidateCache } from './server/cache'
import { insertActivityLog } from './server/activity-log.repository'

/** Plain client metadata extracted by the controller (src/lib/api.ts).
 *  Keeps HTTP request types out of the service layer. */
export interface RequestMeta {
  ip: string | null
  userAgent: string | null
}

export interface ActivityLogInput {
  userId: string | null
  action: string
  entityType: string
  entityId?: string | null
  entityName?: string | null
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  meta?: RequestMeta | null
}

function computeDiff(
  before?: Record<string, unknown> | null,
  after?: Record<string, unknown> | null
): Record<string, { before: unknown; after: unknown }> | null {
  if (!before && !after) return null
  if (!before) return Object.fromEntries(Object.entries(after ?? {}).map(([k, v]) => [k, { before: null, after: v }]))
  if (!after) return Object.fromEntries(Object.entries(before ?? {}).map(([k, v]) => [k, { before: v, after: null }]))
  const diff: Record<string, { before: unknown; after: unknown }> = {}
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of keys) {
    const b = before[key]
    const a = after[key]
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      diff[key] = { before: b, after: a }
    }
  }
  return Object.keys(diff).length ? diff : null
}

export async function logActivity(input: ActivityLogInput): Promise<void> {
  try {
    await insertActivityLog({
      userId: input.userId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      entityName: input.entityName ?? null,
      beforeSnapshot: input.before ?? null,
      afterSnapshot: input.after ?? null,
      diff: computeDiff(input.before, input.after),
      ipAddress: input.meta?.ip ?? null,
      userAgent: input.meta?.userAgent ?? null,
    })
    // CACHE INVALIDATION (single write-side hook): every mutating service logs
    // its successful writes here, so dropping the stats aggregate keys here
    // guarantees the dashboard/reports read fresh numbers right after ANY
    // write. Reload cost is one cheap indexed COUNT/GROUP-BY set. If the log
    // insert itself failed the main operation failed too, so no invalidation
    // is correct in that path; the 5s stats TTL remains the safety net.
    invalidateCache('stats:')
  } catch (err) {
    // Activity logging must never break the main operation.
    logger.error('Failed to write activity log', err, { action: input.action, entityType: input.entityType })
  }
}

// JSON helper for JSON columns: MySQL JSON columns usually come back as parsed
// JS objects, but legacy rows (or hand-edited data) may hold JSON strings.
// parseJson() accepts both shapes and always returns a usable value.
export function parseJson<T = unknown>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback
  // Already an object/array (JSON column output) — return as-is.
  if (typeof value === 'object') return value as T
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return fallback
    }
  }
  return fallback
}
