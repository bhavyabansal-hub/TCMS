// Controller for /api/activity-logs — thin HTTP adapter.
// Parses the request, delegates to validators + services, returns responses.
// NO business logic and NO SQL live here.

import type { NextRequest } from 'next/server'
import { withApi, ok, getQueryParams } from '@/lib/api'
import { requireUser } from '@/lib/auth'
import {
  getEntityActivityLogs,
  getUserActivityLogs,
  listActivityLogsPaginated,
} from './activity-logs.service'
import {
  validateActivityLogListQuery,
  validateEntityActivityQuery,
  validateUserActivityQuery,
} from './activity-logs.validation'

/** GET /api/activity-logs?action=entity&type=<entityType>&id=<entityId>
 *                                     -> last 50 logs for that entity (auth only)
 *  GET /api/activity-logs?action=user&id=<userId>
 *                                     -> last 50 logs by that user (404 unknown)
 *  GET /api/activity-logs[&any other params]
 *                                     -> paginated list (view_activity_logs).
 *  Legacy dispatch preserved: only the two named actions divert; anything else
 *  (including action=entity without type/id, or an unknown action) falls
 *  through to the gated list. */
export async function GET(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const q = getQueryParams(req)
    if (q.action === 'entity' && q.type && q.id) {
      const input = validateEntityActivityQuery(q)
      return ok(await getEntityActivityLogs(me, input.type, input.id))
    }
    if (q.action === 'user' && q.id) {
      const input = validateUserActivityQuery(q)
      return ok(await getUserActivityLogs(me, input.id))
    }
    return ok(await listActivityLogsPaginated(me, validateActivityLogListQuery(q)))
  })
}
