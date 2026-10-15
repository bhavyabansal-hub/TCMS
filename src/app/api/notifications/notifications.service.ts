// Notification service — business logic and orchestration.
//
// Owns: the strict "my notifications only" scoping (every query is locked to
// the caller's userId), the ownership guard shared by PATCH/DELETE, and
// serialization. Data access goes exclusively through the repository;
// responses are produced exclusively through the serializer.

import { ApiError, getPagination, paginate, type PaginatedResponse } from '@/lib/api'
import type { SessionUser } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { serializeNotification, type SerializedNotification } from '@/lib/serializers'
import type { NotificationSqlRow } from '@/types/sql-rows'
import {
  countNotifications,
  deleteNotificationById,
  findNotificationById,
  listNotifications,
  markAllReadForUser,
  markNotificationRead,
  type NotificationFilters,
} from './notifications.repository'

// ---------- Queries ----------

/** GET /api/notifications — the current user's notifications, newest first.
 *  Legacy default pageSize is 50 (getPagination also clamps page/pageSize). */
export async function listMyNotifications(
  me: SessionUser,
  q: Record<string, string>,
  isRead?: boolean
): Promise<PaginatedResponse<SerializedNotification>> {
  const { page, pageSize, offset } = getPagination(q, 50)
  const filters: NotificationFilters = { userId: me.userId, isRead }
  const [total, rows] = await Promise.all([
    countNotifications(filters),
    listNotifications(filters, pageSize, offset),
  ])
  return paginate(rows.map(serializeNotification), total, page, pageSize)
}

// ---------- Commands ----------

/** POST ?action=read-all — marks ALL of my unread notifications read.
 *  Returns { success: true } like the legacy route. */
export async function markAllMyNotificationsRead(me: SessionUser): Promise<{ success: true }> {
  const updatedCount = await markAllReadForUser(me.userId)
  logger.info('All notifications marked read', { userId: me.userId, updatedCount })
  return { success: true }
}

/** PATCH ?id=... — mark ONE of my notifications read and return it.
 *  Legacy check order preserved: missing id (400, in the controller) ->
 *  not found (404) -> ownership (403 per charter §6.4, was 400). */
export async function markMyNotificationRead(
  me: SessionUser,
  notificationId: string
): Promise<SerializedNotification> {
  const notif = await findNotificationById(notificationId)
  if (!notif) throw ApiError.notFound('Notification not found')
  ensureNotificationOwner(me, notif)
  const updated = await markNotificationRead(notificationId)
  logger.info('Notification marked read', { notificationId, userId: me.userId })
  return serializeNotification(updated)
}

/** DELETE ?id=... — delete ONE of my notifications.
 *  Same check order as PATCH; returns { success: true } like the legacy route. */
export async function deleteMyNotification(
  me: SessionUser,
  notificationId: string
): Promise<{ success: true }> {
  const notif = await findNotificationById(notificationId)
  if (!notif) throw ApiError.notFound('Notification not found')
  ensureNotificationOwner(me, notif)
  await deleteNotificationById(notificationId)
  logger.info('Notification deleted', { notificationId, userId: me.userId })
  return { success: true }
}

// ---------- Helpers ----------

/** Ownership guard: a notification is only ever manageable by its recipient.
 *  Charter §6.4 intentional change: violations now answer 403 instead of the
 *  legacy 400; the legacy message is kept verbatim for frontend toasts. */
function ensureNotificationOwner(me: SessionUser, notif: NotificationSqlRow): void {
  if (notif.user_id !== me.userId) throw ApiError.forbidden('Not your notification')
}
