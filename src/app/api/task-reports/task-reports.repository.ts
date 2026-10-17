// Task-report repository — raw SQL data access for task_reports.
// Contains ONLY data access: no permission checks, no upsert policy, no HTTP.

import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { insertReturningId } from '@/lib/server/insert'
import type { TaskReportSqlRow } from '@/types/sql-rows'

/** Standard JOIN select — task report plus its reportedBy user ref. */
const TASK_REPORT_SELECT = Prisma.sql`
  SELECT tr.*,
    ru.user_id AS reported_by_user_id, ru.full_name AS reported_by_full_name, ru.avatar_url AS reported_by_avatar_url
  FROM task_reports tr
  LEFT JOIN users ru ON ru.user_id = tr.reported_by_id`

export interface TaskReportFilters {
  reportedById?: string
  dateFrom?: Date
  dateTo?: Date
  moduleId?: string
}

function buildWhere(filters: TaskReportFilters): Prisma.Sql {
  const parts: Prisma.Sql[] = []
  if (filters.reportedById) parts.push(Prisma.sql`tr.reported_by_id = ${filters.reportedById}`)
  if (filters.dateFrom) parts.push(Prisma.sql`tr.report_date >= ${filters.dateFrom}`)
  if (filters.dateTo) parts.push(Prisma.sql`tr.report_date <= ${filters.dateTo}`)
  // Reports with at least one task line linked to this module: exact object match on
  // the line's moduleId (ids are digit strings, so "5" never matches "15"). The old
  // scalar JSON_CONTAINS never matched the task objects at all (Phase 5 fix).
  if (filters.moduleId) parts.push(Prisma.sql`JSON_CONTAINS(tr.tasks, JSON_OBJECT('moduleId', ${String(filters.moduleId)}))`)
  return parts.length ? Prisma.sql`WHERE ${Prisma.join(parts, ' AND ')}` : Prisma.empty
}

export async function countTaskReports(filters: TaskReportFilters): Promise<number> {
  const rows = await db.$queryRaw<{ total: number | bigint }[]>`
    SELECT COUNT(*) AS total FROM task_reports tr ${buildWhere(filters)}`
  return Number(rows[0]?.total ?? 0)
}

export async function listTaskReports(
  filters: TaskReportFilters,
  limit: number,
  offset: number
): Promise<TaskReportSqlRow[]> {
  return db.$queryRaw<TaskReportSqlRow[]>(Prisma.sql`
    ${TASK_REPORT_SELECT} ${buildWhere(filters)}
    ORDER BY tr.report_date DESC
    LIMIT ${limit} OFFSET ${offset}`)
}

export async function listTaskReportsByUser(userId: string): Promise<TaskReportSqlRow[]> {
  return db.$queryRaw<TaskReportSqlRow[]>(Prisma.sql`
    ${TASK_REPORT_SELECT}
    WHERE tr.reported_by_id = ${userId}
    ORDER BY tr.report_date DESC`)
}

export async function findTaskReportById(taskReportId: string): Promise<TaskReportSqlRow | null> {
  const rows = await db.$queryRaw<TaskReportSqlRow[]>`
    ${TASK_REPORT_SELECT} WHERE tr.task_report_id = ${taskReportId} LIMIT 1`
  return rows[0] ?? null
}

/** Exact (reported_by_id, report_date) lookup backing the legacy upsert —
 *  mirrors the unique index on (reported_by_id, report_date). */
export async function findTaskReportByUserAndDate(
  reportedById: string,
  reportDate: Date
): Promise<TaskReportSqlRow | null> {
  const rows = await db.$queryRaw<TaskReportSqlRow[]>`
    ${TASK_REPORT_SELECT}
    WHERE tr.reported_by_id = ${reportedById} AND tr.report_date = ${reportDate}
    LIMIT 1`
  return rows[0] ?? null
}

export interface TaskReportInsert {
  reportedById: string
  reportDate: Date
  tasks: unknown
  notes: string | null
  totalMinutes: number
}

export async function insertTaskReport(input: TaskReportInsert): Promise<TaskReportSqlRow> {
  // MySQL has no RETURNING: insert, take the new key from LAST_INSERT_ID(), then read back.
  const taskReportId = await insertReturningId(Prisma.sql`
    INSERT INTO task_reports
      (reported_by_id, report_date, tasks, notes, total_minutes, created_at, updated_at)
    VALUES
      (${input.reportedById}, ${input.reportDate}, CAST(${JSON.stringify(input.tasks)} AS JSON),
       ${input.notes}, ${input.totalMinutes}, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`)
  const created = await findTaskReportById(taskReportId)
  if (!created) throw new Error('Inserted task report could not be read back')
  return created
}

export interface TaskReportUpdateFields {
  tasks?: unknown
  notes?: string | null
  totalMinutes?: number
}

/** Partial UPDATE — every write also bumps updated_at (raw SQL skips @updatedAt). */
export async function updateTaskReport(
  taskReportId: string,
  fields: TaskReportUpdateFields
): Promise<TaskReportSqlRow> {
  const sets: Prisma.Sql[] = []
  if (fields.tasks !== undefined) sets.push(Prisma.sql`tasks = CAST(${JSON.stringify(fields.tasks)} AS JSON)`)
  if (fields.notes !== undefined) sets.push(Prisma.sql`notes = ${fields.notes}`)
  if (fields.totalMinutes !== undefined) sets.push(Prisma.sql`total_minutes = ${fields.totalMinutes}`)
  sets.push(Prisma.sql`updated_at = UTC_TIMESTAMP(3)`)

  await db.$executeRaw`
    UPDATE task_reports SET ${Prisma.join(sets)} WHERE task_report_id = ${taskReportId}`
  const updated = await findTaskReportById(taskReportId)
  if (!updated) throw new Error('Updated task report could not be read back')
  return updated
}

// ---------- Summary aggregate ----------

export interface TaskReportSummarySqlRow {
  reported_by_id: string
  full_name: string // guaranteed non-null: reported_by_id FK-cascades to users
  total_minutes: number
  days: number
}

/** Per-user totals over an inclusive [from, to] report_date range.
 *  SUM/COUNT may arrive as bigint under MySQL — normalized to number here. */
export async function summarizeTaskReportsByUser(
  from: Date,
  to: Date
): Promise<TaskReportSummarySqlRow[]> {
  const rows = await db.$queryRaw<{ reported_by_id: string; full_name: string; total_minutes: number | bigint; days: number | bigint }[]>`
    SELECT tr.reported_by_id, u.full_name,
           SUM(tr.total_minutes) AS total_minutes, COUNT(*) AS days
    FROM task_reports tr
    LEFT JOIN users u ON u.user_id = tr.reported_by_id
    WHERE tr.report_date >= ${from} AND tr.report_date <= ${to}
    GROUP BY tr.reported_by_id, u.full_name`
  return rows.map((r) => ({
    reported_by_id: r.reported_by_id,
    full_name: r.full_name,
    total_minutes: Number(r.total_minutes ?? 0),
    days: Number(r.days ?? 0),
  }))
}

/** All reports with report_date >= since — feeds the stats weekly-hours
 *  aggregation. Legacy had no ORDER BY (undefined order); report_date ASC
 *  makes the weekly bucket order deterministic. */
export async function listTaskReportsSince(since: Date): Promise<TaskReportSqlRow[]> {
  return db.$queryRaw<TaskReportSqlRow[]>`
    ${TASK_REPORT_SELECT}
    WHERE tr.report_date >= ${since}
    ORDER BY tr.report_date ASC`
}
