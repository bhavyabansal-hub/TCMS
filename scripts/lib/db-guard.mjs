// DB guard + serial lock for every DB-touching test script (REQ-001 R10.AC11, Q18, P8).
//
// Contract (REQ-001 design (git history) 2.3):
//   1. In-process DATABASE_URL check: host 127.0.0.1|localhost, port 5500,
//      database tcms_test. Only the boolean is printed, never the URL.
//      A missing or wrong URL aborts BEFORE any connection is opened
//      (port 3306 must never be contacted, `docs/CODING-STANDARDS.md` §8).
//   2. One PrismaClient with connection_limit=1, so the GET_LOCK session and
//      every later statement share the same physical connection.
//   3. First statement: SELECT @@port, DATABASE(). Proceed only when
//      DATABASE() = tcms_test AND @@port = 5500 AND urlTargetOk.
//   4. GET_LOCK('tcms_verify', 0): 1 = continue, anything else = abort.
//   Abort = GuardAbort (exitCode 2). Callers print nothing secret.
import { PrismaClient, Prisma } from '@prisma/client'

export { Prisma }

export const LOCK_NAME = 'tcms_verify'
const EXPECTED_DB = 'tcms_test'
const EXPECTED_PORT = 5500
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost'])
const KEEPALIVE_MS = 30_000

/** Thrown when the run must not start: wrong target, lock held, precondition. Exit code 2. */
export class GuardAbort extends Error {
  constructor(message) {
    super(message)
    this.name = 'GuardAbort'
    this.exitCode = 2
  }
}

/** Parses the URL in-process; returns the single-connection URL or null. Never logs the URL. */
function resolveGuardedUrl(rawUrl) {
  if (!rawUrl) return null
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  const isTarget =
    url.protocol === 'mysql:' &&
    ALLOWED_HOSTS.has(url.hostname) &&
    url.port === String(EXPECTED_PORT) &&
    url.pathname === `/${EXPECTED_DB}`
  if (!isTarget) return null
  url.searchParams.set('connection_limit', '1')
  return url.toString()
}

/**
 * Opens the guarded single-connection client.
 * @param {{ lock?: boolean, log?: (line: string) => void }} [opts]
 * @returns {Promise<{ db: PrismaClient, port: number, database: string,
 *   assertLockOwned: () => Promise<boolean>, setBusy: (busy: boolean) => void, release: () => Promise<void> }>}
 */
/** Numbers in `id` / `*_id` columns -> digit strings (mirrors src/lib/db.ts). */
export function idsAsStrings(row) {
  if (!row || typeof row !== 'object') return row
  for (const key of Object.keys(row)) {
    const value = row[key]
    if ((key === 'id' || key.endsWith('_id')) && (typeof value === 'number' || typeof value === 'bigint')) row[key] = String(value)
  }
  return row
}

/**
 * Runs one INSERT (a Prisma.sql fragment) and returns the new AUTO_INCREMENT key as a
 * digit string. INSERT + LAST_INSERT_ID() always share ONE connection: the given
 * transaction client, or a transaction opened here on the root client.
 */
export async function insertReturningId(client, statement) {
  const run = async (tx) => {
    await tx.$executeRaw(statement)
    const rows = await tx.$queryRaw`SELECT LAST_INSERT_ID() AS id`
    const id = String(rows[0]?.id ?? '0')
    if (id === '0') throw new Error('INSERT returned no AUTO_INCREMENT id')
    return id
  }
  return typeof client.$transaction === 'function' ? client.$transaction(run) : run(client)
}

export async function openGuardedDb({ lock = true, log = console.log } = {}) {
  // Importing @prisma/client loads .env into process.env (Prisma's own loader);
  // the value is only parsed here, never printed.
  const guardedUrl = resolveGuardedUrl(process.env.DATABASE_URL)
  const urlTargetOk = guardedUrl !== null
  if (!urlTargetOk) {
    log(`GUARD urlTargetOk=false (not connected)`)
    throw new GuardAbort('DB guard: DATABASE_URL does not point at 127.0.0.1:5500/tcms_test')
  }

  // Same id rule as the app (src/lib/db.ts): numeric *_id / id columns come back as
  // digit strings, so script comparisons with API ids ("42") just work.
  const db = new PrismaClient({ datasources: { db: { url: guardedUrl } } }).$extends({
    query: {
      async $queryRaw({ args, query }) {
        const rows = await query(args)
        return Array.isArray(rows) ? rows.map(idsAsStrings) : rows
      },
    },
  })
  let keepalive = null
  let isBusy = false
  const release = async () => {
    if (keepalive) clearInterval(keepalive)
    keepalive = null
    try {
      if (lock) await db.$queryRaw`SELECT RELEASE_LOCK(${LOCK_NAME}) AS released`
    } catch {
      /* connection already gone: the server drops the lock with it */
    }
    await db.$disconnect().catch(() => {})
  }

  let port
  let database
  try {
    const rows = await db.$queryRaw`SELECT @@port AS port, DATABASE() AS db`
    port = Number(rows[0]?.port)
    database = String(rows[0]?.db ?? '')
  } catch (err) {
    await db.$disconnect().catch(() => {})
    log(`GUARD urlTargetOk=true (connection failed)`)
    throw new GuardAbort(`DB guard: target check query failed (${err.code ?? err.name})`)
  }
  log(`GUARD @@port=${port} DATABASE()=${database} urlTargetOk=${urlTargetOk}`)
  if (database !== EXPECTED_DB || port !== EXPECTED_PORT) {
    await db.$disconnect().catch(() => {})
    throw new GuardAbort(`DB guard: expected ${EXPECTED_DB} on @@port ${EXPECTED_PORT}`)
  }

  if (lock) {
    const got = await db.$queryRaw`SELECT GET_LOCK(${LOCK_NAME}, 0) AS got`
    if (Number(got[0]?.got) !== 1) {
      await db.$disconnect().catch(() => {})
      throw new GuardAbort(`lock held: another verify/cleanup run holds '${LOCK_NAME}'`)
    }
    log(`LOCK ${LOCK_NAME} acquired`)
    // Long HTTP-only stretches must not let the pooled connection go idle
    // and drop the session lock; skipped while a transaction owns it.
    keepalive = setInterval(() => {
      if (isBusy) return
      db.$queryRaw`SELECT 1 AS alive`.catch(() => {})
    }, KEEPALIVE_MS)
    keepalive.unref()
  }

  const assertLockOwned = async () => {
    if (!lock) return true
    const rows = await db.$queryRaw`SELECT IS_USED_LOCK(${LOCK_NAME}) = CONNECTION_ID() AS mine`
    return Number(rows[0]?.mine) === 1
  }
  const setBusy = (busy) => {
    isBusy = busy
  }
  return { db, port, database, assertLockOwned, setBusy, release }
}

/** `col IN (ids)` or FALSE for an empty list (MySQL rejects `IN ()`). Column names are constants. */
export function sqlIn(column, ids) {
  if (!ids || ids.length === 0) return Prisma.sql`FALSE`
  return Prisma.sql`${Prisma.raw(column)} IN (${Prisma.join(ids)})`
}
