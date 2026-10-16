// Central environment configuration — THE single place process.env is read.
//
// RULE (production standard): application code never touches process.env
// directly. Every runtime setting is declared ONCE here with its env name,
// its default, and a short "why it exists" note, then imported as
// `import { env } from '@/lib/server/config'`.
//
// Benefits:
//   - one readable inventory of every knob the deployment can turn;
//   - a missing key surfaces as ONE typed default instead of scattered
//     magic strings;
//   - secrets still live ONLY in .env (never committed) — this file holds
//     names and defaults, never real values.
//
// Dependency rules: this module must stay IMPORT-FREE (no logger, no db) so
// any layer — including the logger itself — can safely import it without
// cycles. Server-only: everything here is configuration for Node-side code.

// ---------- Tiny parsers (no throwing — a bad value falls back to default) ----------

function str(key: string, fallback = ''): string {
  const v = process.env[key]
  return v === undefined || v === '' ? fallback : v
}

function int(key: string, fallback: number): number {
  const n = Number(process.env[key])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// ---------- Core app ----------

/** 'development' | 'production' — drives log verbosity, Prisma logging, etc. */
export const NODE_ENV = str('NODE_ENV', 'development')
export const IS_PRODUCTION = NODE_ENV === 'production'

/** Extra hosts trusted for Origin checking (CSRF), comma-separated. */
export const EXTRA_ALLOWED_HOSTS = str('TCMS_EXTRA_ALLOWED_HOSTS')

/**
 * Explicit public origin for links baked into Crew Desk comments
 * (e.g. https://tcms.company.com). Empty = derive from the request.
 */
export const PUBLIC_ORIGIN = str('TCMS_PUBLIC_ORIGIN').trim().replace(/\/+$/, '')

/** Secret used to sign session JWTs — SECURITY-CRITICAL (audit 2026-10-09:
 *  the previous hardcoded dev fallback was live-exploitable — anyone with
 *  repo knowledge could mint VP tokens). Now: REQUIRED at boot, minimum 32
 *  chars, no fallback. Fail-fast beats fail-insecure. */
const JWT_SECRET_VALUE = process.env.JWT_SECRET ?? ''
if (JWT_SECRET_VALUE.length < 32) {
  throw new Error(
    'JWT_SECRET is missing or too short — set a random 32+ char secret in .env ' +
    '(e.g. `node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"`).'
  )
}
export const JWT_SECRET = JWT_SECRET_VALUE

/** Shared secret for the notifications WS mini-service broadcast endpoint
 *  (POST /notify): the app proves itself with 'x-notify-secret' — a stranger
 *  on the loopback/gateway can no longer inject fake notifications. */
export const WS_NOTIFY_SECRET = str('WS_NOTIFY_SECRET')

// ---------- First-run seeding ----------

/**
 * /api/seed is a demo-data bootstrap. It is DISABLED unless this flag is
 * explicitly set, so a fresh production deployment can never be seeded by a
 * stranger hitting the URL. Set TCMS_ENABLE_SEED=true only while seeding.
 */
export const ENABLE_SEED = str('TCMS_ENABLE_SEED').toLowerCase() === 'true'

// ---------- Maintenance + abuse protection (backlog B5/B6) ----------

/**
 * Maintenance switch: TCMS_READ_ONLY=true answers every write (POST/PUT/PATCH/DELETE)
 * with 503 except sign-in, token refresh and sign-out (src/lib/server/read-only.ts).
 * Read at boot — restart the app to change it.
 */
export const READ_ONLY = str('TCMS_READ_ONLY').toLowerCase() === 'true'

/** Per-IP login limit (in memory, single instance): failed sign-ins per window → 429. */
export const LOGIN_IP_MAX_FAILURES = int('TCMS_LOGIN_IP_MAX_FAILURES', 30)
export const LOGIN_IP_WINDOW_SECONDS = int('TCMS_LOGIN_IP_WINDOW_SECONDS', 900)

// ---------- Logging ----------

/** Directory for rotating log files (logs/app-*.log, logs/error-*.log). */
export const LOG_DIR = str('LOG_DIR', 'logs')

/** Days to keep log files; older files are purged once per day. */
export const LOG_RETENTION_DAYS = int('LOG_RETENTION_DAYS', 14)

// ---------- Database pool ----------

/** The app's MySQL URL (app user, DML only). Never logged. */
export const DATABASE_URL = str('DATABASE_URL')

/** Pool size per process. Applied when DATABASE_URL has no connection_limit; an explicitly
 *  set TCMS_DB_CONNECTION_LIMIT always wins. 40 serves 1000+ users on one instance (HLD §7). */
export const DB_CONNECTION_LIMIT = int('TCMS_DB_CONNECTION_LIMIT', 40)
export const DB_CONNECTION_LIMIT_SET = Boolean(str('TCMS_DB_CONNECTION_LIMIT'))

/** Seconds a request waits for a free pooled connection before 503 "server busy". */
export const DB_POOL_TIMEOUT_SECONDS = int('TCMS_DB_POOL_TIMEOUT', 10)

/** A request slower than this is logged as a warning; faster successful reads are debug lines. */
export const SLOW_REQUEST_MS = int('TCMS_SLOW_REQUEST_MS', 1_000)

/** Prisma prints every SQL statement (`prisma:query`) only when this is true. Off by default. */
export const LOG_SQL = str('TCMS_LOG_SQL').toLowerCase() === 'true'

/**
 * Dedicated LOGS BOT (separate from the user-notification bot): when both
 * keys are set, warn/error lines are mirrored to that Telegram chat so the
 * owner sees production problems the moment they happen. Never log secrets.
 */
export const TELEGRAM_LOG_BOT_TOKEN = str('TELEGRAM_LOG_BOT_TOKEN')
export const TELEGRAM_LOG_CHAT_ID = str('TELEGRAM_LOG_CHAT_ID')
/** Minimum level mirrored to Telegram: debug | info | warn | error (default error). */
export const TELEGRAM_LOG_LEVEL = str('TELEGRAM_LOG_LEVEL', 'error').toLowerCase()
/** Minimum milliseconds between outbound Telegram log messages (burst guard). */
export const TELEGRAM_LOG_MIN_INTERVAL_MS = int('TELEGRAM_LOG_MIN_INTERVAL_MS', 2_000)

// ---------- Notifications ----------

/** User-notification bot (per-user chat ids from Settings -> Profile). */
export const TELEGRAM_BOT_TOKEN = str('TELEGRAM_BOT_TOKEN')

/** SMTP for outbound email notifications; email is skipped when HOST is unset. */
export const SMTP_HOST = str('SMTP_HOST')
export const SMTP_PORT = int('SMTP_PORT', 587)
export const SMTP_SECURE = str('SMTP_SECURE').toLowerCase() === 'true' || str('SMTP_PORT') === '465'
export const SMTP_USER = str('SMTP_USER')
export const SMTP_PASS = str('SMTP_PASS')
export const SMTP_FROM = str('SMTP_FROM', 'tcms@localhost')

/** Loopback broadcast endpoint of the notifications WS mini-service. */
export const WS_NOTIFY_URL = str('WS_NOTIFY_URL', 'http://127.0.0.1:3004/notify')

// ---------- Crew Desk integration ----------

/**
 * Base URL of the Crew Desk API. When unset the start script boots the local
 * MOCK on 127.0.0.1:3010 and points this at it — real addresses are only
 * ever configured deliberately via .env.
 */
export const CREWDESK_BASE_URL = str('CREWDESK_BASE_URL', 'https://api.crewdesk.shipgl.in').replace(/\/+$/, '')
/** Whether the deployment explicitly set CREWDESK_BASE_URL (mock vs real backend display). */
export const CREWDESK_BASE_URL_SET = Boolean(str('CREWDESK_BASE_URL'))

/** manual = zero Crew Desk calls · test = single guarded ticket · live = any ticket. */
export const CREWDESK_MODE = str('CREWDESK_MODE').trim().toLowerCase()

/** Fixed bearer token (auth mode a). */
export const CREWDESK_TOKEN = str('CREWDESK_TOKEN')

/** Password login (auth mode b) — JWT kept in memory only. */
export const CREWDESK_AUTH = str('CREWDESK_AUTH').trim().toLowerCase()
export const CREWDESK_LOGIN_EMAIL = str('CREWDESK_LOGIN_EMAIL')
export const CREWDESK_LOGIN_PASSWORD = str('CREWDESK_LOGIN_PASSWORD')
export const CREWDESK_LOGIN_PATH = str('CREWDESK_LOGIN_PATH', '/api/login')

/** The shared service account's Crew Desk user id — sent with EVERY comment. */
export const CREWDESK_USER_ID = str('CREWDESK_USER_ID').trim()

/** The ONLY ticket test mode may ever comment on (owner-designated: 1355). */
export const CREWDESK_TEST_TICKET_ID = str('CREWDESK_TEST_TICKET_ID', '1355')

/** Per-request timeout for Crew Desk HTTP calls. */
export const CREWDESK_TIMEOUT_MS = int('CREWDESK_TIMEOUT_MS', 8_000)
