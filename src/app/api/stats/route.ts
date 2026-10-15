// Controller for /api/stats — thin HTTP adapter.
// Parses the request, delegates to the validator + services, returns responses.
// NO business logic and NO SQL live here.

import type { NextRequest } from 'next/server'
import { withApi, ok, ApiError, getQueryParams } from '@/lib/api'
import { requireUser } from '@/lib/auth'
import { getDashboardStats, getReportsStats } from './stats.service'
import { validateStatsActionQuery } from './stats.validation'

/** GET /api/stats?action=dashboard -> DashboardStats (current user's counters)
 *  GET /api/stats?action=reports   -> ReportsStats (view_all_task_reports)
 *  anything else                   -> 400 'Unknown action'
 *                                     (charter §6.3 — legacy answered 200) */
export async function GET(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const { action } = validateStatsActionQuery(getQueryParams(req))
    if (action === 'dashboard') return ok(await getDashboardStats(me))
    if (action === 'reports') return ok(await getReportsStats(me))
    throw ApiError.badRequest('Unknown action')
  })
}
