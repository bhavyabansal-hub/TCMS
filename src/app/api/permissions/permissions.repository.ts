// Permissions repository — raw SQL is intentionally minimal here:
// the role_permissions override storage lives in the SHARED repository
// (src/lib/server/role-permission.repository.ts) because the permission
// engine (src/lib/permissions.ts) reads the same table for its cache.
// This file re-exports that contract for the resource layer so the
// resource keeps its full Controller -> Validation -> Service ->
// Repository file layout without duplicating SQL.

export {
  listRolePermissionOverrides,
  findRolePermissionOverride,
  upsertRolePermission,
  deleteRolePermissionOverride,
  countRolePermissionOverrides,
} from '@/lib/server/role-permission.repository'
