// Production startup guard — THE fail-closed secret check (task startup-guard-1).
//
// WHY: sandbox boot scripts carry well-known defaults (ChangeMe_local_only,
// mock-login-secret, ...). If any of them reaches IT's real server, the app
// would run with secrets the whole internet knows. This guard makes BOTH
// processes — the Next.js app and the notifications WS mini-service — refuse
// to start (exit code 1, before any listener is opened) when the deployment
// declares itself production and any required secret is missing, too weak,
// or a known placeholder.
//
// THE SWITCH — TCMS_DEPLOY_ENV=production, set by IT on the real server ONLY:
//   - The guard activates if and only if this variable equals 'production'
//     (exact match, same style as TCMS_ALLOW_SIGNUP).
//   - It deliberately does NOT key on NODE_ENV: `next start` sets
//     NODE_ENV=production BY ITSELF, so the sandbox (which also runs
//     `next start`) would break; and the WS mini-service is started with a
//     plain `bun index.ts` that sets no NODE_ENV at all, so a NODE_ENV guard
//     there would silently never fire on a real server. One explicit switch
//     avoids both failure modes. Missing switch = sandbox behavior unchanged
//     (this cannot "accidentally" disable production: the deploy contract in
//     .env.example + docs/deploy makes setting it mandatory, and the startup
//     line below makes a forgotten switch visible in the go-live smoke test).
//
// STARTUP LINE CONTRACT (part of the go-live smoke test): every guarded
// process prints EXACTLY ONE state line at boot —
//   [TCMS] production guard ACTIVE                  (TCMS_DEPLOY_ENV=production)
//   [TCMS] production guard OFF (sandbox mode)      (switch absent)
// A real server that prints "OFF (sandbox mode)" has forgotten
// TCMS_DEPLOY_ENV — do not go live.
//
// ERROR CONTRACT: every problem is reported as "<VAR>: <reason>". The VALUE
// of a secret is never printed — not the real one, not the placeholder.
//
// ZERO IMPORTS (config.ts rule): this file is imported by the Next.js app
// AND executed by the bun mini-service; it must stay dependency-free so it
// can never pull Next.js (or anything else) into the service process.

/** Minimum length for GENERATED secrets (JWT_SECRET, WS_NOTIFY_SECRET).
 *  DB passwords are DBA-set credentials — presence + placeholder check only. */
const GENERATED_SECRET_MIN_LENGTH = 32

/**
 * Known-bad secret values (compared case-insensitively, trimmed):
 * sandbox/boot-script defaults, .env.example examples, and generic weak
 * words. Sources (audit, task startup-guard-1):
 *   - ChangeMe_local_only        sandbox MySQL password (mysql84-boot.sh,
 *                                mysql-env.sh, backup-db-mysql.sh)
 *   - ChangeMe_local_migrate     sandbox MySQL migrate-user password
 *                                (mysql84-boot.sh, start-tcms.sh — task mysql-baseline-1)
 *   - ChangeMe_local_backup      sandbox MySQL dump-user password
 *                                (mysql84-boot.sh, backup-db-mysql.sh — task mysql-backup-1)
 *   - mock-login-secret          crewdesk mock password (crewdesk-mock, start-tcms.sh, run-crewdesk-tests.sh)
 *   - mock-only-secret-not-real  crewdesk mock JWT secret
 *   - mock-local-token           crewdesk mock fixed token
 *   - change-me / change-me-to-a-long-random-string  .env.example placeholders
 *   - changeme / secret / password   generic weak words
 */
const KNOWN_PLACEHOLDERS = [
  'changeme_local_only',
  'changeme_local_migrate',
  'changeme_local_backup',
  'mock-login-secret',
  'mock-only-secret-not-real',
  'mock-local-token',
  'change-me',
  'change-me-to-a-long-random-string',
  'changeme',
  'secret',
  'password',
]

/** Sandbox MySQL signature — a production DATABASE_URL must never point here. */
const SANDBOX_MYSQL_PORT = '5500'

export function isProductionDeployment(): boolean {
  return process.env.TCMS_DEPLOY_ENV === 'production'
}

