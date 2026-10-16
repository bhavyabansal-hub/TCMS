#!/usr/bin/env node
/**
 * Verifier for the MySQL error mapping (backlog B3, src/lib/server/db-errors.ts).
 *   1. REAL MySQL errors raised on tcms_test inside transactions that always roll back
 *      (duplicate key, FK missing, FK in use, too long, NOT NULL) are
 *      mapped to the expected status and a message without SQL text.
 *   2. Shapes that cannot be provoked safely (pool timeout, DB down) are checked with
 *      synthetic errors of the same shape Prisma throws.
 *   3. Live API: 6 parallel task-report upserts for one user + day -> all 200, no SQL in
 *      any body, exactly one row (the duplicate-key race used to answer 500).
 * Usage: node scripts/verify-db-errors.mjs   (app on :3000; DB guard + lock)
 */
import { randomUUID } from 'node:crypto'
import { openGuardedDb } from './lib/db-guard.mjs'
import { cleanupRunEntities } from './lib/suite-cleanup.mjs'
import { mapDatabaseError } from '../src/lib/server/db-errors.ts'

const BASE = process.env.TCMS_BASE_URL || 'http://localhost:3000'
// Case-sensitive on purpose: SQL syntax and driver wording, not ordinary words like "selected".
const SQL_LEAK = /\bINSERT INTO\b|\bUPDATE \w+ SET\b|\bDELETE FROM\b|\bSELECT\b[^"]*\bFROM\b|Duplicate entry|foreign key constraint|Raw query|prisma\./
let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`) }
}
class Rollback extends Error {}

/** Runs `fn` in a transaction that is always rolled back; returns the DB error it raised. */
async function captureError(db, fn) {
  let caught = null
  try {
    await db.$transaction(async (tx) => {
      try {
        await fn(tx)
      } catch (err) {
        caught = err
      }
      throw new Rollback()
    })
  } catch (err) {
    if (!(err instanceof Rollback)) throw err
  }
  return caught
}

function expectMapped(label, err, status, kind) {
  const mapped = mapDatabaseError(err)
  check(`${label}: -> ${status} ${kind}`, mapped?.status === status && mapped?.kind === kind, JSON.stringify(mapped) + ` raw=${err?.code}/${err?.meta?.code}`)
  check(`${label}: message carries no SQL text`, !!mapped && !SQL_LEAK.test(mapped.message), mapped?.message)
}

async function checkRealErrors(db) {
  const [anyUser] = await db.$queryRaw`SELECT user_id FROM users WHERE is_active = 1 LIMIT 1`
  const [anyModule] = await db.$queryRaw`SELECT module_id FROM modules LIMIT 1`
  const insertModule = (tx, { id = randomUUID(), name = 'db-errors probe', parentId = null, ownerId = anyUser.user_id }) =>
    tx.$executeRaw`INSERT INTO modules (module_id, name, description, parent_id, path, depth, owner_id, created_by_id, updated_by_id, created_at, updated_at)
      VALUES (${id}, ${name}, '', ${parentId}, '/', 0, ${ownerId}, ${anyUser.user_id}, ${anyUser.user_id}, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`

  expectMapped('duplicate primary key (1062)', await captureError(db, (tx) => insertModule(tx, { id: anyModule.module_id })), 409, 'duplicate_key')
  expectMapped('FK target missing (1452)', await captureError(db, (tx) => insertModule(tx, { parentId: randomUUID() })), 400, 'fk_missing')
  expectMapped('value too long (1406)', await captureError(db, (tx) => insertModule(tx, { name: 'x'.repeat(5000) })), 400, 'too_long')
  expectMapped('NOT NULL (1048)', await captureError(db, (tx) => insertModule(tx, { name: null })), 400, 'not_null')
  expectMapped('FK still in use (1451)', await captureError(db, (tx) => tx.$executeRaw`DELETE FROM users WHERE user_id = ${anyUser.user_id}`), 409, 'fk_in_use')
  const [stillThere] = await db.$queryRaw`SELECT COUNT(*) AS n FROM users WHERE user_id = ${anyUser.user_id}`
  check('rolled back: probed user still present', Number(stillThere.n) === 1)
}

function checkSyntheticShapes() {
  const pool = { name: 'PrismaClientKnownRequestError', code: 'P2024', message: 'Timed out fetching a new connection' }
  check('pool timeout (P2024) -> 503', mapDatabaseError(pool)?.status === 503)
  const down = { name: 'PrismaClientInitializationError', errorCode: 'P1001', message: "Can't reach database server" }
  check('DB unreachable (P1001) -> 503', mapDatabaseError(down)?.status === 503)
  const deadlock = { name: 'PrismaClientKnownRequestError', code: 'P2010', meta: { code: '1213' }, message: 'Deadlock found' }
  check('deadlock (1213) -> 409 try again', mapDatabaseError(deadlock)?.status === 409)
  check('non-DB error -> not mapped (stays 500)', mapDatabaseError(new Error('boom')) === null)
}

async function checkLiveUpsertRace(created) {
  const res = await fetch(`${BASE}/api/auth?path=login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms' },
    body: JSON.stringify({ email: 'qa1@tcms.com', password: 'QA@12345' }),
  })
  const cookie = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('tcms-access='))?.split(';')[0]
  check('live: qa1 login', !!cookie)
  const reportDate = '2001-02-03' // fixed far-past day: never a real report
  const body = JSON.stringify({ reportDate, tasks: [{ description: 'db-errors race', timeSpentMinutes: 5, status: 'done' }] })
  const results = await Promise.all(Array.from({ length: 6 }, () =>
    fetch(`${BASE}/api/task-reports`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms', Cookie: cookie }, body })
      .then(async (r) => ({ status: r.status, text: await r.text() }))))
  for (const r of results) {
    try { const id = JSON.parse(r.text)?.taskReportId; if (id) created.taskReports.push(id) } catch { /* error body */ }
  }
  created.taskReports = [...new Set(created.taskReports)]
  const statuses = results.map((r) => r.status)
  // The loser of the unique-key race is retried as an update (task-reports.service.ts).
  check('live: 6 parallel upserts -> all 200 (no 409/500)', statuses.every((s) => s === 200 || s === 201), statuses.join(','))
  check('live: no SQL text in any response body', results.every((r) => !SQL_LEAK.test(r.text)), results.map((r) => r.text.slice(0, 80)).join(' | '))
  check('live: exactly one report row for that day', created.taskReports.length === 1, `ids=${created.taskReports.length}`)
}

async function main() {
  checkSyntheticShapes()
  const created = { taskReports: [] }
  const guard = await openGuardedDb()
  try {
    guard.setBusy(true)
    await checkRealErrors(guard.db)
  } finally {
    guard.setBusy(false)
    await guard.release()
  }
  try {
    await checkLiveUpsertRace(created)
  } finally {
    await cleanupRunEntities(check, created)
  }
  console.log(`\nDB-ERRORS RESULT: ${pass} passed, ${fail} failed`)
  return fail ? 1 : 0
}

main().then((code) => { process.exitCode = code }, (err) => { console.error(`ERROR: ${err.message}`); process.exitCode = 1 })
