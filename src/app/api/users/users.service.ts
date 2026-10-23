// Users service — business logic for user administration.
//
// Owns: the manage_users permission gate, the email-uniqueness rule,
// password hashing on create, soft-delete (deactivate) semantics and audit
// logging. Data access goes exclusively through repositories; API shapes are
// produced exclusively through the serializers (never expose password_hash).

import type { RequestMeta } from '@/lib/activity'
import { ApiError, paginate, type PaginatedResponse } from '@/lib/api'
import { ensurePermission, forgetUserSession, hashPassword, type SessionUser } from '@/lib/auth'
import { effectivePermissionsFor } from '@/lib/permissions'
import { logActivity } from '@/lib/activity'
import { logger } from '@/lib/logger'
import { serializeUser, type SerializedUser } from '@/lib/serializers'
import type { UserOption } from '@/types'
import { findUserByEmail, findUserById } from '@/lib/server/user.repository'
import { REFERENCE_CACHE_PREFIX, REFERENCE_CACHE_TTL_MS, withCache } from '@/lib/server/cache'
import {
  countUsers,
  deactivateUser,
  insertUser,
  listUserOptionRows,
  listUsers,
  updateUser,
  type UserFilters,
  type UserUpdateFields,
} from './users.repository'

// ---------- Queries ----------

/** GET /api/users — paginated, filterable user list (manage_users only). */
export async function listUsersPaginated(
  me: SessionUser,
  q: Record<string, string>
): Promise<PaginatedResponse<SerializedUser>> {
  ensurePermission(me, 'manage_users', 'Admin only')
  // Legacy query semantics preserved exactly: role is an exact match;
  // isActive present and !== 'true' means false (the UI only sends
  // 'true' / 'false' / nothing).
  const filters: UserFilters = {
    role: q.role,
    isActive: q.isActive === undefined ? undefined : q.isActive === 'true',
  }
  // Legacy defaults (page 1 / pageSize 50) with NO upper clamp — several
  // views legitimately request pageSize=200 to fill user pickers.
  const page = parseInt(q.page ?? '1', 10) || 1
  const pageSize = parseInt(q.pageSize ?? '50', 10) || 50
  const [total, rows] = await Promise.all([
    countUsers(filters),
    listUsers(filters, pageSize, (page - 1) * pageSize),
  ])
  return paginate(rows.map(serializeUser), total, page, pageSize)
}

/** GET /api/users?action=options — picker rows for ANY authenticated user.
 *  Assignment/reviewer dropdowns need names + roles, not the admin list;
 *  gating THIS on manage_users broke every picker for non-admin roles
 *  (403 -> empty reviewer/assignee dropdowns). Admin data (emails, filters,
 *  audit fields) stays on the manage_users-gated list above. The
 *  canPerformReview flag comes from the live matrix, not a static role list. */
export async function listUserOptions(): Promise<UserOption[]> {
  // Cache-aside: every picker reads this; logActivity clears it after any write.
  // The reviewer flag below is computed live from the matrix, never cached.
  const rows = await withCache(`${REFERENCE_CACHE_PREFIX}user-options`, REFERENCE_CACHE_TTL_MS, listUserOptionRows)
  // One effective-permission lookup per distinct role (the matrix is
  // role-based), then a cheap membership check per row.
  const reviewerRoles = new Set(
    [...new Set(rows.map((r) => r.role))]
      .filter((role) => effectivePermissionsFor(role).includes('perform_review'))
  )
  return rows.map((r) => ({
    userId: r.user_id,
    fullName: r.full_name,
    role: r.role as UserOption['role'],
    canPerformReview: reviewerRoles.has(r.role),
  }))
}

// ---------- Commands ----------

/** POST /api/users — invite (create) a user. Only a VP may pick a role other than
 *  DEFAULT_INVITE_ROLE (src/lib/roles.ts canAssignRoles). */
import { clearIdentityCache } from '../integrations/crewdesk/crewdesk.identity'
import { DEFAULT_INVITE_ROLE, canAssignRoles, canManageAccount } from '@/lib/roles'

