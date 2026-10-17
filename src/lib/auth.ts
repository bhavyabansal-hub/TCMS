// Authentication & authorization primitives (no direct database access —
// data reads go through the repository layer, e.g. the session revalidation
// below reads via user.repository).
//
// Token storage lives in the auth resource layer (src/app/api/auth/):
// services call insertRefreshToken / revokeRefreshTokens there.
// Every route must gate access through requireUser() / requirePermission()
// (or getCurrentUser() when a null check is more natural).
//
// Roles & permissions live in src/lib/permissions.ts: a 6-role hierarchy
// (vp > manager > product > developer > qa_engineer > viewer) whose matrix
// the VP can toggle at runtime (role_permissions table). can() is re-exported
// here so existing call sites keep a single import path.

import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'crypto'
import { ApiError } from './api'
import type { PermissionAction } from '@/types'
import { can, ensurePermissionsLoaded } from './permissions'
import { findUserById } from './server/user.repository'
import { ACCESS_TOKEN_MINUTES, JWT_SECRET, REFRESH_TOKEN_DAYS } from '@/lib/server/config'

// Lifetimes come from .env (TCMS_ACCESS_TOKEN_MINUTES / TCMS_REFRESH_TOKEN_DAYS).
const ACCESS_TOKEN_TTL_SECONDS = ACCESS_TOKEN_MINUTES * 60
const REFRESH_TOKEN_TTL_DAYS = REFRESH_TOKEN_DAYS
/** Only HS256 is accepted (no algorithm confusion, no 'none'). */
const JWT_ALGORITHM = 'HS256' as const

/** Token kind claim: an access token is never accepted where a refresh token
 *  belongs and vice versa (security test 2026-10-17: a 7-day refresh token used
 *  to work as a Bearer access token, even after logout). */
export type TokenKind = 'access' | 'refresh'

export interface JwtPayload {
  sub: string
  email: string
  role: string
  fullName: string
}

// ---------- Passwords ----------

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 10)
}

export function verifyPassword(plain: string, hash: string): boolean {
  return bcrypt.compareSync(plain, hash)
}

// ---------- Tokens ----------

export function signAccessToken(payload: JwtPayload): string {
  // Include a unique jti so tokens issued within the same second don't collide.
  return jwt.sign({ ...payload, typ: 'access', jti: randomUUID() }, JWT_SECRET, {
    algorithm: JWT_ALGORITHM,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  })
}

export function signRefreshToken(payload: JwtPayload): string {
  // Refresh tokens MUST be unique — add jti + random entropy.
  return jwt.sign(
    { ...payload, typ: 'refresh', jti: randomUUID(), nonce: randomUUID() },
    JWT_SECRET,
    { algorithm: JWT_ALGORITHM, expiresIn: REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 }
  )
}

/** Verifies signature, expiry and the token kind; null when any check fails. */
export function verifyToken<T = JwtPayload>(token: string, kind: TokenKind = 'access'): T | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALGORITHM] }) as T & { typ?: string }
    return payload.typ === kind ? payload : null
  } catch {
    return null
  }
}

// ---------- Session revocation (logout / password change) ----------
//
// Access JWTs are stateless, so logout used to leave the copied access token
// working until it expired. Revoked access-token ids (until their own expiry)
// and a per-user "not before" time live on globalThis: every route module copy
// sees the same store. Single instance by design (HLD); a second instance needs
// a shared store (backlog).

interface RevocationStore {
  jtis: Map<string, number>
  userNotBefore: Map<string, number>
}
const globalForRevocation = globalThis as unknown as { tcmsRevocations?: RevocationStore }
const revocations: RevocationStore =
  globalForRevocation.tcmsRevocations ?? (globalForRevocation.tcmsRevocations = { jtis: new Map(), userNotBefore: new Map() })

interface TokenTimes {
  jti?: string
  iat?: number
  exp?: number
}

/** Logout: the given access token stops working at once. */
export function revokeAccessToken(token: string | null | undefined): void {
  if (!token) return
  const payload = verifyToken<JwtPayload & TokenTimes>(token)
  if (!payload?.jti || !payload.exp) return
  const now = Date.now()
  for (const [jti, expiresAt] of revocations.jtis) if (expiresAt < now) revocations.jtis.delete(jti)
  revocations.jtis.set(payload.jti, payload.exp * 1000)
}

/** Password change: every access token issued to this user before now stops working. */
export function revokeUserSessions(userId: string): void {
  revocations.userNotBefore.set(userId, Math.floor(Date.now() / 1000))
}

function isRevoked(payload: JwtPayload & TokenTimes): boolean {
  if (payload.jti && revocations.jtis.has(payload.jti)) return true
  const notBefore = revocations.userNotBefore.get(payload.sub)
  return notBefore !== undefined && (payload.iat ?? 0) < notBefore
}

