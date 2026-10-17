// Notification repository — raw SQL access to the notifications table.
// Called by the createNotification() service in src/lib/notifications.ts.

import { Prisma } from '@prisma/client'
import { db } from '../db'
import { insertReturningId } from './insert'
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
  // MySQL has no RETURNING: insert, take the new key from LAST_INSERT_ID(), then read back.
  const notificationId = await insertReturningId(Prisma.sql`
    INSERT INTO notifications (user_id, type, title, body, entity_type, entity_id, created_at)
    VALUES (${input.userId}, ${input.type}, ${input.title}, ${input.body}, ${input.entityType}, ${input.entityId}, UTC_TIMESTAMP(3))`)
  const rows = await db.$queryRaw<NotificationSqlRow[]>`
    SELECT * FROM notifications WHERE notification_id = ${notificationId} LIMIT 1`
  if (!rows[0]) throw new Error('Inserted notification could not be read back')
  return rows[0]
}