export async function createUser(
  me: SessionUser,
  input: { email: string; fullName: string; password: string; role: string },
  meta: RequestMeta
): Promise<SerializedUser> {
  ensurePermission(me, 'manage_users', 'Admin only')
  if (input.role !== DEFAULT_INVITE_ROLE && !canAssignRoles(me.role)) {
    throw ApiError.forbidden(`Only a VP can create accounts with a role other than ${DEFAULT_INVITE_ROLE}`)
  }
  const existing = await findUserByEmail(input.email)
  if (existing) throw ApiError.badRequest('Email already registered')
  const user = await insertUser({
    email: input.email,
    fullName: input.fullName,
    passwordHash: hashPassword(input.password),
    role: input.role,
  })
  logger.info('User created', { userId: user.user_id, role: user.role, actorId: me.userId })
  await logActivity({
    userId: me.userId,
    action: 'CREATE',
    entityType: 'user',
    entityId: user.user_id,
    entityName: user.email,
    after: { email: input.email, fullName: input.fullName, role: input.role },
    meta,
  })
  // Crew Desk email check uses the assignable-user roster — users changed,
  // roster may be stale.
  clearIdentityCache()
  return serializeUser(user)
}

/** PUT /api/users?id=... — update fullName / role / isActive / avatarUrl. */
export async function updateUserFields(
  me: SessionUser,
  userId: string,
  input: { fullName?: string; role?: string; isActive?: boolean; avatarUrl?: string | null },
  meta: RequestMeta
): Promise<SerializedUser> {
  ensurePermission(me, 'manage_users', 'Admin only')
  const before = await findUserById(userId)
  if (!before) throw ApiError.notFound('User not found')
  if (userId !== me.userId && !canManageAccount(me.role, before.role)) {
    throw ApiError.forbidden('You can only change accounts below your own role')
  }
  if (userId === me.userId && input.isActive === false) throw ApiError.badRequest('You cannot deactivate yourself')
  // Role changes (deep-test R2-3): never your own role; otherwise only a VP.
  if (input.role !== undefined && input.role !== before.role) {
    if (userId === me.userId) throw ApiError.forbidden('You cannot change your own role')
    if (!canAssignRoles(me.role)) throw ApiError.forbidden('Only a VP can change roles')
  }

  // All update fields are optional; skip the round-trip when nothing is set.
  const fields: UserUpdateFields = {}
  if (input.fullName !== undefined) fields.fullName = input.fullName
  if (input.role !== undefined) fields.role = input.role
  if (input.isActive !== undefined) fields.isActive = input.isActive
  if (input.avatarUrl !== undefined) fields.avatarUrl = input.avatarUrl
  const updated = Object.keys(fields).length > 0 ? await updateUser(userId, fields) : before
  forgetUserSession(userId) // new role / active state counts from the next request

  await logActivity({
    userId: me.userId,
    action: 'UPDATE',
    entityType: 'user',
    entityId: userId,
    entityName: before.email,
    before: { role: before.role, isActive: before.is_active, fullName: before.full_name },
    after: { role: updated.role, isActive: updated.is_active, fullName: updated.full_name },
    meta,
  })
  clearIdentityCache() // roster may have changed (email/fullName/active)
  return serializeUser(updated)
}

/** DELETE /api/users?id=... — SOFT delete: the account is deactivated. */
export async function deactivateUserAccount(
  me: SessionUser,
  userId: string,
  meta: RequestMeta
): Promise<{ success: true }> {
  ensurePermission(me, 'manage_users', 'Admin only')
  if (userId === me.userId) throw ApiError.badRequest('Cannot delete yourself')
  const before = await findUserById(userId)
  if (!before) throw ApiError.notFound('User not found')
  if (!canManageAccount(me.role, before.role)) {
    throw ApiError.forbidden('You can only deactivate accounts below your own role')
  }
  await deactivateUser(userId)
  forgetUserSession(userId) // the deactivated user is signed out from the next request
  logger.info('User deactivated', { userId, actorId: me.userId })
  await logActivity({
    userId: me.userId,
    action: 'DELETE',
    entityType: 'user',
    entityId: userId,
    entityName: before.email,
    before: { isActive: true },
    after: { isActive: false },
    meta,
  })
  clearIdentityCache() // a deactivated user must fail the email check immediately
  return { success: true }
}
