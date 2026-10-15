// Task-report service — business logic and orchestration.
//
// Owns: permission checks (view_all_task_reports / create_task_report), the
// upsert-by-(user, date) policy, totalMinutes recalculation, ownership rules,
// activity logging and serialization. Data access goes exclusively through
// the repository; responses are produced exclusively through the serializer.

import type { RequestMeta } from '@/lib/activity'
import { ApiError, getPagination, paginate, type PaginatedResponse } from '@/lib/api'
import { can, ensurePermission, type SessionUser } from '@/lib/auth'
import { logActivity, parseJson } from '@/lib/activity'
import { logger } from '@/lib/logger'
import { createNotification } from '@/lib/notifications'
import { listActiveUsersHoldingPermission } from '@/lib/server/user.repository'
import {
  serializeTaskReport,
  type SerializedTaskReport,
  type TaskItem,
} from '@/lib/serializers'
import {
  countTaskReports,
  findTaskReportById,
  findTaskReportByUserAndDate,
  insertTaskReport,
  listTaskReports,
  listTaskReportsByUser,
  summarizeTaskReportsByUser,
  updateTaskReport,
  type TaskReportFilters,
} from './task-reports.repository'
import type { UpdateTaskReportInput, UpsertTaskReportInput } from './task-reports.validation'

// ---------- Queries ----------

export interface TaskReportSummaryUser {
  userId: string
  userName: string
  totalMinutes: number
  days: number
  hours: number
}

export interface TaskReportSummary {
  range: { from: Date; to: Date }
  users: TaskReportSummaryUser[]
}

/** GET ?action=summary — per-user totals over the date range.
 *  Legacy defaults preserved: the last 30 days up to now; both bounds inclusive. */
export async function getTaskReportSummary(
  me: SessionUser,
  q: Record<string, string>
): Promise<TaskReportSummary> {
  if (!can(me.role, 'view_all_task_reports')) throw ApiError.forbidden('Only roles with view-all-reports rights (VP / Manager)')
  const from = q.dateFrom ? new Date(q.dateFrom) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const to = q.dateTo ? new Date(q.dateTo) : new Date()
  const rows = await summarizeTaskReportsByUser(from, to)
  return {
    range: { from, to },
    users: rows.map((row) => ({
      userId: row.reported_by_id,
      userName: row.full_name,
      totalMinutes: row.total_minutes,
      days: row.days,
      hours: Number((row.total_minutes / 60).toFixed(2)),
    })),
  }
}

/** GET ?action=my — the current user's own reports, newest first. */
export async function getMyTaskReports(me: SessionUser): Promise<SerializedTaskReport[]> {
  const rows = await listTaskReportsByUser(me.userId)
  return rows.map(serializeTaskReport)
}

/** GET ?id=... — single report; owners always, others need view_all_task_reports. */
export async function getTaskReport(me: SessionUser, taskReportId: string): Promise<SerializedTaskReport> {
  const report = await findTaskReportById(taskReportId)
  if (!report) throw ApiError.notFound('Report not found')
  if (report.reported_by_id !== me.userId && !can(me.role, 'view_all_task_reports')) {
    throw ApiError.forbidden('You can only view your own reports')
  }
  return serializeTaskReport(report)
}

/** GET (list) — paginated, report_date DESC.
 *  Legacy visibility rule: only holders of view_all_task_reports may filter by
 *  userId (or see everyone); everyone else is locked to their own reports. */
export async function listTaskReportsPaginated(
  me: SessionUser,
  q: Record<string, string>
): Promise<PaginatedResponse<SerializedTaskReport>> {
  const canViewAll = can(me.role, 'view_all_task_reports')
  const filters: TaskReportFilters = {
    reportedById: canViewAll ? q.userId : me.userId,
    dateFrom: q.dateFrom ? new Date(q.dateFrom) : undefined,
    dateTo: q.dateTo ? new Date(q.dateTo) : undefined,
    moduleId: q.moduleId,
  }
  const { page, pageSize, offset } = getPagination(q, 50)
  const [total, rows] = await Promise.all([
    countTaskReports(filters),
    listTaskReports(filters, pageSize, offset),
  ])
  return paginate(rows.map(serializeTaskReport), total, page, pageSize)
}

export interface MonthlyExportPayload {
  user: { userId: string; fullName: string }
  month: string
  reports: SerializedTaskReport[]
}

/** GET ?action=export&userId=&month=YYYY-MM — every daily report of one user
 *  inside one month, for the client-side monthly report builder (CSV/PDF).
 *  Visibility: view_all_task_reports holders may export anyone; everyone else
 *  is silently locked to their own data (no error leak, no user enumeration). */
export async function exportMonthlyTaskReports(
  me: SessionUser,
  q: Record<string, string>
): Promise<MonthlyExportPayload> {
  if (!/^\d{4}-\d{2}$/.test(q.month ?? '')) {
    throw ApiError.badRequest('month is required in YYYY-MM format')
  }
  const canViewAll = can(me.role, 'view_all_task_reports')
  const userId = canViewAll && q.userId ? q.userId : me.userId

  // Inclusive month window in UTC: from = first day 00:00:00, to = the last
  // second of the month (built by subtracting one second from the next month).
  const [year, monthIdx] = q.month.split('-').map(Number)
  const from = new Date(Date.UTC(year, monthIdx - 1, 1))
  const to = new Date(Date.UTC(year, monthIdx, 1))
  to.setUTCSeconds(to.getUTCSeconds() - 1)

  const rows = await listTaskReports(
    { reportedById: userId, dateFrom: from, dateTo: to },
    500, // a month holds at most 31 daily reports — generous safety cap
    0
  )
  const serialized = rows.map(serializeTaskReport)
  const owner = serialized[0]?.reportedBy
  return {
    user: { userId, fullName: owner?.fullName ?? me.fullName },
    month: q.month,
    reports: serialized,
  }
}

