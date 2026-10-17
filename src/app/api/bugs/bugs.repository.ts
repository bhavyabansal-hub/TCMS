// Bug repository — raw SQL data access for bugs and bug_test_case_links.
// Contains ONLY data access: no permission checks, no business conditionals,
// no HTTP concepts.

import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { insertReturningId } from '@/lib/server/insert'
import type { BugSqlRow } from '@/types/sql-rows'

/** Standard JOIN select — bug plus module/reportedBy/assignedTo refs
 *  (alias convention `<relation>_<column>`, consumed by serializeBug). */
const BUG_SELECT = Prisma.sql`
  SELECT b.*,
    m.module_id AS module_module_id, m.name AS module_name,
    rb.user_id AS reported_by_user_id, rb.full_name AS reported_by_full_name, rb.avatar_url AS reported_by_avatar_url,
    asg.user_id AS assigned_to_user_id, asg.full_name AS assigned_to_full_name, asg.avatar_url AS assigned_to_avatar_url
  FROM bugs b
  LEFT JOIN modules m ON m.module_id = b.module_id
  LEFT JOIN users rb ON rb.user_id = b.reported_by_id
  LEFT JOIN users asg ON asg.user_id = b.assigned_to_id`

export interface BugFilters {
  status?: string
  severity?: string
  moduleId?: string
  assignedToId?: string
  reportedById?: string
  search?: string
}

function buildWhere(filters: BugFilters): Prisma.Sql {
  const parts: Prisma.Sql[] = []
  if (filters.status) parts.push(Prisma.sql`b.status = ${filters.status}`)
  if (filters.severity) parts.push(Prisma.sql`b.severity = ${filters.severity}`)
  if (filters.moduleId) parts.push(Prisma.sql`b.module_id = ${filters.moduleId}`)
  if (filters.assignedToId) parts.push(Prisma.sql`b.assigned_to_id = ${filters.assignedToId}`)
  if (filters.reportedById) parts.push(Prisma.sql`b.reported_by_id = ${filters.reportedById}`)
  // LIKE (utf8mb4_unicode_ci) = case-insensitive search (deliberate improvement
  // over the legacy case-sensitive `contains` filter).
  if (filters.search) parts.push(Prisma.sql`b.title LIKE ${`%${filters.search}%`}`)
  return parts.length ? Prisma.sql`WHERE ${Prisma.join(parts, ' AND ')}` : Prisma.empty
}

/** Light picker rows (id + title), newest first — no JSON columns, no joins. */
export async function listBugOptionRows(limit: number): Promise<{ bug_id: string; title: string }[]> {
  return db.$queryRaw<{ bug_id: string; title: string }[]>`
    SELECT bug_id, title FROM bugs ORDER BY created_at DESC LIMIT ${limit}`
}

export async function countBugs(filters: BugFilters): Promise<number> {
  const rows = await db.$queryRaw<{ total: number | bigint }[]>`
    SELECT COUNT(*) AS total FROM bugs b ${buildWhere(filters)}`
  return Number(rows[0]?.total ?? 0)
}

export async function listBugs(
  filters: BugFilters,
  limit: number,
  offset: number
): Promise<BugSqlRow[]> {
  return db.$queryRaw<BugSqlRow[]>(Prisma.sql`
    ${BUG_SELECT} ${buildWhere(filters)}
    ORDER BY b.created_at DESC
    LIMIT ${limit} OFFSET ${offset}`)
}

export async function findBugById(bugId: string): Promise<BugSqlRow | null> {
  const rows = await db.$queryRaw<BugSqlRow[]>`
    ${BUG_SELECT} WHERE b.bug_id = ${bugId} LIMIT 1`
  return rows[0] ?? null
}

export interface BugInsert {
  title: string
  description: string | null
  severity: string
  environment: string | null
  stepsToReproduce: string | null
  expectedBehaviour: string | null
  actualBehaviour: string | null
  moduleId: string | null
  assignedToId: string | null
  reportedById: string
}

export async function insertBug(input: BugInsert): Promise<BugSqlRow> {
  // MySQL has no RETURNING: insert, take the new key from LAST_INSERT_ID(), then read back.
  const bugId = await insertReturningId(Prisma.sql`
    INSERT INTO bugs
      (title, description, severity, status, environment, steps_to_reproduce,
       expected_behaviour, actual_behaviour, reported_by_id, assigned_to_id,
       module_id, attachments, created_at, updated_at)
    VALUES
      (${input.title}, ${input.description}, ${input.severity}, 'open',
       ${input.environment}, ${input.stepsToReproduce}, ${input.expectedBehaviour},
       ${input.actualBehaviour}, ${input.reportedById}, ${input.assignedToId},
       ${input.moduleId}, CAST(${JSON.stringify([])} AS JSON), UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`)
  const created = await findBugById(bugId)
  if (!created) throw new Error('Inserted bug could not be read back')
  return created
}

