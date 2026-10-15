// Seed repository — raw SQL data access for demo-data creation.
// Contains ONLY data access: no orchestration, no logging, no HTTP.
//
// Every INSERT supplies the primary key app-side via newId() (MySQL has no
// gen_random_uuid()/RETURNING; see src/lib/server/id.ts — the column's
// DEFAULT (uuid()) remains only as a safety net). Where the seed needs the id
// for relations (module tree paths, FK references) it is generated BEFORE the
// insert and used directly — no read-back is needed.
//
// Tables the legacy seed fills: users, modules, test_cases, bugs,
// task_reports. It writes NO review requests/events, notifications or
// activity-log rows, so no helpers exist for those tables here.
//
// All functions take an optional Prisma transaction client so the service can
// run the whole seed atomically; they default to the shared db singleton.
// created_at/updated_at are set explicitly: updated_at has no DB default and
// raw SQL bypasses Prisma's @updatedAt.

import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { newId } from '@/lib/server/id'

/** Number of existing users — backs the seed's idempotency check. */
export async function countUsers(client: Prisma.TransactionClient = db): Promise<number> {
  const rows = await client.$queryRaw<{ total: number | bigint }[]>`
    SELECT COUNT(*) AS total FROM users`
  return Number(rows[0]?.total ?? 0)
}

/** Unit of work: runs the given seed steps inside ONE atomic transaction.
 *  Lives here (not in the service) so the service never touches the db
 *  client directly — it only orchestrates which rows to write. */
export async function runSeedInTransaction<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return db.$transaction(work)
}

// ---------- Inserts ----------

export interface SeedUserInsert {
  email: string
  fullName: string
  passwordHash: string
  role: string
}

/** Creates a demo account (is_active/notify_* left to their DB defaults).
 *  Returns the generated id + email: the id for FK references, the email for
 *  the seed response. */
export async function insertSeedUser(
  input: SeedUserInsert,
  client: Prisma.TransactionClient = db
): Promise<{ userId: string; email: string }> {
  const userId = newId()
  await client.$executeRaw`
    INSERT INTO users (user_id, email, full_name, password_hash, role, created_at, updated_at)
    VALUES (${userId}, ${input.email}, ${input.fullName}, ${input.passwordHash}, ${input.role}, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`
  return { userId, email: input.email }
}

export interface SeedModuleInsert {
  name: string
  description: string
  parentId: string | null
  path: string
  depth: number
  ownerId: string
  createdById: string
  updatedById: string
}

/** Creates a module (root or submodule). The generated module_id is REQUIRED
 *  by the caller: legacy materialised paths are built from it (root path = '',
 *  submodule path = the parent module's id — legacy seed parity). */
export async function insertSeedModule(
  input: SeedModuleInsert,
  client: Prisma.TransactionClient = db
): Promise<string> {
  const moduleId = newId()
  await client.$executeRaw`
    INSERT INTO modules
      (module_id, name, description, parent_id, path, depth, owner_id, created_by_id, updated_by_id,
       created_at, updated_at)
    VALUES
      (${moduleId}, ${input.name}, ${input.description}, ${input.parentId}, ${input.path}, ${input.depth},
       ${input.ownerId}, ${input.createdById}, ${input.updatedById}, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`
  return moduleId
}

export interface SeedTestCaseInsert {
  moduleId: string
  title: string
  description: string
  preconditions: string
  expectedResult: string
  priority: string
  status: string
  tags: string[]
  version: number
  authorId: string
  lastEditedById: string
  assigneeId: string
}

/** Creates a demo test case with its fixed version/status (unlike the
 *  create-API flow, the seed sets arbitrary statuses directly). */
export async function insertSeedTestCase(
  input: SeedTestCaseInsert,
  client: Prisma.TransactionClient = db
): Promise<void> {
  await client.$executeRaw`
    INSERT INTO test_cases
      (test_case_id, module_id, title, description, preconditions, expected_result, priority,
       status, tags, version, author_id, last_edited_by_id, assignee_id, attachments,
       created_at, updated_at)
    VALUES
      (${newId()}, ${input.moduleId}, ${input.title}, ${input.description}, ${input.preconditions},
       ${input.expectedResult}, ${input.priority},
       ${input.status}, CAST(${JSON.stringify(input.tags)} AS JSON), ${input.version},
       ${input.authorId}, ${input.lastEditedById}, ${input.assigneeId},
       CAST(${JSON.stringify([])} AS JSON), UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`
}

export interface SeedBugInsert {
  title: string
  description: string
  severity: string
  status: string
  environment: string
  stepsToReproduce: string
  expectedBehaviour: string
  actualBehaviour: string
  reportedById: string
  assignedToId: string
  moduleId: string
  resolvedAt: Date | null
}

/** Creates a demo bug (attachments always [] like legacy). */
export async function insertSeedBug(
  input: SeedBugInsert,
  client: Prisma.TransactionClient = db
): Promise<void> {
  await client.$executeRaw`
    INSERT INTO bugs
      (bug_id, title, description, severity, status, environment, steps_to_reproduce,
       expected_behaviour, actual_behaviour, reported_by_id, assigned_to_id, module_id,
       attachments, resolved_at, created_at, updated_at)
    VALUES
      (${newId()}, ${input.title}, ${input.description}, ${input.severity}, ${input.status},
       ${input.environment}, ${input.stepsToReproduce}, ${input.expectedBehaviour},
       ${input.actualBehaviour}, ${input.reportedById}, ${input.assignedToId},
       ${input.moduleId}, CAST(${JSON.stringify([])} AS JSON), ${input.resolvedAt}, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`
}

export interface SeedTaskItem {
  description: string
  timeSpentMinutes: number
  moduleId: string | null
  testCaseId: string | null
  bugId: string | null
  status: string
}

export interface SeedTaskReportInsert {
  reportedById: string
  reportDate: Date
  tasks: SeedTaskItem[]
  notes: string
  totalMinutes: number
}

/** Creates a demo daily task report (total_minutes is a plain INTEGER). */
export async function insertSeedTaskReport(
  input: SeedTaskReportInsert,
  client: Prisma.TransactionClient = db
): Promise<void> {
  await client.$executeRaw`
    INSERT INTO task_reports
      (task_report_id, reported_by_id, report_date, tasks, notes, total_minutes, created_at, updated_at)
    VALUES
      (${newId()}, ${input.reportedById}, ${input.reportDate}, CAST(${JSON.stringify(input.tasks)} AS JSON),
       ${input.notes}, ${input.totalMinutes}, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`
}
