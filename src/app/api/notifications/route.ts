// Controller for /api/notifications — thin HTTP adapter.
// Parses the request, delegates to validators + services, returns responses.
// NO business logic and NO SQL live here. All endpoints require a session;
// notifications are always scoped to the current user.

import type { NextRequest } from 'next/server'
import { withApi, ok, getQueryParams } from '@/lib/api'
import { requireUser } from '@/lib/auth'
import {
  deleteMyNotification,
  listMyNotifications,
  markAllMyNotificationsRead,
  markMyNotificationRead,
} from './notifications.service'
import {
  validateIsReadFilter,
  validateNotificationIdParam,
  validateReadAllAction,
} from './notifications.validation'

/** GET /api/notifications -> my notifications (optional ?isRead, paginated) */
export async function GET(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const q = getQueryParams(req)
    const isRead = validateIsReadFilter(q)
    return ok(await listMyNotifications(me, q, isRead))
  })
}

/** POST /api/notifications?action=read-all -> mark ALL my notifications read */
export async function POST(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    validateReadAllAction(getQueryParams(req))
    return ok(await markAllMyNotificationsRead(me))
  })
}

/** PATCH /api/notifications?id=... -> mark ONE of my notifications read */
export async function PATCH(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const { id } = getQueryParams(req)
    const notificationId = validateNotificationIdParam(id)
    return ok(await markMyNotificationRead(me, notificationId))
  })
}

/** DELETE /api/notifications?id=... -> delete ONE of my notifications */
export async function DELETE(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const { id } = getQueryParams(req)
    const notificationId = validateNotificationIdParam(id)
    return ok(await deleteMyNotification(me, notificationId))
  })
}
