// One-off data migration: PostgreSQL (read-only SOURCE) -> MySQL 8.4 TEST schema.
// - dependency-safe table order (parents before children)
// - batched INSERT ... AS new ON DUPLICATE KEY UPDATE (re-runnable / idempotent)
// - --dry-run: counts + samples only, zero writes
// - --truncate: empty MySQL tables first (disposable seed data -> real copy)
// Usage:
//   node scripts/migration/migrate-pg-to-mysql.mjs --dry-run
//   node scripts/migration/migrate-pg-to-mysql.mjs --truncate
// Reads PG_SOURCE_URL and DATABASE_URL (mysql) from .env via node --env-file.
import { PrismaClient } from '@prisma/client'

const args = process.argv.slice(2)
const DRY = args.includes('--dry-run')
const TRUNCATE = args.includes('--truncate')

const PG_URL = process.env.PG_SOURCE_URL
const MY_URL = process.env.DATABASE_URL
if (!PG_URL || !PG_URL.startsWith('postgres') || !MY_URL || !MY_URL.startsWith('mysql')) {
  console.error('Need PG_SOURCE_URL (postgres) and DATABASE_URL (mysql) — run with: node --env-file=.env ...')
  process.exit(1)
}

// Read-only source: dedicated PostgreSQL-provider Prisma client (the app
// schema is now MySQL-only, so the main client cannot open PG connections).
const { PrismaClient: PgClient } = await import('../pg-client/index.js')
const pg = new PgClient({ datasources: { db: { url: PG_URL } } })
const my = new PrismaClient({ datasources: { db: { url: MY_URL } } })

// Parents before children (mirrors scripts/backup-db.mjs TABLES_IN_ORDER).
const TABLES = [
  'users',
  'role_permissions',
  'login_attempts',
  'modules', // self-ref parent_id: PG order by created_at keeps parents first
  'refresh_tokens',
  'test_cases',
  'test_case_history',
  'module_review_requests',
  'review_requests',
  'review_events',
  'bugs',
  'bug_test_case_links',
  'task_reports',
  'notifications',
  'activity_logs',
  'crew_desk_links',
  'wiki_documents',
]

const JSON_TABLE_COLS = {
  test_cases: ['steps', 'tags', 'attachments'],
  test_case_history: ['snapshot'],
  review_events: ['flagged_fields'],
  bugs: ['attachments'],
  task_reports: ['tasks'],
  activity_logs: ['before_snapshot', 'after_snapshot', 'diff'],
  wiki_documents: ['tags'],
}

