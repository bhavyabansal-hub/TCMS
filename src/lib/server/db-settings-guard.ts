// Production DB settings guard — THE fail-closed database check (task
// db-settings-guard-1). Companion to startup-guard.ts: while the startup
// guard proves the SECRETS are real, this guard proves the MySQL SERVER the
// app is about to run against is configured safely.
//
// WHY: the app is only correct on a MySQL server that enforces strict mode
// (silent truncation / zero dates would corrupt data) and ONLY_FULL_GROUP_BY
// (deterministic aggregates — the codebase is verified clean under it, see
// docs/deploy/PRODUCTION-CHECKLIST.md §2), stores UTC (every raw-SQL write uses UTC_TIMESTAMP(3)
// and Prisma writes UTC — a non-UTC server would silently skew timestamps),
// and speaks utf8mb4 end to end (server AND schema default — otherwise
// multi-byte text silently mangles on implicit charset coercion).
//
// WHAT IT READS — the values the app ACTUALLY RUNS WITH:
//   - SESSION @@sql_mode, @@time_zone, @@transaction_isolation,
//     @@character_set_server on the app's own Prisma connection (a fresh
//     session inherits the globals — exactly what every later request sees)
//   - the app schema's default charset from information_schema.SCHEMATA
//
// REFUSAL RULES (exit 1, before the server accepts a single request):
//   - sql_mode lacks STRICT_TRANS_TABLES or ONLY_FULL_GROUP_BY
//   - time_zone is not '+00:00' or 'UTC'
//   - character_set_server is not utf8mb4
//   - the schema default charset is not utf8mb4 (or the schema is missing)
//   - the database is unreachable after 5 connection attempts, 3 s apart
//     ("database unreachable (<host>:<port>)" — host:port ONLY, no
//     credentials, ever)
// transaction_isolation is PRINTED but never fails the boot here — the
// concurrency task owns that decision.
//
// UNREACHABLE RETRY CONTRACT: 5 attempts total, 3 s between attempts. This
// covers the "app container starts before the DB container" race in
// container deployments; a genuinely dead database still fails the boot
// loudly instead of half-starting.
//
// THE SWITCH — same as startup-guard.ts: runs ONLY with
// TCMS_DEPLOY_ENV=production. Without it, exactly one OFF line is printed
// and NOTHING else happens — sandbox behavior is unchanged.
//
// STARTUP LINE CONTRACT (go-live smoke test greps these):
//   [TCMS] db-settings guard ACTIVE                       (production)
//   [TCMS] db-settings OK: sql_mode=... time_zone=... ... (production, pass)
//   [TCMS] db-settings guard OFF (sandbox mode)           (switch absent)
//
// SETTINGS VALUES ARE NOT SECRETS: unlike the secret guard, refusal lines
// print the offending sql_mode/time_zone/charset VALUES — an ops person
// fixing my.cnf needs them. Credentials are still never printed.
//
// Import note: this module imports the app's Prisma singleton (src/lib/db),
// so it must be imported AFTER assertAppStartup() has validated the
// environment — which is exactly how src/instrumentation.ts wires it.

import { db } from '@/lib/db'
import { isProductionDeployment } from '@/lib/server/startup-guard'

/** sql_mode flags the app is verified correct under (full default sql_mode
 *  audit, task db-settings-guard-1: zero GROUP BY/DISTINCT/aggregate
 *  violations, zero zero-dates — see docs/deploy/PRODUCTION-CHECKLIST.md §2). */
const REQUIRED_SQL_MODE_FLAGS = ['STRICT_TRANS_TABLES', 'ONLY_FULL_GROUP_BY'] as const

/** Session time_zone values the app accepts: explicit UTC only. A server on
 *  'SYSTEM' (whatever the host clock says) is refused on purpose. */
const ACCEPTED_TIME_ZONES = ['+00:00', 'utc'] as const

