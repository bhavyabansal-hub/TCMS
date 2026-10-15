// Test-case repository — raw SQL data access for test_cases,
// test_case_history and the test-case side of review queries.
// Contains ONLY data access: no permission checks, no status machines.

import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { newId } from '@/lib/server/id'
import type { TestCaseSqlRow, TestCaseHistorySqlRow } from '@/types/sql-rows'

/** Anything that can run raw SQL: the singleton client OR one interactive
 *  transaction. Multi-step writes MUST pass the tx through so the whole
 *  business operation commits or rolls back as ONE unit — a crash between
 *  two statements can never leave half-written (corrupted) data behind. */
export type SqlExecutor = Prisma.TransactionClient

/** Standard JOIN select — test case plus module/author/lastEditedBy/assignee refs. */
const TEST_CASE_SELECT = Prisma.sql`
  SELECT tc.*,
    m.module_id AS module_module_id, m.name AS module_name, m.parent_id AS module_parent_id,
    au.user_id AS author_user_id, au.full_name AS author_full_name, au.avatar_url AS author_avatar_url,
    le.user_id AS last_edited_by_user_id, le.full_name AS last_edited_by_full_name, le.avatar_url AS last_edited_by_avatar_url,
    asg.user_id AS assignee_user_id, asg.full_name AS assignee_full_name, asg.avatar_url AS assignee_avatar_url
  FROM test_cases tc
  LEFT JOIN modules m ON m.module_id = tc.module_id
  LEFT JOIN users au ON au.user_id = tc.author_id
  LEFT JOIN users le ON le.user_id = tc.last_edited_by_id
  LEFT JOIN users asg ON asg.user_id = tc.assignee_id`

export interface TestCaseFilters {
  moduleId?: string
  status?: string
  priority?: string
  authorId?: string
  search?: string
}

function buildWhere(filters: TestCaseFilters): Prisma.Sql {
  const parts: Prisma.Sql[] = []
  if (filters.moduleId) parts.push(Prisma.sql`tc.module_id = ${filters.moduleId}`)
  if (filters.status) parts.push(Prisma.sql`tc.status = ${filters.status}`)
  if (filters.priority) parts.push(Prisma.sql`tc.priority = ${filters.priority}`)
  if (filters.authorId) parts.push(Prisma.sql`tc.author_id = ${filters.authorId}`)
  // LIKE (utf8mb4_unicode_ci) = case-insensitive search (deliberate improvement
  // over the legacy case-sensitive `contains` filter).
  if (filters.search) parts.push(Prisma.sql`tc.title LIKE ${`%${filters.search}%`}`)
  return parts.length ? Prisma.sql`WHERE ${Prisma.join(parts, ' AND ')}` : Prisma.empty
}

export async function countTestCases(filters: TestCaseFilters): Promise<number> {
  const rows = await db.$queryRaw<{ total: number | bigint }[]>`
    SELECT COUNT(*) AS total FROM test_cases tc ${buildWhere(filters)}`
  return Number(rows[0]?.total ?? 0)
}

export async function listTestCases(
  filters: TestCaseFilters,
  limit: number,
  offset: number
): Promise<TestCaseSqlRow[]> {
  return db.$queryRaw<TestCaseSqlRow[]>(Prisma.sql`
    ${TEST_CASE_SELECT} ${buildWhere(filters)}
    ORDER BY tc.updated_at DESC
    LIMIT ${limit} OFFSET ${offset}`)
}

export async function findTestCaseById(testCaseId: string, tx: SqlExecutor = db): Promise<TestCaseSqlRow | null> {
  const rows = await tx.$queryRaw<TestCaseSqlRow[]>`
    ${TEST_CASE_SELECT} WHERE tc.test_case_id = ${testCaseId} LIMIT 1`
  return rows[0] ?? null
}

export interface TestCaseInsert {
  moduleId: string | null
  title: string
  description: string | null
  preconditions: string | null
  expectedResult: string | null
  priority: string
  tags: string[]
  authorId: string
  lastEditedById: string
  assigneeId: string | null
}

export async function insertTestCase(input: TestCaseInsert): Promise<TestCaseSqlRow> {
  // MySQL has no RETURNING: generate the PK app-side, insert, then read back.
  const testCaseId = newId()
  await db.$executeRaw`
    INSERT INTO test_cases
      (test_case_id, module_id, title, description, preconditions, expected_result,
       priority, status, tags, author_id, last_edited_by_id, assignee_id, created_at, updated_at)
    VALUES
      (${testCaseId}, ${input.moduleId}, ${input.title}, ${input.description}, ${input.preconditions},
       ${input.expectedResult},
       ${input.priority}, 'draft', CAST(${JSON.stringify(input.tags)} AS JSON),
       ${input.authorId}, ${input.lastEditedById}, ${input.assigneeId}, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`
  const created = await findTestCaseById(testCaseId)
  if (!created) throw new Error('Inserted test case could not be read back')
  return created
}

