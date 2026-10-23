// Role-permission overrides repository — raw SQL access to role_permissions.
//
// The table stores ONLY toggled cells (VP changes). Cells never toggled fall
// back to DEFAULT_PERMISSIONS in src/lib/permissions.ts. This repository is
// shared: the permissions resource (admin API) writes through it and the
// permission engine (src/lib/permissions.ts) reads through it.
//
// Contains ONLY data access: no permission decisions, no caching, no logging.

import { db } from '@/lib/db'
import type { RolePermissionSqlRow } from '@/types/sql-rows'

export type RolePermissionOverride = Pick<RolePermissionSqlRow, 'role' | 'action' | 'enabled'>

export async function listRolePermissionOverrides(): Promise<RolePermissionOverride[]> {
  const rows = await db.$queryRaw<RolePermissionSqlRow[]>`
    SELECT role, action, enabled
    FROM role_permissions`
  return rows
}

export async function findRolePermissionOverride(
  role: string,
  action: string
): Promise<RolePermissionOverride | null> {
  const rows = await db.$queryRaw<RolePermissionSqlRow[]>`
    SELECT role, action, enabled
    FROM role_permissions
    WHERE role = ${role} AND action = ${action}
    LIMIT 1`
  return rows[0] ?? null
}

/** Inserts or flips ONE matrix cell, remembering who changed it.
 *  One atomic statement; the stored values are exactly the bound params, so
 *  there is no read-back (chaos test 2026-10-22: a parallel toggle back to the
 *  default could delete the row between upsert and read-back -> 500). */
export async function upsertRolePermission(input: {
  role: string
  action: string
  enabled: boolean
  updatedById: string
}): Promise<RolePermissionOverride> {
  await db.$executeRaw`
    INSERT INTO role_permissions (role, action, enabled, updated_by_id, updated_at)
    VALUES (${input.role}, ${input.action}, ${input.enabled}, ${input.updatedById}, UTC_TIMESTAMP(3))
    ON DUPLICATE KEY UPDATE
      enabled = ${input.enabled},
      updated_by_id = ${input.updatedById},
      updated_at = UTC_TIMESTAMP(3)`
  return { role: input.role, action: input.action, enabled: input.enabled } as RolePermissionOverride
}

/** Deletes one override so the cell falls back to its default. */
export async function deleteRolePermissionOverride(role: string, action: string): Promise<boolean> {
  const count = await db.$executeRaw`
    DELETE FROM role_permissions WHERE role = ${role} AND action = ${action}`
  return Number(count) > 0
}

/** Count helper used by tests/verification. */
export async function countRolePermissionOverrides(): Promise<number> {
  const rows = await db.$queryRaw<{ total: number | bigint }[]>`
    SELECT COUNT(*) AS total FROM role_permissions`
  return Number(rows[0]?.total ?? 0)
}
