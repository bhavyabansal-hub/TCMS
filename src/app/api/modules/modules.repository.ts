// Modules repository — raw SQL data access for modules (and their joins).
// Contains ONLY data access: no permission checks, no path/depth rules,
// no tree building, no logging.

import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { newId } from '@/lib/server/id'
import type { ModuleSqlRow } from '@/types/sql-rows'

/** All modules ordered by name, each with its owner reference
 *  (userId/fullName/email) and its SUBTREE test-case count (module + descendants). */
export async function listModulesWithOwnerAndCaseCount(): Promise<ModuleSqlRow[]> {
  // test_case_count = cases in the WHOLE subtree (module + all descendants),
  // not just direct cases — a parent module whose cases live in its
  // submodules must not read as empty. One recursive CTE + one aggregation.
  const rows = await db.$queryRaw<ModuleSqlRow[]>`
    WITH RECURSIVE tree AS (
      SELECT module_id, module_id AS root_id FROM modules
      UNION ALL
      SELECT m.module_id, t.root_id FROM modules m JOIN tree t ON m.parent_id = t.module_id
    ),
    counts AS (
      SELECT tree.root_id, COUNT(tc.test_case_id) AS n
      FROM tree LEFT JOIN test_cases tc ON tc.module_id = tree.module_id
      GROUP BY tree.root_id
    )
    SELECT m.*,
      ou.user_id AS owner_user_id, ou.full_name AS owner_full_name, ou.email AS owner_email, ou.avatar_url AS owner_avatar_url,
      COALESCE(c.n, 0) AS test_case_count
    FROM modules m
    LEFT JOIN counts c ON c.root_id = m.module_id
    LEFT JOIN users ou ON ou.user_id = m.owner_id
    ORDER BY m.name ASC`
  // MySQL COUNT() may arrive as bigint — normalize the aggregate to number.
  return rows.map((r) => ({ ...r, test_case_count: Number(r.test_case_count ?? 0) }))
}

/** Single module with owner/createdBy/updatedBy reference joins
 *  (owner carries email; creator/updater are id+name only, like legacy). */
export async function findModuleById(moduleId: string): Promise<ModuleSqlRow | null> {
  const rows = await db.$queryRaw<ModuleSqlRow[]>`
    SELECT m.*,
      ou.user_id AS owner_user_id, ou.full_name AS owner_full_name, ou.email AS owner_email, ou.avatar_url AS owner_avatar_url,
      cu.user_id AS created_by_user_id, cu.full_name AS created_by_full_name, cu.avatar_url AS created_by_avatar_url,
      uu.user_id AS updated_by_user_id, uu.full_name AS updated_by_full_name, uu.avatar_url AS updated_by_avatar_url
    FROM modules m
    LEFT JOIN users ou ON ou.user_id = m.owner_id
    LEFT JOIN users cu ON cu.user_id = m.created_by_id
    LEFT JOIN users uu ON uu.user_id = m.updated_by_id
    WHERE m.module_id = ${moduleId}
    LIMIT 1`
  return rows[0] ?? null
}

/** Direct children of a module, with owner reference (no email — legacy shape). */
export async function listSubmodules(parentId: string): Promise<ModuleSqlRow[]> {
  return db.$queryRaw<ModuleSqlRow[]>`
    SELECT m.*,
      ou.user_id AS owner_user_id, ou.full_name AS owner_full_name, ou.avatar_url AS owner_avatar_url
    FROM modules m
    LEFT JOIN users ou ON ou.user_id = m.owner_id
    WHERE m.parent_id = ${parentId}
    ORDER BY m.name ASC`
}

/** All strict descendants (children, grandchildren, ...) of a module. */
export async function listDescendantModuleIds(moduleId: string): Promise<string[]> {
  const rows = await db.$queryRaw<{ module_id: string }[]>`
    WITH RECURSIVE descendants AS (
      SELECT module_id FROM modules WHERE parent_id = ${moduleId}
      UNION ALL
      SELECT m.module_id FROM modules m INNER JOIN descendants d ON m.parent_id = d.module_id
    )
    SELECT module_id FROM descendants`
  return rows.map((row) => row.module_id)
}

// ---------- Inserts ----------

export interface ModuleInsert {
  name: string
  description: string | null
  parentId: string | null
  path: string
  depth: number
  ownerId: string
  createdById: string
  updatedById: string
}

/** Creates a module. The PK is generated app-side (MySQL: no RETURNING).
 *  created_at/updated_at are set explicitly: updated_at has no DB default
 *  and raw SQL bypasses @updatedAt. */
export async function insertModule(input: ModuleInsert): Promise<string> {
  const moduleId = newId()
  await db.$executeRaw`
    INSERT INTO modules
      (module_id, name, description, parent_id, path, depth, owner_id, created_by_id, updated_by_id,
       created_at, updated_at)
    VALUES
      (${moduleId}, ${input.name}, ${input.description}, ${input.parentId}, ${input.path}, ${input.depth},
       ${input.ownerId}, ${input.createdById}, ${input.updatedById}, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`
  return moduleId
}

// ---------- Updates ----------

export interface ModuleUpdateFields {
  name?: string
  description?: string
  ownerId?: string
  updatedById?: string
}

/** Guarded partial UPDATE — applies only while updated_at still equals
 *  `expectedUpdatedAt` (optimistic lock); returns null when another write landed
 *  first. Every write also bumps updated_at (raw SQL skips @updatedAt).
 *  MySQL: UPDATE has no RETURNING — write, then read the row back. */
export async function updateModuleIfUnchanged(
  moduleId: string,
  fields: ModuleUpdateFields,
  expectedUpdatedAt: Date
): Promise<ModuleSqlRow | null> {
  const sets: Prisma.Sql[] = []
  if (fields.name !== undefined) sets.push(Prisma.sql`name = ${fields.name}`)
  if (fields.description !== undefined) sets.push(Prisma.sql`description = ${fields.description}`)
  if (fields.ownerId !== undefined) sets.push(Prisma.sql`owner_id = ${fields.ownerId}`)
  if (fields.updatedById !== undefined) sets.push(Prisma.sql`updated_by_id = ${fields.updatedById}`)
  sets.push(Prisma.sql`updated_at = UTC_TIMESTAMP(3)`)

  const changed = await db.$executeRaw`
    UPDATE modules SET ${Prisma.join(sets)}
    WHERE module_id = ${moduleId} AND updated_at = ${expectedUpdatedAt}`
  if (Number(changed) === 0) return null
  const rows = await db.$queryRaw<ModuleSqlRow[]>`
    SELECT * FROM modules WHERE module_id = ${moduleId} LIMIT 1`
  if (!rows[0]) throw new Error('Updated module could not be read back')
  return rows[0]
}

// ---------- Deletes ----------

/** Hard delete. DB foreign keys do the rest, exactly like legacy:
 *  submodules and module_review_requests (plus their case reviews) cascade,
 *  test cases and bugs keep their rows with module_id set to NULL.
 *  crew_desk_links has NO FK by design (raw-SQL repository is its only
 *  writer) — remove its rows explicitly in the same transaction so no
 *  orphaned integration history survives the module. */
export async function deleteModule(moduleId: string): Promise<void> {
  await db.$transaction([
    db.$executeRaw`DELETE FROM crew_desk_links WHERE module_id = ${moduleId}`,
    db.$executeRaw`DELETE FROM modules WHERE module_id = ${moduleId}`,
  ])
}
