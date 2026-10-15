// Controller for /api/task-reports — thin HTTP adapter.
// Parses the request, delegates to validators + services, returns responses.
// NO business logic and NO SQL live here.

import type { NextRequest } from 'next/server'
import { withApi, ok, ApiError, getQueryParams, extractRequestMeta } from '@/lib/api'
import { requireUser } from '@/lib/auth'
import {
  getMyTaskReports,
  getTaskReport,
  getTaskReportSummary,
  exportMonthlyTaskReports,
  listTaskReportsPaginated,
  updateTaskReportFields,
  upsertTaskReport,
} from './task-reports.service'
import {
  validateUpdateTaskReportBody,
  validateUpsertTaskReportBody,
} from './task-reports.validation'

/** GET /api/task-reports?action=summary&dateFrom=&dateTo= -> per-user aggregate
 *                                                          (view_all_task_reports)
 *  GET /api/task-reports?action=export&userId=&month=YYYY-MM -> one user's
 *                                                          month for download
 *  GET /api/task-reports?action=my                        -> current user's reports
 *  GET /api/task-reports?id=...                           -> single report (owner
 *                                                          or view_all_task_reports)
 *  GET /api/task-reports                                  -> paginated list
 *                                                          (non-senior users: own only) */
export async function GET(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const q = getQueryParams(req)
    if (q.action === 'summary') return ok(await getTaskReportSummary(me, q))
    if (q.action === 'export') return ok(await exportMonthlyTaskReports(me, q))
    if (q.action === 'my') return ok(await getMyTaskReports(me))
    if (q.id) return ok(await getTaskReport(me, q.id))
    return ok(await listTaskReportsPaginated(me, q))
  })
}

/** POST /api/task-reports -> upsert the current user's report for reportDate */
export async function POST(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const body = await req.json().catch(() => ({}))
    const input = validateUpsertTaskReportBody(body)
    return ok(await upsertTaskReport(me, input, extractRequestMeta(req)))
  })
}

/** PUT /api/task-reports?id=... -> update an own report (recalculates totalMinutes) */
export async function PUT(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const { id } = getQueryParams(req)
    if (!id) throw ApiError.badRequest('Missing report id')
    const body = await req.json().catch(() => ({}))
    const input = validateUpdateTaskReportBody(body)
    return ok(await updateTaskReportFields(me, id, input, extractRequestMeta(req)))
  })
}
