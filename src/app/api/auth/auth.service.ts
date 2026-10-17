// Auth service — session lifecycle and profile business logic.
// Owns: the self-signup switch + least-privilege viewer rule, credential
// checks with brute-force lockout (5 fails -> 1 min lock), refresh-token
// rotation, permission snapshot in every session, password changes,
// profile updates + audit logging.

import type { RequestMeta } from '@/lib/activity'
import { ApiError } from '@/lib/api'
import {
  hashPassword,
  verifyPassword,
  signAccessToken,
  signRefreshToken,
  verifyToken,
  refreshTtlDays,
  effectivePermissionsFresh,
  type JwtPayload,
  type SessionUser,
} from '@/lib/auth'
import { logActivity } from '@/lib/activity'
import { logger } from '@/lib/logger'
import { assertLoginAllowedForIp, clientIpKey, recordFailedLoginForIp } from '@/lib/server/login-rate-limit'
import { LOGIN_IP_MAX_FAILURES } from '@/lib/server/config'
import { createNotification } from '@/lib/notifications'
import { serializeUser, type SerializedUser } from '@/lib/serializers'
import { findUserById, findUserByEmail } from '@/lib/server/user.repository'
import { signWsTicket, WS_TICKET_TTL_SECONDS } from '@/lib/server/ws-ticket'
import { WS_NOTIFY_SECRET } from '@/lib/server/config'
import {
  countUsers,
  createUser,
  findRefreshToken,
  insertRefreshToken,
  revokeRefreshToken,
  grantRotationGrace,
  REFRESH_ROTATION_GRACE_SECONDS,
  revokeAllRefreshTokensForUser,
  updateUserPassword,
  updateUserProfile,
  MAX_LOGIN_ATTEMPTS,
  LOGIN_LOCK_SECONDS,
  findLoginAttempt,
  registerFailedLoginAttempt,
  lockLoginAttempts,
  clearLoginAttempts,
} from './auth.repository'
import type { UserSqlRow } from '@/types/sql-rows'

export interface AuthSessionPayload {
  user: SerializedUser
  permissions: string[]
  accessToken: string
  refreshToken: string
}

/** Precomputed bcrypt hash of random data — costs exactly like a real
 *  verify so the unknown-email login branch matches the known-email timing
 *  (account-enumeration timing oracle, audit 2026-10-09). */
const DUMMY_BCRYPT_HASH = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8DSPuNcU3vI9s0xVJKrVYQi0v/UXBa'

/** Issues an access + refresh token pair and persists the refresh token. */
async function createSessionForUser(user: UserSqlRow) {
  const payload: JwtPayload = {
    sub: user.user_id,
    email: user.email,
    role: user.role,
    fullName: user.full_name,
  }
  const accessToken = signAccessToken(payload)
  const refreshToken = signRefreshToken(payload)
  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + refreshTtlDays())
  await insertRefreshToken({ userId: user.user_id, token: refreshToken, expiresAt })
  return { accessToken, refreshToken }
}

/** Session shape shared by register/login: user + effective permissions.
 *  Permissions are read fresh from the override table so a toggle made in
 *  any process instance is reflected in the very next session. */
async function toSessionPayload(user: UserSqlRow): Promise<AuthSessionPayload> {
  const session = await createSessionForUser(user)
  return {
    user: serializeUser(user),
    permissions: await effectivePermissionsFresh(user.role),
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
  }
}

