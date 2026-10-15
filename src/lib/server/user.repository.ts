// Shared user repository — raw SQL data access for cross-cutting lookups
// (authentication, notifications) that every resource relies on.
// Resource-specific user CRUD lives in src/app/api/users/.

import { Prisma } from '@prisma/client'
import { db } from '../db'
import { effectivePermissionsFresh } from '../permissions'
import type { PermissionAction } from '@/types'
import type { UserSqlRow } from '@/types/sql-rows'

/** MySQL stores BOOLEAN as TINYINT(1) — raw SELECTs return 1/0, not JS
 *  booleans. Normalize the boolean columns at this read boundary: some
 *  consumers (notification delivery target) use strict `=== true` checks. */
function normalizeUserRow(row: UserSqlRow): UserSqlRow {
  return {
    ...row,
    is_active: Boolean(row.is_active),
    notify_email: Boolean(row.notify_email),
    notify_telegram: Boolean(row.notify_telegram),
    notify_inapp: Boolean(row.notify_inapp),
  }
}

export async function findUserById(userId: string): Promise<UserSqlRow | null> {
  const rows = await db.$queryRaw<UserSqlRow[]>`
    SELECT * FROM users WHERE user_id = ${userId} LIMIT 1`
  return rows[0] ? normalizeUserRow(rows[0]) : null
}

/**
 * Every ACTIVE user whose role holds `action` (defaults + live overrides),
 * used for notification fan-out to permission holders (e.g. daily work-log
 * reports -> view_all_task_reports holders). Roles with no active members
 * are naturally skipped by the final role IN (...) filter.
 */
export async function listActiveUsersHoldingPermission(action: PermissionAction): Promise<UserSqlRow[]> {
  const roleRows = await db.$queryRaw<{ role: string }[]>`
    SELECT DISTINCT role FROM users WHERE is_active = true`
  const holding: string[] = []
  for (const { role } of roleRows) {
    if ((await effectivePermissionsFresh(role)).includes(action)) holding.push(role)
  }
  if (holding.length === 0) return []
  const rows = await db.$queryRaw<UserSqlRow[]>`
    SELECT * FROM users WHERE is_active = true AND role IN (${Prisma.join(holding)})`
  return rows.map(normalizeUserRow)
}

export async function findUserByEmail(email: string): Promise<UserSqlRow | null> {
  const rows = await db.$queryRaw<UserSqlRow[]>`
    SELECT * FROM users WHERE email = ${email} LIMIT 1`
  return rows[0] ? normalizeUserRow(rows[0]) : null
}

/**
 * First active reviewer by hierarchy (VP or Manager), used to auto-pick.
 * Managers are preferred over the VP (reviews route to the working lead;
 * the VP stays the escalation path), then by seniority (created_at).
 * `excludeUserId` (the submitter) is skipped so a submitter never auto-reviews
 * their own case; if they are the ONLY active vp/manager the exclusion is
 * relaxed rather than failing the submission.
 */
export async function findFirstActiveReviewer(excludeUserId?: string): Promise<UserSqlRow | null> {
  const rows = excludeUserId
    ? await db.$queryRaw<UserSqlRow[]>`
        SELECT * FROM users
        WHERE is_active = true AND role IN ('vp', 'manager') AND user_id <> ${excludeUserId}
        ORDER BY CASE WHEN role = 'manager' THEN 0 ELSE 1 END, created_at ASC
        LIMIT 1`
    : await db.$queryRaw<UserSqlRow[]>`
        SELECT * FROM users
        WHERE is_active = true AND role IN ('vp', 'manager')
        ORDER BY CASE WHEN role = 'manager' THEN 0 ELSE 1 END, created_at ASC
        LIMIT 1`
  if (rows[0]) return normalizeUserRow(rows[0])
  // Fallback: submitter was the only candidate (single-lead deployment).
  return excludeUserId ? findFirstActiveReviewer() : null
}
