// Notification service — creates in-app notifications, mirrors them to the
// optional WebSocket mini-service, and fans them out to the email / Telegram
// channels (src/lib/server/delivery.ts) according to each recipient's
// preferences. Notification persistence goes through the notification
// repository (raw SQL); user preference checks go through the shared user
// repository. External channels are fire-and-forget: they log their own
// outcome and never fail the caller.

import { logger } from './logger'
import { WS_NOTIFY_SECRET, WS_NOTIFY_TIMEOUT_MS, WS_NOTIFY_URL } from '@/lib/server/config'
import { findUserById } from './server/user.repository'
import { insertNotification } from './server/notification.repository'
import { deliverNotification } from './server/delivery'
import { after } from 'next/server'

export type NotificationType =
  | 'review_assigned'
  | 'review_approved'
  | 'review_failed'
  | 'review_needs_revision'
  | 'comment_added'
  | 'bug_assigned'
  | 'test_case_updated'
  | 'module_created'
  | 'password_changed'
  | 'daily_report_submitted'
  | 'daily_summary'

export interface CreateNotificationInput {
  userId: string
  type: NotificationType
  title: string
  body?: string
  entityType?: string
  entityId?: string
}

// Fire-and-forget broadcast to the notifications WS mini-service. The
// broadcast endpoint is loopback-only (see mini-services/notifications).
// When the service is absent the app degrades to REFRESH-VISIBLE delivery:
// the DB row below is the guaranteed channel and the client sees it on its
// next list fetch (page load, socket reconnect, tab re-visible) — there are
// NO polling timers anywhere in this app (`docs/architecture/realtime-and-notifications.md` §1).
// URL comes from the central config (WS_NOTIFY_URL, default 127.0.0.1:3004).

async function broadcastToWs(payload: {
  userId: string
  type: string
  title: string
  body?: string
  entityType?: string
  entityId?: string
}): Promise<void> {
  try {
    await fetch(WS_NOTIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Shared secret (audit 2026-10-09): the mini-service rejects /notify
        // calls that cannot prove they came from this app.
        ...(WS_NOTIFY_SECRET ? { 'x-notify-secret': WS_NOTIFY_SECRET } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(WS_NOTIFY_TIMEOUT_MS),
    })
  } catch {
    // Don't fail (or spam logs for) the main operation if the WS service is unavailable.
  }
}

export async function createNotification(input: CreateNotificationInput) {
  try {
    const user = await findUserById(input.userId)
    if (!user || !user.is_active || !user.notify_inapp) return null

    const notif = await insertNotification({
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
    })

    // Not awaited: a slow or hung WS service must never delay the request
    // (broadcastToWs has its own timeout and never throws).
    void broadcastToWs({
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      entityType: input.entityType,
      entityId: input.entityId,
    })

    // Fan out to email / Telegram per the recipient's channel preferences.
    // deliverNotification never throws; the catch is belt-and-suspenders so
    // delivery can never break the business operation that notified.
    //
    // Scheduled with after() so the send runs after the response is sent (the
    // request never waits for SMTP / Telegram); fire-and-forget when no request
    // scope exists (scripts).
    const deliveryTarget = {
      email: user.email,
      telegramChatId: user.telegram_chat_id,
      notifyEmail: user.notify_email,
      notifyTelegram: user.notify_telegram,
    }
    const deliveryPayload = { subject: `[TCMS] ${input.title}`, body: input.body }
    try {
      after(async () => {
        await deliverNotification(deliveryTarget, deliveryPayload)
      })
    } catch {
      void deliverNotification(deliveryTarget, deliveryPayload).catch(() => undefined)
    }

    return notif
  } catch (err) {
    logger.error('Failed to create notification', err, { type: input.type, userId: input.userId })
    return null
  }
}