export interface TestCaseUpdateFields {
  title?: string
  description?: string | null
  preconditions?: string | null
  expectedResult?: string | null
  priority?: string
  tags?: string[]
  moduleId?: string | null
  assigneeId?: string | null
  status?: string
  version?: number
  lastEditedById?: string
}

/** Partial UPDATE — every write also bumps updated_at (raw SQL skips @updatedAt).
 *  Runs inside the caller's transaction when one is passed (see SqlExecutor). */
export async function updateTestCase(
  testCaseId: string,
  fields: TestCaseUpdateFields,
  tx: SqlExecutor = db
): Promise<TestCaseSqlRow> {
  const sets: Prisma.Sql[] = []
  if (fields.title !== undefined) sets.push(Prisma.sql`title = ${fields.title}`)
  if (fields.description !== undefined) sets.push(Prisma.sql`description = ${fields.description}`)
  if (fields.preconditions !== undefined) sets.push(Prisma.sql`preconditions = ${fields.preconditions}`)
  if (fields.expectedResult !== undefined) sets.push(Prisma.sql`expected_result = ${fields.expectedResult}`)
  if (fields.priority !== undefined) sets.push(Prisma.sql`priority = ${fields.priority}`)
  if (fields.tags !== undefined) sets.push(Prisma.sql`tags = CAST(${JSON.stringify(fields.tags)} AS JSON)`)
  if (fields.moduleId !== undefined) sets.push(Prisma.sql`module_id = ${fields.moduleId}`)
  if (fields.assigneeId !== undefined) sets.push(Prisma.sql`assignee_id = ${fields.assigneeId}`)
  if (fields.status !== undefined) sets.push(Prisma.sql`status = ${fields.status}`)
  if (fields.version !== undefined) sets.push(Prisma.sql`version = ${fields.version}`)
  if (fields.lastEditedById !== undefined) sets.push(Prisma.sql`last_edited_by_id = ${fields.lastEditedById}`)
  sets.push(Prisma.sql`updated_at = UTC_TIMESTAMP(3)`)

  await tx.$executeRaw`
    UPDATE test_cases SET ${Prisma.join(sets)} WHERE test_case_id = ${testCaseId}`
  const updated = await findTestCaseById(testCaseId, tx)
  if (!updated) throw new Error('Updated test case could not be read back')
  return updated
}

/** Optimistic-concurrency UPDATE: only applies when the row still carries the
 *  version the caller read. Returns false when another user saved first — the
 *  caller turns that into a 409 so no edit is ever silently lost (the classic
 *  lost-update corruption with two concurrent editors). */
export async function updateTestCaseIfVersion(
  testCaseId: string,
  expectedVersion: number,
  fields: TestCaseUpdateFields,
  tx: SqlExecutor = db
): Promise<boolean> {
  const sets: Prisma.Sql[] = []
  if (fields.title !== undefined) sets.push(Prisma.sql`title = ${fields.title}`)
  if (fields.description !== undefined) sets.push(Prisma.sql`description = ${fields.description}`)
  if (fields.preconditions !== undefined) sets.push(Prisma.sql`preconditions = ${fields.preconditions}`)
  if (fields.expectedResult !== undefined) sets.push(Prisma.sql`expected_result = ${fields.expectedResult}`)
  if (fields.priority !== undefined) sets.push(Prisma.sql`priority = ${fields.priority}`)
  if (fields.tags !== undefined) sets.push(Prisma.sql`tags = CAST(${JSON.stringify(fields.tags)} AS JSON)`)
  if (fields.moduleId !== undefined) sets.push(Prisma.sql`module_id = ${fields.moduleId}`)
  if (fields.assigneeId !== undefined) sets.push(Prisma.sql`assignee_id = ${fields.assigneeId}`)
  if (fields.status !== undefined) sets.push(Prisma.sql`status = ${fields.status}`)
  if (fields.version !== undefined) sets.push(Prisma.sql`version = ${fields.version}`)
  if (fields.lastEditedById !== undefined) sets.push(Prisma.sql`last_edited_by_id = ${fields.lastEditedById}`)
  sets.push(Prisma.sql`updated_at = UTC_TIMESTAMP(3)`)

  const changed = await tx.$executeRaw`
    UPDATE test_cases SET ${Prisma.join(sets)}
    WHERE test_case_id = ${testCaseId} AND version = ${expectedVersion}`
  return Number(changed) > 0
}

export async function updateTestCaseStatus(
  testCaseId: string,
  status: string,
  tx: SqlExecutor = db
): Promise<void> {
  await tx.$executeRaw`
    UPDATE test_cases SET status = ${status}, updated_at = UTC_TIMESTAMP(3)
    WHERE test_case_id = ${testCaseId}`
}

