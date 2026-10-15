// Restore a backup produced by scripts/backup-db.mjs into a target database.
// Safe drill pattern (used in the runbook): restore into a SCRATCH database,
// compare row counts, then drop the scratch — production is never touched.
//
// Usage:
//   node scripts/restore-db.mjs --file backups/tcms-backup-....json.gz --database tcms_drill
//   node scripts/restore-db.sql --file ... --database tcms --yes   # REAL restore (destructive!)
import { PrismaClient } from '@prisma/client'
import zlib from "node:zlib"
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
function argOf(name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : null
}
const FILE = argOf('--file')
const TARGET_DB = argOf('--database')
const CONFIRMED = args.includes('--yes')

if (!FILE || !TARGET_DB) {
  console.error('Usage: node scripts/restore-db.mjs --file <backup.json.gz> --database <target-db> [--yes]')
  process.exit(1)
}

const base = process.env.DATABASE_URL
if (!base || !base.startsWith('postgres')) {
  console.error('Export DATABASE_URL first (see scripts/start-tcms.sh)')
  process.exit(1)
}
const adminUrl = base.replace(/\/[^/?]+(\?|$)/, `/postgres$1`)
const targetUrl = base.replace(/\/[^/?]+(\?|$)/, `/${TARGET_DB}$1`)

// 1. Read the backup
const gz = readFileSync(FILE)
const json = await new Promise((done, fail) =>
  zlib.gunzip(gz, (err, buf) => (err ? fail(err) : done(buf.toString())))
)
const backup = JSON.parse(json)
console.log(`backup: ${FILE} (${backup.createdAt})`)

// 2. Ensure the target database exists
const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } })
try {
  await admin.$executeRawUnsafe(`CREATE DATABASE "${TARGET_DB}"`)
  console.log(`created database ${TARGET_DB}`)
} catch (e) {
  if (!String(e.message).includes('already exists')) throw e
  console.log(`database ${TARGET_DB} already exists`)
} finally {
  await admin.$disconnect()
}

// 3. Apply the schema DDL (idempotent script: tables -> indexes -> FKs)
const target = new PrismaClient({ datasources: { db: { url: targetUrl } } })
try {
  const ddl = readFileSync('prisma/database-setup.sql', 'utf8')
  // The setup file is one ordered statement per block; strip comment lines,
  // then split on statement-terminating semicolons.
  const stmts = ddl
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const stmt of stmts) {
    await target.$executeRawUnsafe(stmt)
  }
  console.log(`schema applied to ${TARGET_DB} (${stmts.length} statements)`)

  // 4. Insert rows table by table (FK-safe order) via json_populate_recordset
  for (const [table, rows] of Object.entries(backup.tables)) {
    if (!rows.length) continue
    await target.$executeRawUnsafe(
      `INSERT INTO "${table}" SELECT * FROM jsonb_populate_recordset(null::"${table}", $1::jsonb)`,
      JSON.stringify(rows)
    )
    console.log(`${table.padEnd(24)} ${String(rows.length).padStart(6)} rows restored`)
  }

  // 5. Verify counts match the backup
  let mismatches = 0
  for (const [table, rows] of Object.entries(backup.tables)) {
    const [{ n }] = await target.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "${table}"`)
    if (n !== rows.length) {
      mismatches++
      console.error(`MISMATCH ${table}: backup=${rows.length} restored=${n}`)
    }
  }
  if (mismatches === 0) console.log(`\nRESTORE VERIFIED: all ${Object.keys(backup.tables).length} tables match the backup row counts.`)
  else {
    console.error(`\nrestore finished with ${mismatches} mismatches`)
    process.exitCode = 1
  }
} finally {
  await target.$disconnect()
}