/** The one-and-only startup state line (see contract in the header). */
export function printProductionGuardState(): void {
  console.log(
    isProductionDeployment()
      ? '[TCMS] production guard ACTIVE'
      : '[TCMS] production guard OFF (sandbox mode)'
  )
}

function isKnownPlaceholder(value: string): boolean {
  return KNOWN_PLACEHOLDERS.includes(value.trim().toLowerCase())
}

/** Sandbox MySQL: loopback host on port 5500 (127.0.0.1 / localhost / ::1). */
function isSandboxMysqlEndpoint(host: string, port: string): boolean {
  const h = host.toLowerCase()
  return (h === '127.0.0.1' || h === 'localhost' || h === '::1') && port === SANDBOX_MYSQL_PORT
}

/** Validate one mysql:// URL env var. Pushes "<VAR>: <reason>" strings; never values. */
function checkDatabaseUrl(varName: string, raw: string, problems: string[]): void {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    problems.push(`${varName}: not a parseable database URL`)
    return
  }
  if (url.protocol !== 'mysql:') {
    problems.push(`${varName}: must be a mysql:// URL (the app is MySQL-only)`)
    return
  }
  const user = decodeURIComponent(url.username)
  const password = decodeURIComponent(url.password)
  const port = url.port || '3306'
  if (!user) {
    problems.push(`${varName}: database user is missing`)
  } else if (user === 'root') {
    problems.push(`${varName}: must not use the root database user`)
  }
  if (!password) {
    problems.push(`${varName}: database password is missing`)
  } else if (isKnownPlaceholder(password)) {
    problems.push(`${varName}: database password matches a known placeholder`)
  }
  if (isSandboxMysqlEndpoint(url.hostname, port)) {
    problems.push(`${varName}: points at the sandbox MySQL (${url.hostname}:${port})`)
  }
}

function checkGeneratedSecret(varName: string, problems: string[]): void {
  const value = (process.env[varName] ?? '').trim()
  if (!value) {
    problems.push(`${varName}: missing`)
    return
  }
  if (value.length < GENERATED_SECRET_MIN_LENGTH) {
    problems.push(
      `${varName}: too short (generated secrets need at least ${GENERATED_SECRET_MIN_LENGTH} characters)`
    )
  }
  if (isKnownPlaceholder(value)) {
    problems.push(`${varName}: matches a known placeholder`)
  }
}

/** Secrets that are OPTIONAL channels: harmless when unset, fatal when set
 *  to a known placeholder (a sandbox default must never reach production). */
const IF_SET_SECRET_VARS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_LOG_BOT_TOKEN',
  'CREWDESK_TOKEN',
  'CREWDESK_LOGIN_PASSWORD',
]

function appProblems(): string[] {
  const problems: string[] = []
  checkGeneratedSecret('JWT_SECRET', problems)
  checkGeneratedSecret('WS_NOTIFY_SECRET', problems)
  const dbUrl = (process.env.DATABASE_URL ?? '').trim()
  if (!dbUrl) {
    problems.push('DATABASE_URL: missing')
  } else {
    checkDatabaseUrl('DATABASE_URL', dbUrl, problems)
  }
  const directUrl = (process.env.DIRECT_URL ?? '').trim()
  if (directUrl) {
    checkDatabaseUrl('DIRECT_URL', directUrl, problems)
  }
  if ((process.env.TCMS_ENABLE_SEED ?? '').trim().toLowerCase() === 'true') {
    problems.push('TCMS_ENABLE_SEED: must be off in production (remove it or set it to false)')
  }
  for (const varName of IF_SET_SECRET_VARS) {
    const value = process.env[varName] ?? ''
    if (value.trim() && isKnownPlaceholder(value)) {
      problems.push(`${varName}: matches a known placeholder`)
    }
  }
  const smtpHost = (process.env.SMTP_HOST ?? '').trim()
  const smtpPass = (process.env.SMTP_PASS ?? '').trim()
  if (smtpHost && !smtpPass) {
    problems.push('SMTP_PASS: missing while SMTP_HOST is set (half-configured email channel)')
  }
  if (smtpPass && isKnownPlaceholder(smtpPass)) {
    problems.push('SMTP_PASS: matches a known placeholder')
  }
  return problems
}

