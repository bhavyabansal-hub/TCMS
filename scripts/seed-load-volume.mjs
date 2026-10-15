// Seeds realistic DATA VOLUME so the load test exercises real query plans,
// not empty tables. Everything is tagged with a 'LOAD-' prefix / 'loadtest'
// tag so scripts/seed-load-volume.mjs --cleanup can remove it afterwards.
// Usage: node scripts/seed-load-volume.mjs            (seed)
//        node scripts/seed-load-volume.mjs --cleanup  (remove)
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()
const CLEANUP = process.argv.includes('--cleanup')

const MODULES_SQL = `SELECT module_id FROM modules ORDER BY created_at LIMIT 8`
const USERS_SQL = `SELECT user_id FROM users WHERE is_active = true ORDER BY created_at LIMIT 10`

function pick(arr, i) { return arr[i % arr.length] }

async function cleanup() {
  const d1 = await db.$executeRawUnsafe(`DELETE FROM test_cases WHERE title LIKE 'LOAD-%'`)
  const d2 = await db.$executeRawUnsafe(`DELETE FROM bugs WHERE title LIKE 'LOAD-%'`)
  const d3 = await db.$executeRawUnsafe(`DELETE FROM activity_logs WHERE entity_name LIKE 'LOAD-%'`)
  const d4 = await db.$executeRawUnsafe(`DELETE FROM task_reports WHERE notes = 'loadtest'`)
  console.log(`cleanup: ${d1} test cases, ${d2} bugs, ${d3} activity logs, ${d4} task reports removed`)
}

async function seed() {
  const mods = (await db.$queryRawUnsafe(MODULES_SQL)).map((r) => r.module_id)
  const users = (await db.$queryRawUnsafe(USERS_SQL)).map((r) => r.user_id)
  if (!mods.length || !users.length) throw new Error('Seed the app first (POST /api/seed) — no modules/users found')
  console.log(`seeding volume across ${mods.length} modules / ${users.length} users ...`)

  // ---- 3000 test cases (batched multi-row inserts) ----
  const TC_TOTAL = 3000, BATCH = 200
  let tcInserted = 0
  for (let start = 0; start < TC_TOTAL; start += BATCH) {
    const rows = []
    for (let i = start; i < Math.min(start + BATCH, TC_TOTAL); i++) {
      const status = ['draft', 'in_review', 'approved', 'rejected'][i % 4]
      const prio = ['P0', 'P1', 'P2', 'P3'][i % 4]
      const steps = JSON.stringify([{ stepNumber: 1, action: `load step ${i}`, expected: 'ok' }])
      rows.push(`('LOAD-case-${i}', 'loadtest case body ${i}', '${status}', '${prio}', '${steps}'::jsonb, '${pick(users, i)}', '${pick(mods, i)}', NOW(), NOW())`)
    }
    await db.$executeRawUnsafe(`
      INSERT INTO test_cases (title, description, status, priority, steps, author_id, module_id, created_at, updated_at)
      VALUES ${rows.join(',')}
      ON CONFLICT DO NOTHING`)
    tcInserted += rows.length
  }
  console.log(`test cases: ${tcInserted}`)

  // ---- 600 bugs ----
  for (let start = 0; start < 600; start += 200) {
    const rows = []
    for (let i = start; i < Math.min(start + 200, 600); i++) {
      const sev = ['critical', 'high', 'medium', 'low'][i % 4]
      const st = ['open', 'in_progress', 'resolved', 'closed'][i % 4]
      rows.push(`('LOAD-bug-${i}', 'loadtest bug ${i}', '${sev}', '${st}', '${pick(users, i)}', '${pick(mods, i)}', NOW(), NOW())`)
    }
    await db.$executeRawUnsafe(`
      INSERT INTO bugs (title, description, severity, status, reported_by_id, module_id, created_at, updated_at)
      VALUES ${rows.join(',')}
      ON CONFLICT DO NOTHING`)
  }
  console.log('bugs: 600')

  // ---- 2000 activity logs ----
  const now = Date.now()
  for (let start = 0; start < 2000; start += 250) {
    const rows = []
    for (let i = start; i < Math.min(start + 250, 2000); i++) {
      const ts = new Date(now - i * 60_000).toISOString()
      rows.push(`('${pick(users, i)}', 'UPDATE', 'test_case', 'load-entity-${i}', 'LOAD-case-${i % 3000}', '{}'::jsonb, '${ts}')`)
    }
    await db.$executeRawUnsafe(`
      INSERT INTO activity_logs (user_id, action, entity_type, entity_id, entity_name, after_snapshot, created_at)
      VALUES ${rows.join(',')}
      ON CONFLICT DO NOTHING`)
  }
  console.log('activity logs: 2000')

  // ---- 300 task reports (last 30 days, for /reports) ----
  for (let start = 0; start < 300; start += 150) {
    const rows = []
    for (let i = start; i < Math.min(start + 150, 300); i++) {
      const d = new Date(now - (i % 30) * 86_400_000).toISOString().slice(0, 10)
      rows.push(`('${pick(users, i)}', '${d}'::timestamp, 480, 'loadtest', '${JSON.stringify([{ task: `load task ${i}`, minutes: 480 }])}'::jsonb, NOW(), NOW())`)
    }
    await db.$executeRawUnsafe(`
      INSERT INTO task_reports (reported_by_id, report_date, total_minutes, notes, tasks, created_at, updated_at)
      VALUES ${rows.join(',')}
      ON CONFLICT DO NOTHING`)
  }
  console.log('task reports: 300')
}

try {
  if (CLEANUP) await cleanup()
  else {
    await seed()
  }
} finally {
  await db.$disconnect()
}
