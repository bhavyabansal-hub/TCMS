// Adds the missing hot-path indexes found by the 50-VU load test.
// CONCURRENTLY so it is safe to run against a live database.
// Usage: node scripts/add-load-indexes.mjs
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()

const INDEXES = [
  // test-cases list (default sort) — full scan + sort on every page view
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "test_cases_updated_at_idx" ON "test_cases"("updated_at" DESC)`,
  // test-case recency probes + stable pagination
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "test_cases_created_at_idx" ON "test_cases"("created_at" DESC)`,
  // bugs board default sort
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "bugs_created_at_idx" ON "bugs"("created_at" DESC)`,
  // dashboard priority group-by
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "test_cases_priority_idx" ON "test_cases"("priority")`,
]

try {
  for (const sql of INDEXES) {
    const t0 = Date.now()
    await db.$executeRawUnsafe(sql)
    console.log(`ok (${Date.now() - t0}ms): ${sql}`)
  }
} finally {
  await db.$disconnect()
}
