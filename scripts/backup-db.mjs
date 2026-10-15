// Logical backup of the whole TCMS database — dependency-free (no pg_dump in
// the sandbox). Dumps every table as JSON rows into a gzipped file:
//   backups/tcms-backup-<timestamp>.json.gz
// Restore companion: scripts/restore-db.mjs --file <backup> [--database <name>]
// Usage: node scripts/backup-db.mjs
import { PrismaClient } from '@prisma/client'
import zlib from "node:zlib"
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL || !DATABASE_URL.startsWith('postgres')) {
  console.error('DATABASE_URL must be a postgres:// URL (export it from scripts/start-tcms.sh)')
  process.exit(1)
}

// FK-safe insert order (parents before children).
export const TABLES_IN_ORDER = [
  'users',
  'role_permissions',
  'login_attempts',
  'modules', // self-referencing parent_id — created_at order keeps parents first
  'refresh_tokens',
  'role_permissions',
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
]

const db = new PrismaClient()
const backup = {
  createdAt: new Date().toISOString(),
  database: DATABASE_URL.replace(/\/\/[^@]+@/, '//***@'),
  schemaSource: 'prisma/database-setup.sql',
  tables: {},
  counts: {},
}

try {
  for (const table of TABLES_IN_ORDER) {
    const rows = await db.$queryRawUnsafe(`SELECT to_jsonb(t) AS row FROM "${table}" t`)
    const data = rows.map((r) => r.row)
    backup.tables[table] = data
    backup.counts[table] = data.length
    console.log(`${table.padEnd(24)} ${String(data.length).padStart(6)} rows`)
  }

  mkdirSync(resolve('backups'), { recursive: true })
  const file = resolve('backups', `tcms-backup-${backup.createdAt.replace(/[:.]/g, '-')}.json.gz`)
  const json = JSON.stringify(backup)
  await new Promise((done, fail) =>
    zlib.gzip(json, (err, buf) => (err ? fail(err) : (writeFileSync(file, buf), done())))
  )
  console.log(`\nbackup written: ${file} (${(json.length / 1024 / 1024).toFixed(1)} MB raw)`)
} finally {
  await db.$disconnect()
}
