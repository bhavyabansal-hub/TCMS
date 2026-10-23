// Activity-log repository — raw SQL inserts into activity_logs.
// Called by the logActivity() service in src/lib/activity.ts.

import { db } from '../db'

export interface ActivityLogInsert {
  userId: string | null
  action: string
  entityType: string
  entityId: string | null
  entityName: string | null
  beforeSnapshot: Record<string, unknown> | null
  afterSnapshot: Record<string, unknown> | null
  diff: Record<string, { before: unknown; after: unknown }> | null
  ipAddress: string | null
  userAgent: string | null
}

export async function insertActivityLog(entry: ActivityLogInsert): Promise<void> {
  await db.$executeRaw`
    INSERT INTO activity_logs
      (user_id, action, entity_type, entity_id, entity_name,
       before_snapshot, after_snapshot, diff, ip_address, user_agent, created_at)
    VALUES
      (${entry.userId}, ${entry.action}, ${entry.entityType}, ${entry.entityId}, ${entry.entityName},
       CAST(${entry.beforeSnapshot ? JSON.stringify(entry.beforeSnapshot) : null} AS JSON),
       CAST(${entry.afterSnapshot ? JSON.stringify(entry.afterSnapshot) : null} AS JSON),
       CAST(${entry.diff ? JSON.stringify(entry.diff) : null} AS JSON),
       ${entry.ipAddress}, ${entry.userAgent}, UTC_TIMESTAMP(3))`
}