export function refreshTtlDays(): number {
  return REFRESH_TOKEN_TTL_DAYS
}

// ---------- Current user (Authorization: Bearer header, then tcms-access cookie) ----------

export interface SessionUser {
  userId: string
  email: string
  role: string
  fullName: string
}

// DB-revalidation cache (audit 2026-10-09): a JWT alone used to be trusted
// verbatim for its whole 15-min TTL — a demoted/deactivated user (or a forged
// token with an invented sub) kept working for up to 15 minutes. Now the
// user row is re-checked at most every 30s per user: one tiny indexed SELECT,
// and role/is_active decisions always come from the DATABASE.
const DB_REVALIDATION_TTL_MS = 30_000
const userRevalidationCache = new Map<string, { role: string; email: string; fullName: string; checkedAt: number }>()

async function revalidateUser(sub: string): Promise<{ role: string; email: string; fullName: string } | null> {
  const cached = userRevalidationCache.get(sub)
  if (cached && Date.now() - cached.checkedAt < DB_REVALIDATION_TTL_MS) {
    return { role: cached.role, email: cached.email, fullName: cached.fullName }
  }
  try {
    // Read through the shared user repository (raw SQL lives ONLY in
    // repositories by project rule). The repository normalizes MySQL's
    // TINYINT(1) booleans, so is_active arrives as a real boolean here.
    const row = await findUserById(sub)
    if (!row || !row.is_active) {
      userRevalidationCache.delete(sub)
      return null
    }
    userRevalidationCache.set(sub, { role: row.role, email: row.email, fullName: row.full_name, checkedAt: Date.now() })
    return { role: row.role, email: row.email, fullName: row.full_name }
  } catch {
    // DB unreachable: fall back to the token claims so a transient blip
    // doesn't hard-kill every session (availability over strictness here —
    // every WRITE path still hits the DB through the repositories anyway).
    return cached ? { role: cached.role, email: cached.email, fullName: cached.fullName } : null
  }
}

/**
 * Resolve the acting user from the current request context.
 * Order of precedence (mirrors the documented client contract):
 *   1. `Authorization: Bearer <token>` header — what the SPA and API
 *      consumers send on every call.
 *   2. Mirrored `tcms-access` cookie — server-side fallback.
 * Returns null (never throws) when neither carries a valid token, when the
 * subject user no longer exists / is deactivated, or when the DB disagrees
 * with the token's role (the DB value wins).
 */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const token = await resolveSessionToken()
  if (!token) return null
  const payload = verifyToken<JwtPayload & TokenTimes>(token)
  if (!payload || isRevoked(payload)) return null
  const fresh = await revalidateUser(payload.sub)
  if (!fresh) return null
  return {
    userId: payload.sub,
    email: fresh.email,
    role: fresh.role,
    fullName: fresh.fullName,
  }
}

/** Token from the Authorization header, falling back to the mirrored cookie. */
async function resolveSessionToken(): Promise<string | null> {
  const { headers, cookies } = await import('next/headers')
  const authz = (await headers()).get('authorization')
  if (authz?.startsWith('Bearer ')) {
    const bearer = authz.slice('Bearer '.length).trim()
    if (bearer) return bearer
  }
  return (await cookies()).get('tcms-access')?.value ?? null
}

/** Like getCurrentUser() but throws the standard 401 ApiError when missing. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser()
  if (!user) throw ApiError.unauthorized()
  // Converge the permission cache on every request (TTL-gated — normally a
  // no-op). Guarantees a VP toggle is honored by every route within the
  // cache TTL instead of whenever each route's copy of the cache happens to
  // expire.
  await ensurePermissionsLoaded()
  return user
}

// ---------- Roles & permissions ----------

// Single source of truth for the hierarchy, defaults and the togglable
// permission matrix. Re-exported so call sites keep importing from '@/lib/auth'.
export {
  ROLE_HIERARCHY,
  DEFAULT_PERMISSIONS,
  can,
  canAny,
  effectivePermissionsFor,
  effectivePermissionsFresh,
  ensurePermissionsLoaded,
  invalidatePermissionCache,
} from './permissions'

export type { PermissionAction }

/** Throws the standard 403 ApiError when the role lacks the action. */
export async function requirePermission(action: PermissionAction, message = 'Insufficient role'): Promise<SessionUser> {
  const user = await requireUser()
  if (!can(user.role, action)) throw ApiError.forbidden(message)
  return user
}

/** Permission check for a user the caller already resolved (no extra cookie read). */
export function ensurePermission(user: SessionUser, action: PermissionAction, message = 'Insufficient role'): void {
  if (!can(user.role, action)) throw ApiError.forbidden(message)
}