export async function loginUser(
  input: { email: string; password: string },
  meta: RequestMeta
): Promise<AuthSessionPayload> {
  // Per-IP guard first (B6): too many failed sign-ins from one network -> 429,
  // whatever emails were tried (in memory, src/lib/server/login-rate-limit.ts).
  const ip = clientIpKey(meta.ip)
  assertLoginAllowedForIp(ip)

  // Brute-force guard per email: 5 failed attempts -> 1 minute lock, then a
  // fresh counter. The lock applies per email, before any password work.
  const attempt = await findLoginAttempt(input.email)
  const now = new Date()
  if (attempt?.locked_until && attempt.locked_until > now) {
    const secondsLeft = Math.ceil((attempt.locked_until.getTime() - now.getTime()) / 1000)
    logger.warn('Login blocked: account temporarily locked', { email: input.email, secondsLeft })
    throw new ApiError(429, `Too many failed attempts. Try again in ${secondsLeft}s.`)
  }

  const user = await findUserByEmail(input.email)
  if (!user || !user.is_active || !verifyPassword(input.password, user.password_hash)) {
    // TIMING EQUALIZATION (audit 2026-10-09): without a real bcrypt compare,
    // an unknown email answers in ~3ms while a known one costs ~75ms — a
    // reliable account-enumeration oracle. A dummy compare on the miss path
    // makes both branches cost the same. Failure counting is unchanged.
    if (!user) verifyPassword(input.password, DUMMY_BCRYPT_HASH)
    // Count every failed attempt (also for unknown emails: no user enumeration).
    const ipFailures = recordFailedLoginForIp(ip)
    if (ipFailures === LOGIN_IP_MAX_FAILURES) logger.warn('Login rate limit reached for an IP', { ip, failures: ipFailures })
    const failed = await registerFailedLoginAttempt(input.email)
    if (failed >= MAX_LOGIN_ATTEMPTS) {
      await lockLoginAttempts(input.email, LOGIN_LOCK_SECONDS)
      logger.warn('Login locked after repeated failures', { email: input.email, failed })
      throw new ApiError(
        429,
        `Too many failed attempts. Locked for ${LOGIN_LOCK_SECONDS}s. Try again after that.`
      )
    }
    throw ApiError.unauthorized('Invalid credentials')
  }

  await clearLoginAttempts(input.email)
  logger.info('User logged in', { userId: user.user_id })

  await logActivity({
    userId: user.user_id,
    action: 'LOGIN',
    entityType: 'user',
    entityId: user.user_id,
    entityName: user.email,
    meta,
  })
  return toSessionPayload(user)
}

/**
 * Self-signup switch — FAIL-CLOSED (owner decision 2026-10-14). Public
 * registration only works when TCMS_ALLOW_SIGNUP is EXACTLY the string
 * 'true' in the SERVER process environment; unset, empty, 'false' or any
 * other value keeps it off and register answers 403. This runtime check is
 * the security law — the client-side twin NEXT_PUBLIC_ALLOW_SIGNUP merely
 * hides the UI tab (it is baked in at build time and NOT a security
 * control). Sandbox/dev .env sets both flags true; production keeps both
 * false and seeds its first VP via /api/seed (TCMS_ENABLE_SEED first boot).
 */
export function isSignupAllowed(): boolean {
  return process.env.TCMS_ALLOW_SIGNUP === 'true'
}

/**
 * Self-signup (owner decisions 2026-10-08 restore + 2026-10-09 tightening
 * + 2026-10-14 signup switch). ALWAYS creates the account in the
 * least-privileged 'viewer' group — the signup form has no group picker and
 * any client-supplied role is ignored by the validator (stripped) and again
 * ignored here (defense in depth). The whole endpoint is additionally gated
 * by isSignupAllowed() (403 when the deployment switch is off). The new
 * user is signed in immediately (same session shape as login), and the
 * event is audit-logged. Role changes afterwards happen ONLY through the
 * Users page, gated by the manage_users permission.
 */
const SELF_SIGNUP_ROLE = 'viewer' as const

export async function registerUser(
  input: { fullName: string; email: string; password: string },
  meta: RequestMeta
): Promise<AuthSessionPayload> {
  // Deployment switch FIRST — before uniqueness, before any DB write.
  if (!isSignupAllowed()) {
    logger.warn('Self-signup blocked: TCMS_ALLOW_SIGNUP is not true', { email: input.email })
    throw ApiError.forbidden(
      'Self-signup is disabled on this deployment. Ask an administrator to create your account.'
    )
  }

  const existing = await findUserByEmail(input.email)
  if (existing) {
    // 409 — explicit enough for the UI, no enumeration concern here because
    // the signup form itself is the enumeration vector (standard trade-off).
    throw ApiError.conflict('An account with this email already exists. Sign in instead.')
  }

  // Hard-coded least privilege: never trust client input for the role.
  const role = SELF_SIGNUP_ROLE
  const user = await createUser({
    email: input.email,
    fullName: input.fullName,
    passwordHash: hashPassword(input.password),
    role,
  })
  logger.info('User self-registered', { userId: user.user_id, role })

  await logActivity({
    userId: user.user_id,
    action: 'CREATE',
    entityType: 'user',
    entityId: user.user_id,
    entityName: user.email,
    meta,
  })
  return toSessionPayload(user)
}

