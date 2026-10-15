// Notification repository — raw SQL access to the notifications table.
// Called by the createNotification() service in src/lib/notifications.ts.

import { db } from '../db'
import { newId } from './id'
import type { NotificationSqlRow } from '@/types/sql-rows'

export interface NotificationInsert {
  userId: string
  type: string
  title: string
  body: string | null
  entityType: string | null
  entityId: string | null
}

export async function insertNotification(input: NotificationInsert): Promise<NotificationSqlRow> {
  // MySQL has no RETURNING: generate the PK app-side, insert, then read back.
  const notificationId = newId()
  await db.$executeRaw`
    INSERT INTO notifications (notification_id, user_id, type, title, body, entity_type, entity_id, created_at)
    VALUES (${notificationId}, ${input.userId}, ${input.type}, ${input.title}, ${input.body}, ${input.entityType}, ${input.entityId}, UTC_TIMESTAMP(3))`
  const rows = await db.$queryRaw<NotificationSqlRow[]>`
    SELECT * FROM notifications WHERE notification_id = ${notificationId} LIMIT 1`
  if (!rows[0]) throw new Error('Inserted notification could not be read back')
  return rows[0]
}
