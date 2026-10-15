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
import { JWT_SECRET } from '@/lib/server/config'

const ACCESS_TOKEN_TTL = '15m'
const REFRESH_TOKEN_TTL_DAYS = 7

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
  return jwt.sign({ ...payload, jti: randomUUID() }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL })
}

export function signRefreshToken(payload: JwtPayload): string {
  // Refresh tokens MUST be unique — add jti + random entropy.
  return jwt.sign(
    { ...payload, jti: randomUUID(), nonce: Math.random().toString(36).slice(2) },
    JWT_SECRET,
    { expiresIn: `${REFRESH_TOKEN_TTL_DAYS}d` }
  )
}

export function verifyToken<T = JwtPayload>(token: string): T | null {
  try {
    return jwt.verify(token, JWT_SECRET) as T
  } catch {
    return null
  }
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
  const payload = verifyToken<JwtPayload>(token)
  if (!payload) return null
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
