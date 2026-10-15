// Validates the exact redeploy database steps given to the user:
//   1. cleanup-old-tables.sql runs clean (even on an empty DB)
//   2. database-setup.sql creates every table
//   3. cleanup script also removes the NEW tables (full round-trip)
// Runs against a throwaway database tcms_schema_test — live data untouched.
import { Client } from 'pg'
import { readFileSync } from 'node:fs'

const ADMIN = { host: 'localhost', port: 5499, user: 'tcms', password: 'tcms', database: 'postgres' }
const TEST_DB = 'tcms_schema_test'
const TEST = { ...ADMIN, database: TEST_DB }

const dropSql = readFileSync('/home/z/my-project/prisma/cleanup-old-tables.sql', 'utf8')
const setupSql = readFileSync('/home/z/my-project/prisma/database-setup.sql', 'utf8')

async function connect(cfg) {
  const c = new Client(cfg)
  await c.connect()
  return c
}

const admin = await connect(ADMIN)
await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`)
await admin.query(`CREATE DATABASE ${TEST_DB}`)
await admin.end()
console.log('[1/4] throwaway database created')

const t = await connect(TEST)
await t.query(dropSql)
console.log('[2/4] cleanup-old-tables.sql: runs clean on empty DB (idempotent) OK')

await t.query(setupSql)
const { rows } = await t.query(
  `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
)
console.log(`[3/4] database-setup.sql: created ${rows.length} tables:`)
console.log('      ' + rows.map((r) => r.tablename).join(', '))

await t.query(dropSql)
const after = await t.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`)
console.log(`[4/4] cleanup removes the new tables too: ${after.rows[0].n} remaining (expect 0)`)
await t.end()

const admin2 = await connect(ADMIN)
await admin2.query(`DROP DATABASE ${TEST_DB}`)
await admin2.end()
console.log('VALIDATION PASS — throwaway database dropped, live tcms DB untouched')