/**
 * Short-lived WebSocket ticket (audit 2026-10-09). Handed to the notifications
 * WS mini-service, which verifies it before joining the socket to the user's
 * room — replacing the old accept-anything handshake. The ticket is 60s TTL,
 * audience-scoped and grants nothing beyond the user's own live stream.
 */
export function issueWsTicket(userId: string): { ticket: string; ttlSeconds: number } {
  return { ticket: signWsTicket(userId, WS_NOTIFY_SECRET), ttlSeconds: WS_TICKET_TTL_SECONDS }
}

export async function refreshSession(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
  const stored = await findRefreshToken(refreshToken)
  if (!stored || stored.revoked || stored.expires_at < new Date()) {
    throw ApiError.unauthorized('Invalid or expired refresh token')
  }
  const payload = verifyToken<JwtPayload>(refreshToken)
  if (!payload) throw ApiError.unauthorized('Invalid refresh token')
  const user = await findUserById(payload.sub)
  if (!user || !user.is_active) throw ApiError.unauthorized('User inactive')
  // Rotate with a GRACE WINDOW instead of a hard revoke: if this response
  // never reaches the client (dropped connection, proxy hiccup, restart), the
  // client's stored token stays usable for a bounded window and the next
  // refresh heals the session instead of permanently logging the user out.
  await grantRotationGrace(refreshToken, REFRESH_ROTATION_GRACE_SECONDS)
  const session = await createSessionForUser(user)
  logger.info('Session refreshed', { userId: user.user_id })
  return { accessToken: session.accessToken, refreshToken: session.refreshToken }
}

export async function logoutSession(refreshToken?: string): Promise<{ success: true }> {
  if (refreshToken) await revokeRefreshToken(refreshToken)
  return { success: true }
}

/** GET /api/auth (me): the session's permission list must reflect a VP toggle at once,
 *  so it re-reads the (small) override table. The 3 s cache is per route module copy, so
 *  a cached read here served the old matrix for up to 3 s after a toggle (caught by
 *  verify-permission-toggle-e2e, 2026-10-17). */
export async function getProfile(userId: string): Promise<{ user: SerializedUser; permissions: string[] }> {
  const user = await findUserById(userId)
  if (!user) throw ApiError.unauthorized()
  return { user: serializeUser(user), permissions: await effectivePermissionsFresh(user.role) }
}

export async function changePassword(
  me: SessionUser,
  input: { currentPassword: string; newPassword: string },
  meta: RequestMeta
): Promise<{ success: true }> {
  const user = await findUserById(me.userId)
  if (!user) throw ApiError.unauthorized()
  if (!verifyPassword(input.currentPassword, user.password_hash)) {
    throw ApiError.badRequest('Current password is incorrect')
  }
  await updateUserPassword(me.userId, hashPassword(input.newPassword))
  // Security: a password change invalidates every live refresh token, so a
  // stolen session on another device cannot outlive the new credential.
  const revokedCount = await revokeAllRefreshTokensForUser(me.userId)
  logger.info('Password changed', { userId: me.userId, revokedRefreshTokens: revokedCount })
  await logActivity({
    userId: me.userId,
    action: 'UPDATE',
    entityType: 'user',
    entityId: me.userId,
    entityName: user.email,
    meta,
  })
  // Security alert through every enabled channel (in-app + email + Telegram).
  await createNotification({
    userId: me.userId,
    type: 'password_changed',
    title: 'Password changed',
    body: 'Your password was just changed. If this was not you, contact your administrator immediately.',
    entityType: 'user',
    entityId: me.userId,
  })
  return { success: true }
}

export async function updateProfile(
  me: SessionUser,
  input: {
    fullName?: string
    avatarUrl?: string | null
    telegramChatId?: string | null
    notifyEmail?: boolean
    notifyTelegram?: boolean
    notifyInapp?: boolean
  },
  meta: RequestMeta
): Promise<SerializedUser> {
  const before = await findUserById(me.userId)
  if (!before) throw ApiError.unauthorized()
  const updated = await updateUserProfile(me.userId, input)
  const user = updated ?? before
  await logActivity({
    userId: me.userId,
    action: 'UPDATE',
    entityType: 'user',
    entityId: me.userId,
    entityName: before.email,
    before: { fullName: before.full_name, avatarUrl: before.avatar_url },
    after: { fullName: user.full_name, avatarUrl: user.avatar_url },
    meta,
  })
  return serializeUser(user)
}
