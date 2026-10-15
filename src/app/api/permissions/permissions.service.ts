// Permissions service — the runtime-togglable permission matrix.
//
// Business rules:
//   - Reading the matrix needs `manage_permissions` (VP by default).
//   - Toggling a cell needs `manage_permissions` too.
//   - Toggling to the DEFAULT value deletes the stored override so the
//     table only ever holds real deviations ("clean way" — no stale rows).
//   - Every toggle invalidates the in-process permission cache immediately.
//   - Toggles are audit-logged and business-logged.

import type { RequestMeta } from '@/lib/activity'
import { ApiError } from '@/lib/api'
import {
  DEFAULT_PERMISSIONS,
  effectiveMatrix,
  ensurePermissionsLoaded,
  invalidatePermissionCache,
} from '@/lib/permissions'
import { logActivity } from '@/lib/activity'
import { logger } from '@/lib/logger'
import type { SessionUser } from '@/lib/auth'
import { ensurePermission } from '@/lib/auth'
import {
  findRolePermissionOverride,
  upsertRolePermission,
  deleteRolePermissionOverride,
} from './permissions.repository'
import type { TogglePermissionInput } from './permissions.validation'
import type { PermissionToggle } from '@/types'

export async function getPermissionMatrix(me: SessionUser): Promise<PermissionToggle[]> {
  ensurePermission(me, 'manage_permissions', 'Only the VP (or a role granted manage_permissions) can view permissions')
  await ensurePermissionsLoaded(true)
  return effectiveMatrix()
}

export async function togglePermission(
  me: SessionUser,
  input: TogglePermissionInput,
  meta: RequestMeta
): Promise<PermissionToggle> {
  ensurePermission(me, 'manage_permissions', 'Only the VP (or a role granted manage_permissions) can change permissions')

  const before = await findRolePermissionOverride(input.role, input.action)

  const saved = await upsertRolePermission({
    role: input.role,
    action: input.action,
    enabled: input.enabled,
    updatedById: me.userId,
  })

  // Toggling back to the default value removes the override row entirely
  // (defaults live in src/lib/permissions.ts — single source of truth).
  const isDefault = (DEFAULT_PERMISSIONS[input.role as keyof typeof DEFAULT_PERMISSIONS] ?? []).includes(
    input.action as never
  )
  if (input.enabled === isDefault) {
    await deleteRolePermissionOverride(input.role, input.action)
  }

  // Drop stale overrides, then RELOAD synchronously before answering: the
  // very next sync `can()` call (any request in this instance) must already
  // see the post-toggle state, not a one-request window of stale defaults.
  invalidatePermissionCache()
  await ensurePermissionsLoaded(true)
  logger.info('Permission toggled', {
    role: input.role,
    action: input.action,
    enabled: input.enabled,
    by: me.userId,
  })

  await logActivity({
    userId: me.userId,
    action: 'UPDATE',
    entityType: 'role_permission',
    entityId: `${input.role}:${input.action}`,
    entityName: `${input.role} -> ${input.action}`,
    before: { enabled: before?.enabled ?? null },
    after: { enabled: input.enabled },
    meta,
  })

  return {
    role: saved.role as PermissionToggle['role'],
    action: saved.action as PermissionToggle['action'],
    enabled: saved.enabled,
    source: 'override',
  }
}
