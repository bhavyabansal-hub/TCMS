// Auth repository — raw SQL access for users (auth flows) and refresh_tokens.
// General user CRUD for the users resource lives in src/app/api/users/.

import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { newId } from '@/lib/server/id'
import type { UserSqlRow, RefreshTokenSqlRow, LoginAttemptSqlRow } from '@/types/sql-rows'

// ---------- Login attempts (brute-force guard: 5 fails -> 1 min lock) ----------

export const MAX_LOGIN_ATTEMPTS = 5
export const LOGIN_LOCK_SECONDS = 60

export async function findLoginAttempt(email: string): Promise<LoginAttemptSqlRow | null> {
  const rows = await db.$queryRaw<LoginAttemptSqlRow[]>`
    SELECT email, failed_attempts, locked_until, updated_at
    FROM login_attempts WHERE email = ${email}
    LIMIT 1`
  return rows[0] ?? null
}

/** Records one failed attempt and returns the new failed-attempts count.
 *  MySQL: no RETURNING — upsert, then read the row back. */
export async function registerFailedLoginAttempt(email: string): Promise<number> {
  await db.$executeRaw`
    INSERT INTO login_attempts (email, failed_attempts, updated_at)
    VALUES (${email}, 1, UTC_TIMESTAMP(3))
    ON DUPLICATE KEY UPDATE
      failed_attempts = failed_attempts + 1,
      updated_at = UTC_TIMESTAMP(3)`
  const rows = await db.$queryRaw<{ failed_attempts: number }[]>`
    SELECT failed_attempts FROM login_attempts WHERE email = ${email} LIMIT 1`
  return Number(rows[0]?.failed_attempts ?? 1)
}

/** Locks the email for N seconds and resets the counter (fresh 5 after expiry). */
export async function lockLoginAttempts(email: string, seconds: number): Promise<void> {
  await db.$executeRaw`
    UPDATE login_attempts
    SET locked_until = UTC_TIMESTAMP(3) + INTERVAL ${seconds} SECOND,
        failed_attempts = 0,
        updated_at = UTC_TIMESTAMP(3)
    WHERE email = ${email}`
}

/** Successful login wipes the attempt history for the email. */
export async function clearLoginAttempts(email: string): Promise<void> {
  await db.$executeRaw`DELETE FROM login_attempts WHERE email = ${email}`
}

export async function createUser(input: {
  email: string
  fullName: string
  passwordHash: string
  role: string
}): Promise<UserSqlRow> {
  // MySQL has no RETURNING: generate the PK app-side, insert, then read back.
  const userId = newId()
  await db.$executeRaw`
    INSERT INTO users (user_id, email, full_name, password_hash, role, created_at, updated_at)
    VALUES (${userId}, ${input.email}, ${input.fullName}, ${input.passwordHash}, ${input.role}, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`
  const rows = await db.$queryRaw<UserSqlRow[]>`
    SELECT * FROM users WHERE user_id = ${userId} LIMIT 1`
  return rows[0]
}

export async function countUsers(): Promise<number> {
  const rows = await db.$queryRaw<{ total: number | bigint }[]>`
    SELECT COUNT(*) AS total FROM users`
  return Number(rows[0]?.total ?? 0)
}

export interface RefreshTokenInsert {
  userId: string
  token: string
  expiresAt: Date
}

export async function insertRefreshToken(input: RefreshTokenInsert): Promise<void> {
  await db.$executeRaw`
    INSERT INTO refresh_tokens (user_id, token, expires_at, created_at)
    VALUES (${input.userId}, ${input.token}, ${input.expiresAt}, UTC_TIMESTAMP(3))`
}

export async function findRefreshToken(token: string): Promise<RefreshTokenSqlRow | null> {
  const rows = await db.$queryRaw<RefreshTokenSqlRow[]>`
    SELECT * FROM refresh_tokens WHERE token = ${token} LIMIT 1`
  return rows[0] ?? null
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await db.$executeRaw`
    UPDATE refresh_tokens SET revoked = true WHERE token = ${token}`
}

