// Notification repository — raw SQL data access for notifications.
// Contains ONLY data access: no ownership checks, no HTTP, no logging.
//
// NOTE: the notifications table has NO updated_at column (see the baseline
// migration prisma/migrations/20261017120000_baseline_numeric_ids) — updates therefore
// only touch is_read, and the charter's "every UPDATE bumps updated_at" rule
// does not apply to this table.

import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import type { NotificationSqlRow } from '@/types/sql-rows'

export interface NotificationFilters {
  /** Notifications are always scoped to ONE user (the caller). */
  userId: string
  /** Optional isRead filter — mirrors the legacy ?isRead=true|false param. */
  isRead?: boolean
}

function buildWhere(filters: NotificationFilters): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`n.user_id = ${filters.userId}`]
  if (filters.isRead !== undefined) parts.push(Prisma.sql`n.is_read = ${filters.isRead}`)
  return Prisma.sql`WHERE ${Prisma.join(parts, ' AND ')}`
}

export async function countNotifications(filters: NotificationFilters): Promise<number> {
  const rows = await db.$queryRaw<{ total: number | bigint }[]>`
    SELECT COUNT(*) AS total FROM notifications n ${buildWhere(filters)}`
  return Number(rows[0]?.total ?? 0)
}

/** One user's notifications, newest first (legacy orderBy createdAt desc). */
export async function listNotifications(
  filters: NotificationFilters,
  limit: number,
  offset: number
): Promise<NotificationSqlRow[]> {
  return db.$queryRaw<NotificationSqlRow[]>(Prisma.sql`
    SELECT n.* FROM notifications n ${buildWhere(filters)}
    ORDER BY n.created_at DESC
    LIMIT ${limit} OFFSET ${offset}`)
}

export async function findNotificationById(notificationId: string): Promise<NotificationSqlRow | null> {
  const rows = await db.$queryRaw<NotificationSqlRow[]>`
    SELECT n.* FROM notifications n WHERE n.notification_id = ${notificationId} LIMIT 1`
  return rows[0] ?? null
}

/** Marks every UNREAD notification of one user read; returns the affected
 *  row count (legacy updateMany filtered on isRead: false as well). */
export async function markAllReadForUser(userId: string): Promise<number> {
  const affected = await db.$executeRaw`
    UPDATE notifications SET is_read = true
    WHERE user_id = ${userId} AND is_read = false`
  return Number(affected)
}

/** Marks ONE notification read and returns the updated row (MySQL: no
 *  RETURNING — update, then read back; the service has already verified
 *  existence + ownership). */
export async function markNotificationRead(notificationId: string): Promise<NotificationSqlRow> {
  await db.$executeRaw`
    UPDATE notifications SET is_read = true
    WHERE notification_id = ${notificationId}`
  const rows = await db.$queryRaw<NotificationSqlRow[]>`
    SELECT n.* FROM notifications n WHERE n.notification_id = ${notificationId} LIMIT 1`
  if (!rows[0]) throw new Error('Updated notification could not be read back')
  return rows[0]
}

export async function deleteNotificationById(notificationId: string): Promise<void> {
  await db.$executeRaw`DELETE FROM notifications WHERE notification_id = ${notificationId}`
}