// ---------- Commands ----------

function sumTaskMinutes(tasks: { timeSpentMinutes: number }[]): number {
  return tasks.reduce((sum, t) => sum + t.timeSpentMinutes, 0)
}

/** Fan a daily work-log submission out to every view_all_task_reports holder
 *  (except the author) — managers/VP see WHAT was done without polling.
 *  createNotification never throws and per-holder failures are isolated. */
async function notifyReportHolders(
  me: SessionUser,
  reportId: string,
  reportDate: Date,
  taskCount: number,
  totalMinutes: number,
  verb: 'submitted' | 'updated'
): Promise<void> {
  const holders = await listActiveUsersHoldingPermission('view_all_task_reports')
  const recipients = holders.filter((h) => h.user_id !== me.userId)
  if (recipients.length === 0) return
  const date = reportDate.toISOString().slice(0, 10)
  const hours = Math.floor(totalMinutes / 60)
  const duration = hours > 0 ? `${hours}h ${totalMinutes % 60}m` : `${totalMinutes % 60}m`
  await Promise.all(
    recipients.map((holder) =>
      createNotification({
        userId: holder.user_id,
        type: 'daily_report_submitted',
        title: `Daily work log ${verb}`,
        body: `${me.fullName} ${verb} their work log for ${date} — ${taskCount} task(s), ${duration} total.`,
        entityType: 'task_report',
        entityId: reportId,
      })
    )
  )
}

/** POST — upsert the current user's report for reportDate (legacy upsert policy:
 *  one report per user per date; UPDATE when it exists, INSERT otherwise). */
export async function upsertTaskReport(
  me: SessionUser,
  input: UpsertTaskReportInput,
  meta: RequestMeta
): Promise<SerializedTaskReport> {
  ensurePermission(me, 'create_task_report', 'Insufficient role')
  const reportDate = new Date(input.reportDate)
  const tasks = input.tasks
  const totalMinutes = sumTaskMinutes(tasks)
  const notes = input.notes ?? null

  const existing = await findTaskReportByUserAndDate(me.userId, reportDate)
  if (existing) {
    const updated = await updateTaskReport(existing.task_report_id, { tasks, notes, totalMinutes })
    await logActivity({
      userId: me.userId,
      action: 'UPDATE',
      entityType: 'task_report',
      entityId: updated.task_report_id,
      entityName: reportDate.toISOString().slice(0, 10),
      before: { totalMinutes: existing.total_minutes },
      after: { totalMinutes },
      meta,
    })
    logger.info('Task report updated via upsert', {
      taskReportId: updated.task_report_id,
      reportDate,
      totalMinutes,
      by: me.userId,
    })
    await notifyReportHolders(me, updated.task_report_id, reportDate, tasks.length, totalMinutes, 'updated')
    return serializeTaskReport(updated)
  }

  const created = await insertTaskReport({
    reportedById: me.userId,
    reportDate,
    tasks,
    notes,
    totalMinutes,
  })
  await logActivity({
    userId: me.userId,
    action: 'CREATE',
    entityType: 'task_report',
    entityId: created.task_report_id,
    entityName: reportDate.toISOString().slice(0, 10),
    after: { totalMinutes },
    meta,
  })
  logger.info('Task report created', {
    taskReportId: created.task_report_id,
    reportDate,
    totalMinutes,
    by: me.userId,
  })
  await notifyReportHolders(me, created.task_report_id, reportDate, tasks.length, totalMinutes, 'submitted')
  return serializeTaskReport(created)
}

/** PUT ?id=... — update an OWN report (legacy has no admin override here).
 *  Omitted tasks keep the stored ones; notes fall back to the stored value;
 *  a reportDate in the body is accepted but ignored (legacy behavior).
 *  totalMinutes is always recalculated from the resulting task list.
 *  Requires create_task_report (same gate as POST), checked before the lookup so a missing id does not reveal existence. */
export async function updateTaskReportFields(
  me: SessionUser,
  taskReportId: string,
  input: UpdateTaskReportInput,
  meta: RequestMeta
): Promise<SerializedTaskReport> {
  ensurePermission(me, 'create_task_report', 'Insufficient role')
  const existing = await findTaskReportById(taskReportId)
  if (!existing) throw ApiError.notFound('Report not found')
  if (existing.reported_by_id !== me.userId) {
    throw ApiError.forbidden('You can only edit your own reports')
  }

  const tasks: TaskItem[] | UpsertTaskReportInput['tasks'] =
    input.tasks ?? parseJson<TaskItem[]>(existing.tasks, [])
  const totalMinutes = sumTaskMinutes(tasks)
  const updated = await updateTaskReport(taskReportId, {
    tasks,
    notes: input.notes !== undefined ? input.notes : existing.notes,
    totalMinutes,
  })
  await logActivity({
    userId: me.userId,
    action: 'UPDATE',
    entityType: 'task_report',
    entityId: taskReportId,
    entityName: existing.report_date.toISOString().slice(0, 10),
    before: { totalMinutes: existing.total_minutes },
    after: { totalMinutes },
    meta,
  })
  logger.info('Task report updated', {
    taskReportId,
    totalMinutes,
    by: me.userId,
  })
  return serializeTaskReport(updated)
}