export interface BugUpdateFields {
  title?: string
  description?: string | null
  severity?: string
  status?: string
  environment?: string | null
  stepsToReproduce?: string | null
  expectedBehaviour?: string | null
  actualBehaviour?: string | null
  moduleId?: string | null
  assignedToId?: string | null
  resolvedAt?: Date | null
}

/** Guarded partial UPDATE — applies only while updated_at still equals
 *  `expectedUpdatedAt` (optimistic lock); returns null when another write landed
 *  first. Every write also bumps updated_at (raw SQL skips @updatedAt). */
export async function updateBugIfUnchanged(
  bugId: string,
  fields: BugUpdateFields,
  expectedUpdatedAt: Date
): Promise<BugSqlRow | null> {
  const sets: Prisma.Sql[] = []
  if (fields.title !== undefined) sets.push(Prisma.sql`title = ${fields.title}`)
  if (fields.description !== undefined) sets.push(Prisma.sql`description = ${fields.description}`)
  if (fields.severity !== undefined) sets.push(Prisma.sql`severity = ${fields.severity}`)
  if (fields.status !== undefined) sets.push(Prisma.sql`status = ${fields.status}`)
  if (fields.environment !== undefined) sets.push(Prisma.sql`environment = ${fields.environment}`)
  if (fields.stepsToReproduce !== undefined) sets.push(Prisma.sql`steps_to_reproduce = ${fields.stepsToReproduce}`)
  if (fields.expectedBehaviour !== undefined) sets.push(Prisma.sql`expected_behaviour = ${fields.expectedBehaviour}`)
  if (fields.actualBehaviour !== undefined) sets.push(Prisma.sql`actual_behaviour = ${fields.actualBehaviour}`)
  if (fields.moduleId !== undefined) sets.push(Prisma.sql`module_id = ${fields.moduleId}`)
  if (fields.assignedToId !== undefined) sets.push(Prisma.sql`assigned_to_id = ${fields.assignedToId}`)
  if (fields.resolvedAt !== undefined) sets.push(Prisma.sql`resolved_at = ${fields.resolvedAt}`)
  sets.push(Prisma.sql`updated_at = UTC_TIMESTAMP(3)`)

  const changed = await db.$executeRaw`
    UPDATE bugs SET ${Prisma.join(sets)}
    WHERE bug_id = ${bugId} AND updated_at = ${expectedUpdatedAt}`
  if (Number(changed) === 0) return null
  const updated = await findBugById(bugId)
  if (!updated) throw new Error('Updated bug could not be read back')
  return updated
}

/** HARD delete — the only hard delete in the app (admin-only, enforced by the
 *  service). bug_test_case_links rows disappear via ON DELETE CASCADE. */
export async function deleteBugById(bugId: string): Promise<void> {
  await db.$executeRaw`DELETE FROM bugs WHERE bug_id = ${bugId}`
}

// ---------- Bug <-> test-case links (composite PK bug_id + test_case_id) ----------

export interface BugTestCaseLinkRow {
  bug_id: string
  test_case_id: string
  created_at: Date
}

export async function listBugTestCaseLinks(bugId: string): Promise<BugTestCaseLinkRow[]> {
  return db.$queryRaw<BugTestCaseLinkRow[]>`
    SELECT bug_id, test_case_id, created_at
    FROM bug_test_case_links
    WHERE bug_id = ${bugId}
    ORDER BY created_at ASC`
}

/** Idempotent link insert — duplicate links are a no-op success (legacy
 *  skipDuplicates / `.catch(() => null)` semantics), implemented with
 *  ON DUPLICATE KEY UPDATE <pk> = <pk> instead of MySQL's error-swallowing
 *  IGNORE insert: IGNORE downgrades EVERY error to a warning (FK violations,
 *  truncation), which would silently drop links to nonexistent bugs/test
 *  cases and defeat strict mode. The no-op update only swallows the
 *  composite-PK duplicate. */
export async function insertBugTestCaseLinks(bugId: string, testCaseIds: string[]): Promise<void> {
  if (!testCaseIds.length) return
  await db.$executeRaw`
    INSERT INTO bug_test_case_links (bug_id, test_case_id, created_at)
    VALUES ${Prisma.join(testCaseIds.map((tcId) => Prisma.sql`(${bugId}, ${tcId}, UTC_TIMESTAMP(3))`))}
    ON DUPLICATE KEY UPDATE bug_id = bug_id`
}

export async function deleteBugTestCaseLinks(bugId: string): Promise<void> {
  await db.$executeRaw`DELETE FROM bug_test_case_links WHERE bug_id = ${bugId}`
}