/**
 * Rotation grace window: when a refresh token is EXCHANGED (rotated), the old
 * token is not hard-revoked — its expiry is capped at `seconds` from now.
 *
 * Why: rotation is "revoke old + issue new" in one request. If the response is
 * lost (tab closed mid-flight, proxy/gateway hiccup, server restart between
 * write and reply), the client keeps a token that a hard revoke has already
 * killed — its NEXT hard refresh fails and the user is permanently logged out.
 * Leaving the old token valid for a short bounded window lets that exact retry
 * heal itself, while `revoked` stays reserved for real revocations (logout,
 * password change) which must kill sessions immediately.
 * Security bound: a replayed old token is usable for at most `seconds`.
 */
export const REFRESH_ROTATION_GRACE_SECONDS = 120

export async function grantRotationGrace(token: string, seconds: number): Promise<void> {
  // ONE-SHOT grace (audit 2026-10-09): the extra `expires_at > UTC_TIMESTAMP(3)+seconds`
  // condition means this UPDATE can only ever SHORTEN the old token's life,
  // never extend it. Without that guard, replaying the pre-rotation token
  // re-capped expires_at on every attempt — a stolen token replayed every
  // <2 min stayed alive indefinitely. Now the heal window is strictly
  // bounded to the first 2 minutes after the rotation that granted it.
  await db.$executeRaw`
    UPDATE refresh_tokens
    SET expires_at = LEAST(expires_at, UTC_TIMESTAMP(3) + INTERVAL ${seconds} SECOND)
    WHERE token = ${token}
      AND expires_at > UTC_TIMESTAMP(3) + INTERVAL ${seconds} SECOND`
}

/** Revoke EVERY live refresh token for a user (password change → log out
 *  everywhere). Tokens already revoked are left untouched. */
export async function revokeAllRefreshTokensForUser(userId: string): Promise<number> {
  const result = await db.$executeRaw`
    UPDATE refresh_tokens SET revoked = true
    WHERE user_id = ${userId} AND revoked = false`
  return Number(result)
}

export async function updateUserPassword(userId: string, passwordHash: string): Promise<void> {
  await db.$executeRaw`
    UPDATE users SET password_hash = ${passwordHash}, updated_at = UTC_TIMESTAMP(3)
    WHERE user_id = ${userId}`
}

export interface ProfileUpdateFields {
  fullName?: string
  avatarUrl?: string | null
  telegramChatId?: string | null
  notifyEmail?: boolean
  notifyTelegram?: boolean
  notifyInapp?: boolean
}

export async function updateUserProfile(
  userId: string,
  fields: ProfileUpdateFields
): Promise<UserSqlRow | null> {
  const sets: Prisma.Sql[] = []
  if (fields.fullName !== undefined) sets.push(Prisma.sql`full_name = ${fields.fullName}`)
  if (fields.avatarUrl !== undefined) sets.push(Prisma.sql`avatar_url = ${fields.avatarUrl}`)
  if (fields.telegramChatId !== undefined) sets.push(Prisma.sql`telegram_chat_id = ${fields.telegramChatId}`)
  if (fields.notifyEmail !== undefined) sets.push(Prisma.sql`notify_email = ${fields.notifyEmail}`)
  if (fields.notifyTelegram !== undefined) sets.push(Prisma.sql`notify_telegram = ${fields.notifyTelegram}`)
  if (fields.notifyInapp !== undefined) sets.push(Prisma.sql`notify_inapp = ${fields.notifyInapp}`)
  if (sets.length === 0) return null // nothing to change
  sets.push(Prisma.sql`updated_at = UTC_TIMESTAMP(3)`)
  await db.$executeRaw`
    UPDATE users SET ${Prisma.join(sets)} WHERE user_id = ${userId}`
  const rows = await db.$queryRaw<UserSqlRow[]>`
    SELECT * FROM users WHERE user_id = ${userId} LIMIT 1`
  return rows[0] ?? null
}