/** PERMANENT delete: removes the test_cases row. The schema's ON DELETE
 *  CASCADE foreign keys wipe everything that belongs to the case in one
 *  statement: test_case_history rows, review_requests (and their
 *  review_events via cascade), and bug_test_case_links. Returns the number
 *  of rows removed (0 = nothing was deleted). */
export async function hardDeleteTestCase(testCaseId: string, tx: SqlExecutor = db): Promise<number> {
  const affected = await tx.$executeRaw`
    DELETE FROM test_cases WHERE test_case_id = ${testCaseId}`
  return Number(affected)
}

// ---------- Test-case history ----------

export interface TestCaseHistoryInsert {
  testCaseId: string
  version: number
  snapshot: Record<string, unknown>
  changedById: string
  changeSummary: string
}

export async function insertTestCaseHistory(input: TestCaseHistoryInsert, tx: SqlExecutor = db): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO test_case_history (history_id, test_case_id, version, snapshot, changed_by_id, change_summary, created_at)
    VALUES (${newId()}, ${input.testCaseId}, ${input.version}, CAST(${JSON.stringify(input.snapshot)} AS JSON),
            ${input.changedById}, ${input.changeSummary}, UTC_TIMESTAMP(3))`
}

export async function listTestCaseHistory(testCaseId: string): Promise<TestCaseHistorySqlRow[]> {
  return db.$queryRaw<TestCaseHistorySqlRow[]>`
    SELECT h.*, u.user_id AS changed_by_user_id, u.full_name AS changed_by_full_name, u.avatar_url AS changed_by_avatar_url
    FROM test_case_history h
    LEFT JOIN users u ON u.user_id = h.changed_by_id
    WHERE h.test_case_id = ${testCaseId}
    ORDER BY h.version DESC`
}

/** All test cases in the given modules whose status is one of `statuses`.
 *  Used by the modules resource for module-level review submission. */
export async function listTestCasesInModules(
  moduleIds: string[],
  statuses: string[]
): Promise<TestCaseSqlRow[]> {
  if (moduleIds.length === 0) return []
  return db.$queryRaw<TestCaseSqlRow[]>(Prisma.sql`
    ${TEST_CASE_SELECT}
    WHERE tc.module_id IN (${Prisma.join(moduleIds)})
      AND tc.status IN (${Prisma.join(statuses)})`)
}

/** One page of test cases anywhere inside a module tree (the module itself
 *  plus all its descendants), ANY status, newest first. Used by the module
 *  detail page so a parent module aggregates the cases of its submodules.
 *  Caller passes the full id list (root first) from listDescendantModuleIds. */
export async function listTestCasesInModuleTree(
  moduleIds: string[],
  limit: number,
  offset: number
): Promise<TestCaseSqlRow[]> {
  if (moduleIds.length === 0) return []
  return db.$queryRaw<TestCaseSqlRow[]>(Prisma.sql`
    ${TEST_CASE_SELECT}
    WHERE tc.module_id IN (${Prisma.join(moduleIds)})
    ORDER BY tc.updated_at DESC
    LIMIT ${limit} OFFSET ${offset}`)
}

/** Counts for a module tree: total cases anywhere in the tree, plus how many
 *  sit directly on `directModuleId` (vs inherited from submodules). One scan. */
export async function countTestCasesInModules(
  moduleIds: string[],
  directModuleId: string
): Promise<{ total: number; direct: number }> {
  if (moduleIds.length === 0) return { total: 0, direct: 0 }
  // PG `count(*) FILTER (WHERE ...)` has no MySQL equivalent — mapped to the
  // standard COUNT(CASE WHEN ... THEN 1 END) idiom. Aggregates may arrive as
  // bigint under MySQL — normalized to number at the return site.
  const rows = await db.$queryRaw<{ total: number | bigint; direct: number | bigint }[]>(Prisma.sql`
    SELECT count(*) AS total,
           COUNT(CASE WHEN tc.module_id = ${directModuleId} THEN 1 END) AS direct
    FROM test_cases tc
    WHERE tc.module_id IN (${Prisma.join(moduleIds)})`)
  return { total: Number(rows[0]?.total ?? 0), direct: Number(rows[0]?.direct ?? 0) }
}

/** List test cases by explicit ids (used by other resources, e.g. bug links).
 *  Same standard JOIN select as the list above; newest first. */
export async function listTestCasesByIds(ids: string[]): Promise<TestCaseSqlRow[]> {
  if (!ids.length) return []
  return db.$queryRaw<TestCaseSqlRow[]>(Prisma.sql`
    ${TEST_CASE_SELECT} WHERE tc.test_case_id IN (${Prisma.join(ids)})
    ORDER BY tc.created_at DESC`)
}