const REQUIRED_CHARSET = 'utf8mb4'
const CONNECT_ATTEMPTS = 5
const CONNECT_RETRY_DELAY_MS = 3_000

interface SessionSettingsRow {
  sql_mode: string
  time_zone: string
  character_set_server: string
  transaction_isolation: string
}

interface SchemaCharsetRow {
  charset: string
  collation: string
}

/** host:port of DATABASE_URL for error messages — credentials NEVER. */
function dbEndpoint(): string {
  try {
    const url = new URL((process.env.DATABASE_URL ?? '').trim())
    return `${url.hostname}:${url.port || '3306'}`
  } catch {
    return '(DATABASE_URL not parseable)'
  }
}

/** The schema name from the DATABASE_URL path (Prisma connects into it). */
function schemaNameFromUrl(): string {
  try {
    const url = new URL((process.env.DATABASE_URL ?? '').trim())
    return decodeURIComponent(url.pathname.replace(/^\//, '').split('/')[0] ?? '')
  } catch {
    return ''
  }
}

/** True when the thrown error means "could not connect" (retry-worthy);
 *  false for anything else (auth, access denied, bad SQL — fail immediately,
 *  retrying would only delay an honest message). Covers BOTH the numeric
 *  Prisma error codes (when the driver surfaces them) and the engine's
 *  plain-text connection failure phrases (thrown at connect time, where the
 *  code property is often absent — proven in db-settings-guard-test.mjs). */
function isConnectivityError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code ?? ''
  if (['P1001', 'P1002', 'P1008', 'P1017'].includes(code)) return true
  const message = err instanceof Error ? err.message : String(err)
  const markers = [
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENOTFOUND',
    'ECONNRESET',
    "Can't reach database server",
    'Timed out fetching a new connection from the connection pool',
    'Connection pool timeout',
    'Server closed the connection',
    'Connection error',
  ]
  return markers.some((marker) => message.includes(marker))
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function probeDatabaseSettings(): Promise<{
  session: SessionSettingsRow
  schemaName: string
  schema: SchemaCharsetRow | null
}> {
  const sessionRows = await db.$queryRaw<SessionSettingsRow[]>`
    SELECT @@SESSION.sql_mode AS sql_mode,
           @@SESSION.time_zone AS time_zone,
           @@SESSION.character_set_server AS character_set_server,
           @@SESSION.transaction_isolation AS transaction_isolation`
  const session = sessionRows[0]
  if (!session) throw new Error('settings probe returned no row')
  const schemaName = schemaNameFromUrl()
  if (!schemaName) throw new Error('DATABASE_URL has no schema name in its path')
  const schemaRows = await db.$queryRaw<SchemaCharsetRow[]>`
    SELECT DEFAULT_CHARACTER_SET_NAME AS charset, DEFAULT_COLLATION_NAME AS collation
    FROM information_schema.SCHEMATA
    WHERE SCHEMA_NAME = ${schemaName}`
  return { session, schemaName, schema: schemaRows[0] ?? null }
}

/** All refusal problems found — empty list means the server is safe. */
function collectProblems(settings: {
  session: SessionSettingsRow
  schemaName: string
  schema: SchemaCharsetRow | null
}): string[] {
  const { session, schemaName, schema } = settings
  const problems: string[] = []

  const flags = session.sql_mode
    .split(',')
    .map((flag) => flag.trim().toUpperCase())
    .filter(Boolean)
  const missing = REQUIRED_SQL_MODE_FLAGS.filter((required) => !flags.includes(required))
  if (missing.length > 0) {
    problems.push(
      `sql_mode = '${session.sql_mode}' — missing ${missing.join(' + ')} (strict mode and ` +
        'deterministic GROUP BY are mandatory; ask IT to set it in my.cnf so it survives restarts)'
    )
  }

  const timeZone = session.time_zone.trim()
  if (!ACCEPTED_TIME_ZONES.includes(timeZone.toLowerCase() as (typeof ACCEPTED_TIME_ZONES)[number])) {
    problems.push(
      `time_zone = '${timeZone}' — must be '+00:00' or 'UTC' (the app writes UTC; a skewed ` +
        'server clock silently shifts every stored timestamp)'
    )
  }

  const serverCharset = session.character_set_server.trim().toLowerCase()
  if (serverCharset !== REQUIRED_CHARSET) {
    problems.push(
      `character_set_server = '${session.character_set_server}' — must be utf8mb4 (an ascii/latin1/utf8 ` +
        'server mangles multi-byte text on implicit coercion)'
    )
  }

  if (!schema) {
    problems.push(
      `schema '${schemaName}' not found in information_schema.SCHEMATA — DATABASE_URL names a ` +
        'schema that does not exist (or the user cannot see it)'
    )
  } else {
    const schemaCharset = schema.charset.trim().toLowerCase()
    if (schemaCharset !== REQUIRED_CHARSET) {
      problems.push(
        `schema '${schemaName}' default charset = '${schema.charset}' — must be utf8mb4 ` +
          '(tables inherit the schema default at CREATE time; fix with ALTER SCHEMA or recreate)'
      )
    }
  }

  return problems
}

/** The boot gate. Awaited by src/instrumentation.ts AFTER assertAppStartup()
 *  and BEFORE anything else touches the database — exit 1 happens before the
 *  server accepts requests. Never throws: every failure path ends in a
 *  controlled process.exit(1) or a plain return. */
export async function runDbSettingsGuard(): Promise<void> {
  if (!isProductionDeployment()) {
    console.log('[TCMS] db-settings guard OFF (sandbox mode)')
    return
  }
  console.log('[TCMS] db-settings guard ACTIVE')

  let settings: Awaited<ReturnType<typeof probeDatabaseSettings>> | null = null
  let lastError: unknown = null
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
    try {
      settings = await probeDatabaseSettings()
      break
    } catch (err) {
      lastError = err
      if (!isConnectivityError(err)) {
        const code = (err as { code?: string } | null)?.code ?? 'unknown'
        console.error(
          `[TCMS] FATAL (db-settings): database probe failed with a non-connectivity error ` +
            `(${code}) — refusing to start. No credentials are shown; check the app logs.`
        )
        process.exit(1)
      }
      if (attempt < CONNECT_ATTEMPTS) await sleep(CONNECT_RETRY_DELAY_MS)
    }
  }

  if (!settings) {
    const code = (lastError as { code?: string } | null)?.code ?? ''
    console.error(
      `[TCMS] FATAL (db-settings): database unreachable (${dbEndpoint()}) after ` +
        `${CONNECT_ATTEMPTS} attempts, ${CONNECT_RETRY_DELAY_MS / 1000} s apart` +
        `${code ? ` [${code}]` : ''} — refusing to start. Verify host, port and firewall; ` +
        'no credentials are shown.'
    )
    process.exit(1)
  }

  const problems = collectProblems(settings)
  if (problems.length > 0) {
    console.error(
      `[TCMS] FATAL (db-settings): refusing to start — database settings guard found ` +
        `${problems.length} problem(s):`
    )
    for (const problem of problems) {
      console.error(`[TCMS]   - ${problem}`)
    }
    console.error(
      '[TCMS] Fix the server settings named above (persistently — my.cnf or the deployment ' +
        'config, not just SET GLOBAL), then restart. Full contract: ' +
        'src/lib/server/db-settings-guard.ts + docs/deploy/PRODUCTION-CHECKLIST.md §2.'
    )
    process.exit(1)
  }

  const { session, schemaName, schema } = settings
  console.log(
    `[TCMS] db-settings OK: sql_mode=${session.sql_mode} time_zone=${session.time_zone} ` +
      `server_charset=${session.character_set_server} ` +
      `schema_charset=${schema?.charset ?? '?'} (schema '${schemaName}') ` +
      `transaction_isolation=${session.transaction_isolation} (reported only — the concurrency task owns it)`
  )
}