async function mysqlColumns(table) {
  const cols = await my.$queryRawUnsafe(
    `SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    table
  )
  return cols
}

function toMysqlValue(v, dataType) {
  if (v === null || v === undefined) return null
  if (dataType === 'json') return JSON.stringify(v)
  if (dataType === 'tinyint' && typeof v === 'boolean') return v ? 1 : 0
  if (v instanceof Date) return v
  if (dataType === 'datetime') return v instanceof Date ? v : new Date(v)
  if (Buffer.isBuffer(v)) return v
  return v
}

async function main() {
  const report = { tables: [], differences: [], probes: [] }
  const totals = {}

  // Row counts on both sides first (dry-run evidence + verification baseline)
  for (const t of TABLES) {
    const pgCount = await pg.$queryRawUnsafe(`SELECT COUNT(*) AS c FROM "${t}"`)
    totals[t] = { pg: Number(pgCount[0]?.c ?? 0), my: 0 }
  }

  if (DRY) {
    console.log('== DRY RUN (no writes) ==')
    for (const t of TABLES) {
      console.log(`${t.padEnd(24)} pg=${String(totals[t].pg).padStart(5)}  mysql(pre)=?`)
      if (totals[t].pg > 0) {
        const sample = await pg.$queryRawUnsafe(`SELECT * FROM "${t}" ORDER BY 1 LIMIT 1`)
        console.log(`   sample keys: ${Object.keys(sample[0] ?? {}).slice(0, 8).join(', ')}`)
      }
    }
    await pg.$disconnect(); await my.$disconnect()
    return
  }

  if (TRUNCATE) {
    console.log('== truncating MySQL target tables (disposable data only) ==')
    await my.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS=0')
    for (const t of [...TABLES].reverse()) {
      await my.$executeRawUnsafe(`TRUNCATE TABLE \`${t}\``)
    }
    await my.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS=1')
  }

  // Bulk-load pattern: defer FK enforcement during the copy; the FK-orphan
  // audit at the end proves referential integrity of the result.
  await my.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS=0')
  try {
  const BATCH = 500
  for (const t of TABLES) {
    const colsInfo = await mysqlColumns(t)
    const colNames = colsInfo.map((c) => c.COLUMN_NAME)
    const colTypes = Object.fromEntries(colsInfo.map((c) => [c.COLUMN_NAME, c.DATA_TYPE]))
    const rows = await pg.$queryRawUnsafe(`SELECT * FROM "${t}" ORDER BY 1`)
    let written = 0
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH)
      for (const row of batch) {
        const useCols = colNames.filter((c) => c in row)
        const vals = useCols.map((c) => toMysqlValue(row[c], colTypes[c]))
        const placeholders = useCols.map(() => '?').join(', ')
        const updateClause = useCols
          .filter((c) => !useCols.includes(colNames[0]) || c !== colNames[0]) // keep PK stable
          .map((c) => `\`${c}\` = new.\`${c}\``)
          .join(', ')
        await my.$executeRawUnsafe(
          `INSERT INTO \`${t}\` (${useCols.map((c) => `\`${c}\``).join(', ')})
           VALUES (${placeholders}) AS new
           ON DUPLICATE KEY UPDATE ${updateClause}`,
          ...vals
        )
        written++
      }
    }
    const myCount = await my.$queryRawUnsafe(`SELECT COUNT(*) AS c FROM \`${t}\``)
    totals[t].my = Number(myCount[0]?.c ?? 0)
    const status = totals[t].pg === totals[t].my ? 'OK' : 'MISMATCH'
    if (status !== 'OK') report.differences.push(`${t}: pg=${totals[t].pg} my=${totals[t].my}`)
    report.tables.push(`${t}: pg=${totals[t].pg} my=${totals[t].my} written=${written} ${status}`)
    console.log(report.tables[report.tables.length - 1])
  }
  } finally {
    await my.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS=1')
  }

  // Special-character + max-length probes (emoji, Hindi, exact-max title)
  try {
    const probeName = 'émoji 🧪 हिन्दी probe'
    const probeId = '11111111-2222-3333-4444-555555555555'
    await my.$executeRawUnsafe(`DELETE FROM modules WHERE module_id = ?`, probeId)
    await my.$executeRawUnsafe(
      `INSERT INTO modules (module_id, name, path, depth, owner_id, created_by_id, created_at, updated_at)
       VALUES (?, ?, 'probe', 0, (SELECT user_id FROM users LIMIT 1), (SELECT user_id FROM users LIMIT 1), NOW(3), NOW(3))`,
      probeId, probeName
    )
    const back = await my.$queryRawUnsafe(`SELECT name FROM modules WHERE module_id = ?`, '11111111-2222-3333-4444-555555555555')
    const ok = back[0]?.name === probeName
    report.probes.push(`utf8mb4 roundtrip (emoji+Hindi): ${ok ? 'OK' : 'FAIL'}`)
    await my.$executeRawUnsafe(`DELETE FROM modules WHERE module_id = '11111111-2222-3333-4444-555555555555'`)
    // max-length title (200) must fit; 201 must be REJECTED by strict mode
    await my.$executeRawUnsafe(
      `INSERT INTO test_cases (test_case_id, title, author_id, priority, status, version, created_at, updated_at)
       VALUES (?, ?, (SELECT user_id FROM users LIMIT 1), 'P2', 'draft', 1, NOW(3), NOW(3))`,
      '22222222-2222-3333-4444-555555555555', 'x'.repeat(200)
    )
    report.probes.push('title exactly 200 chars: OK')
    await my.$executeRawUnsafe(`DELETE FROM test_cases WHERE test_case_id = '22222222-2222-3333-4444-555555555555'`)
    try {
      await my.$executeRawUnsafe(
        `INSERT INTO test_cases (test_case_id, title, author_id, priority, status, version, created_at, updated_at)
         VALUES (?, ?, (SELECT user_id FROM users LIMIT 1), 'P2', 'draft', 1, NOW(3), NOW(3))`,
        '33333333-2222-3333-4444-555555555555', 'x'.repeat(201)
      )
      report.probes.push('title 201 chars: FAIL — strict mode did NOT reject (silent truncation risk!)')
      await my.$executeRawUnsafe(`DELETE FROM test_cases WHERE test_case_id = '33333333-2222-3333-4444-555555555555'`)
    } catch {
      report.probes.push('title 201 chars: correctly REJECTED by strict mode')
    }
  } catch (e) {
    report.probes.push(`probe error: ${e.message}`)
  }

  // FK integrity: every child FK value must exist in its parent table
  const FK_CHECKS = [
    ['refresh_tokens', 'user_id', 'users', 'user_id'],
    ['modules', 'parent_id', 'modules', 'module_id'],
    ['test_cases', 'module_id', 'modules', 'module_id'],
    ['test_case_history', 'test_case_id', 'test_cases', 'test_case_id'],
    ['review_requests', 'test_case_id', 'test_cases', 'test_case_id'],
    ['review_events', 'review_request_id', 'review_requests', 'review_request_id'],
    ['bugs', 'module_id', 'modules', 'module_id'],
    ['bug_test_case_links', 'bug_id', 'bugs', 'bug_id'],
    ['bug_test_case_links', 'test_case_id', 'test_cases', 'test_case_id'],
    ['crew_desk_links', 'module_id', 'modules', 'module_id'],
    ['notifications', 'user_id', 'users', 'user_id'],
    ['wiki_documents', 'author_id', 'users', 'user_id'],
  ]
  for (const [child, ccol, parent, pcol] of FK_CHECKS) {
    const orphan = await my.$queryRawUnsafe(
      `SELECT COUNT(*) AS c FROM \`${child}\` c LEFT JOIN \`${parent}\` p ON c.\`${ccol}\` = p.\`${pcol}\`
       WHERE c.\`${ccol}\` IS NOT NULL AND p.\`${pcol}\` IS NULL`
    )
    const n = Number(orphan[0]?.c ?? 0)
    if (n > 0) report.differences.push(`FK orphans: ${child}.${ccol} -> ${n}`)
  }

  console.log('\n== MIGRATION REPORT ==')
  console.log(JSON.stringify(report, null, 2))
  await pg.$disconnect()
  await my.$disconnect()
}

main().catch(async (e) => {
  console.error('MIGRATION FAILED:', e.message)
  await pg.$disconnect().catch(() => {})
  await my.$disconnect().catch(() => {})
  process.exit(1)
})