/** The WS mini-service only ever touches WS_NOTIFY_SECRET (tickets +
 *  broadcasts). Demanding the app's DB/seed/JWT vars in a service-only
 *  process would falsely refuse a legitimate split deployment. */
function wsServiceProblems(): string[] {
  const problems: string[] = []
  checkGeneratedSecret('WS_NOTIFY_SECRET', problems)
  return problems
}

function runGuard(scope: string, problems: string[]): void {
  printProductionGuardState()
  if (problems.length > 0) {
    console.error(
      `[TCMS] FATAL (${scope}): refusing to start — production secret guard found ${problems.length} problem(s):`
    )
    for (const problem of problems) {
      console.error(`[TCMS]   - ${problem}`)
    }
    console.error(
      '[TCMS] Fix the variables named above (values are never printed). ' +
        'TCMS_DEPLOY_ENV=production is set — unset it ONLY in the sandbox.'
    )
    process.exit(1)
  }
}

/** Full check for the Next.js app: JWT_SECRET, WS_NOTIFY_SECRET, DATABASE_URL
 *  (+DIRECT_URL), TCMS_ENABLE_SEED, and the if-set placeholder tier. Called
 *  FIRST in src/instrumentation.ts register() — before any other module can
 *  touch a secret — so exit 1 happens before the server accepts requests. */
export function assertAppStartup(scope = 'tcms-app'): void {
  runGuard(scope, isProductionDeployment() ? appProblems() : [])
}

/** Narrow check for the notifications WS mini-service: WS_NOTIFY_SECRET only
 *  (the service's CORS/path guard stays in the service itself). Call BEFORE
 *  any listen(). */
export function assertWsServiceStartup(scope = 'tcms-ws'): void {
  runGuard(scope, isProductionDeployment() ? wsServiceProblems() : [])
}

// ---------- Required settings (every mode, also dev) ----------
//
// A missing .env key must never surface as a confusing stack trace on the first
// request. Before anything else boots, every REQUIRED key is checked and each
// missing one is named (never its value), then the process exits 1.

function envValue(name: string): string {
  return (process.env[name] ?? '').trim()
}

/** Names + reasons of required settings that are missing (empty = all present). */
export function missingRequiredSettings(): string[] {
  const missing: string[] = []
  if (!envValue('DATABASE_URL')) missing.push('DATABASE_URL (the app database URL, mysql://...)')
  const jwt = envValue('JWT_SECRET')
  if (!jwt) missing.push('JWT_SECRET (random 32+ character secret)')
  else if (jwt.length < GENERATED_SECRET_MIN_LENGTH) missing.push(`JWT_SECRET (too short: needs ${GENERATED_SECRET_MIN_LENGTH}+ characters)`)
  if (envValue('SMTP_HOST') && !envValue('SMTP_FROM')) missing.push('SMTP_FROM (required when SMTP_HOST is set)')
  if (envValue('CREWDESK_AUTH').toLowerCase() === 'login' && (!envValue('CREWDESK_LOGIN_EMAIL') || !envValue('CREWDESK_LOGIN_PASSWORD'))) {
    missing.push('CREWDESK_LOGIN_EMAIL / CREWDESK_LOGIN_PASSWORD (required when CREWDESK_AUTH=login)')
  }
  if (envValue('CREWDESK_AUTH').toLowerCase() === 'token' && !envValue('CREWDESK_TOKEN')) {
    missing.push('CREWDESK_TOKEN (required when CREWDESK_AUTH=token)')
  }
  if (isProductionDeployment() && !envValue('TCMS_PUBLIC_ORIGIN')) {
    missing.push('TCMS_PUBLIC_ORIGIN (the app URL, e.g. https://tcms.company.com — required in production)')
  }
  return missing
}

/** Exits 1 with one clear line per missing key. Runs FIRST at boot, in every mode. */
export function assertRequiredSettings(scope = 'tcms-app'): void {
  const missing = missingRequiredSettings()
  if (missing.length === 0) return
  console.error(`[TCMS] FATAL (${scope}): missing required setting(s) in .env:`)
  for (const item of missing) console.error(`[TCMS]   - ${item}`)
  console.error('[TCMS] Add them to .env (see .env.example for every key), then restart the app.')
  process.exit(1)
}
