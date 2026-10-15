// One-shot: apply the dashboard/notification performance indexes live.
// Idempotent (IF NOT EXISTS) — safe to re-run. Mirrors prisma/database-setup.sql.
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

const STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS "activity_logs_created_at_idx" ON "activity_logs"("created_at")`,
  `CREATE INDEX IF NOT EXISTS "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at")`,
]

for (const sql of STATEMENTS) {
  await db.$executeRawUnsafe(sql)
  console.log('applied:', sql)
}

const rows = await db.$queryRaw`
  SELECT indexname FROM pg_indexes
  WHERE indexname IN ('activity_logs_created_at_idx', 'notifications_user_id_created_at_idx')
  ORDER BY indexname`
console.log('verified:', rows.map((r) => r.indexname).join(', '))
await db.$disconnect()
