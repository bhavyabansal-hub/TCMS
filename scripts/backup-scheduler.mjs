// Daily database backup scheduler — runs scripts/backup-db-mysql.sh (mysqldump,
// task mysql-backup-1) every day at BACKUP_AT (default 02:30 local time).
// The PostgreSQL-era backup-db.mjs child spawn is RETIRED — this scheduler
// must never invoke it again (it fails on every mysql:// URL by design).
//
// Started automatically by scripts/boot-tcms-autostart.sh (idempotent:
// pgrep-guarded; output lands in /tmp/tcms-backup-scheduler.log). On boot it
// performs a CATCH-UP backup when the newest valid backup is older than 20 h,
// so a stack restart after downtime never leaves the data without a fresh
// point-in-time copy.
//
// FAILURE IS LOUD (owner contract): a non-zero child exit raises
//   1. a line in logs/error-<UTC-day>.log (same format as src/lib/logger.ts),
//   2. an in-app notification (type backup_failed) for EVERY active user
//      holding the manage_users permission — default matrix (vp, manager)
//      plus any runtime role_permissions overrides, resolved in SQL so the
//      alert reaches whoever can actually act on it. The insert is direct
//      (mysql CLI + a chmod-600 defaults file, never a password on the
//      command line) ON PURPOSE: it must work when the app itself is down —
//      exactly when backups matter most. Users' notify_inapp preference is
//      intentionally ignored for this ops alert.
//   --run-now exits non-zero on failure; the daemon keeps looping and
//   retries at the next scheduled run.
//
// STALENESS (owner contract): when the newest VALID backup (non-empty,
// gzip -t OK, "-- Dump completed" footer) is older than STALE_AFTER_H (26 h)
// — or none exists — the same loud alert fires. Checked on boot (after
// catch-up), after every scheduled run, and on demand via --check-stale
// (exit 1 = stale). There is no dedup window: each failed check alerts,
// which bounds to ~1 alert/day while a failure persists.
//
// Env:
//   BACKUP_AT             "HH:MM" local time for the daily run   (default 02:30)
//   BACKUP_KEEP           number of backup files to retain       (default 14)
//   BACKUP_DATABASE_URL   mysql:// URL for the DUMP connection (read-only
//                         tcms_backup user) — passed straight through to
//                         backup-db-mysql.sh. Production MUST set it; falls
//                         back to the sandbox dump user otherwise.
//   BACKUP_SHIP_CMD       optional shell command run after each successful
//                         backup to copy the file OFF this server. Use {file}
//                         as the placeholder for the backup path; without a
//                         placeholder the path is appended as the last arg.
//                         Examples:
//                           BACKUP_SHIP_CMD='rclone copy {file} tcms-backups:tcms/'
//                           BACKUP_SHIP_CMD='aws s3 cp {file} s3://tcms-backups/'
//                           BACKUP_SHIP_CMD='scp {file} ops@backuphost:/srv/tcms/'
//                         A failed ship is logged loudly but never blocks the
//                         schedule — the local file always remains the source
//                         of truth for restores.
//
// Usage:
//   node scripts/backup-scheduler.mjs             # daemon: catch-up check, then daily loop
//   node scripts/backup-scheduler.mjs --run-now   # one backup + prune, then exit (ops/cron-friendly)
//   node scripts/backup-scheduler.mjs --check-stale # staleness check only (exit 1 = stale)
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync, unlinkSync, writeFileSync, appendFileSync, rmSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BACKUP_DIR = resolve(ROOT, 'backups')
const LOG_DIR = resolve(ROOT, 'logs')
const BACKUP_SCRIPT = resolve(ROOT, 'scripts', 'backup-db-mysql.sh')
const MYSQL_BIN = existsSync('/tmp/mysql84/bin/mysql') ? '/tmp/mysql84/bin/mysql' : 'mysql'
const MYSQL_ENV = existsSync('/tmp/mysql84/bin/mysql')
  ? { ...process.env, LD_LIBRARY_PATH: '/tmp/mysql84/extra-lib' }
  : process.env

const BACKUP_PATTERN = /^tcms-backup-.*\.sql\.gz$/
const BACKUP_AT = /^([01]?\d|2[0-3]):([0-5]\d)$/.test(process.env.BACKUP_AT || '')
  ? process.env.BACKUP_AT
  : '02:30'
const BACKUP_KEEP = Math.max(1, Number.parseInt(process.env.BACKUP_KEEP || '14', 10) || 14)
const CATCH_UP_AFTER_H = 20
const STALE_AFTER_H = 26

const NOTIF_TYPE = 'backup_failed'
const NOTIF_TITLE_FAIL = 'Database backup failed'
const NOTIF_TITLE_STALE = 'Database backup stale'
// Roles that hold manage_users in DEFAULT_PERMISSIONS (src/lib/permissions.ts).
// Keep in sync: runtime role_permissions overrides are honoured below in SQL,
// but the DEFAULT matrix lives in code, so it is mirrored here.
const DEFAULT_MANAGE_USERS_ROLES = ['vp', 'manager']

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
const log = (msg) => console.log(`[${ts()}] ${msg}`)
const maskUrl = (u) => u.replace(/\/\/[^@]+@/, '//***@')

// ---------- loud alerting (error log + in-app notifications) ---------------

/** Escapes a value for a single-quoted SQL literal (backslash-first order). */
const sqlEscape = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

/** The app's DML user (DATABASE_URL) — the alert INSERT runs through it.
 *  Returns null when unusable; the error-log line is still written. */
function alertConnection() {
  const raw = (process.env.DATABASE_URL || '').trim()
  if (!raw.startsWith('mysql://')) return null
  try {
    const url = new URL(raw)
    if (!url.username) return null
    const schema = decodeURIComponent(url.pathname.replace(/^\//, '')).split('/')[0]
    if (!schema) return null
    return {
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      host: url.hostname,
      port: url.port || '3306',
      schema,
    }
  } catch {
    return null
  }
}

function appendErrorLog(message) {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    // Same channel + day key + line format as src/lib/logger.ts error writes.
    const day = new Date().toISOString().slice(0, 10)
    appendFileSync(resolve(LOG_DIR, `error-${day}.log`), `[tcms] ${new Date().toISOString()} ERROR backup-scheduler: ${message}\n`)
  } catch {
    // The filesystem can reject writes (permissions, full disk) — console
    // output above is still loud, and the notification insert is independent.
  }
}

/** ONE loud alert: non-zero exit comes from the caller; this writes the
 *  error-log line and inserts a notification for every active user with
 *  manage_users (default matrix + runtime role_permissions overrides).
 *  Never throws, never prints a credential. */
function alertManageUsers(title, body) {
  log(`ALERT: ${title} — ${body}`)
  appendErrorLog(`${title}: ${body}`)
  const conn = alertConnection()
  if (!conn) {
    log('WARN: in-app notification skipped — DATABASE_URL is not a usable mysql:// URL (error log line was still written)')
    return
  }
  // Credentials go into a chmod-600 defaults file, never the command line.
  const cnf = resolve(process.env.TMPDIR || '/tmp', `tcms-scheduler-alert-${process.pid}-${randomUUID().slice(0, 8)}.cnf`)
  try {
    writeFileSync(cnf, `[client]\nuser=${conn.user}\npassword=${conn.password}\nhost=${conn.host}\nport=${conn.port}\ndatabase=${conn.schema}\n`, { mode: 0o600 })
    // Effective manage_users = runtime override when one exists, else the
    // DEFAULT_PERMISSIONS matrix (mirrored in DEFAULT_MANAGE_USERS_ROLES).
    const roleList = DEFAULT_MANAGE_USERS_ROLES.map((r) => `'${sqlEscape(r)}'`).join(', ')
    const sql =
      `INSERT INTO notifications (user_id, type, title, body) ` +
      `SELECT u.user_id, '${NOTIF_TYPE}', '${sqlEscape(title)}', '${sqlEscape(body)}' FROM users u ` +
      `WHERE u.is_active = 1 AND (` +
      `EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role = u.role AND rp.action = 'manage_users' AND rp.enabled = 1) ` +
      `OR (NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role = u.role AND rp.action = 'manage_users') ` +
      `AND u.role IN (${roleList})));`
    const res = spawnSync(MYSQL_BIN, ['--defaults-extra-file=' + cnf, '-e', sql], {
      encoding: 'utf8',
      timeout: 20_000,
      env: MYSQL_ENV,
    })
    if (res.error || res.status !== 0) {
      const first = String(res.stderr || res.error?.message || '').split('\n')[0]
      log(`WARN: in-app notification insert failed (alert remains in logs/error-*.log)${first ? `: ${first}` : ''}`)
    } else {
      log(`in-app notification '${NOTIF_TYPE}' inserted for every active user with manage_users`)
    }
  } finally {
    try { rmSync(cnf, { force: true }) } catch { /* best effort */ }
  }
}

// ---------- backup listing / validation / pruning ---------------------------

function listBackups() {
  try {
    return readdirSync(BACKUP_DIR)
      .filter((f) => BACKUP_PATTERN.test(f))
      .sort()
      .reverse() // newest first (ISO timestamp in the name sorts lexicographically)
  } catch {
    return []
  }
}

/** A VALID backup: non-empty, gzip -t OK, ends with mysqldump's
 *  "-- Dump completed on ..." footer (same checks backup-db-mysql.sh runs). */
function isValidBackup(file) {
  const full = resolve(BACKUP_DIR, file)
  try {
    if (statSync(full).size === 0) return false
    if (spawnSync('gzip', ['-t', full], { timeout: 60_000 }).status !== 0) return false
    const tail = spawnSync('sh', ['-c', 'gunzip -c "$1" | tail -n 1', 'sh', full], {
      encoding: 'utf8',
      timeout: 60_000,
    })
    return tail.status === 0 && tail.stdout.includes('-- Dump completed')
  } catch {
    return false
  }
}

/** Newest VALID backup filename, or null (invalid newest files don't count). */
function newestValidBackup() {
  for (const f of listBackups()) {
    if (isValidBackup(f)) return f
  }
  return null
}

function prune() {
  const files = listBackups()
  const stale = files.slice(BACKUP_KEEP)
  for (const f of stale) {
    try {
      unlinkSync(resolve(BACKUP_DIR, f))
      log(`pruned old backup ${f} (keeping last ${BACKUP_KEEP})`)
    } catch (err) {
      log(`WARN: could not prune ${f}: ${err.message}`)
    }
  }
  return { kept: files.length - stale.length, pruned: stale.length }
}

/** Off-server copy hook (BACKUP_SHIP_CMD). Never throws; logs the outcome. */
function shipBackup(file) {
  const cmd = process.env.BACKUP_SHIP_CMD
  if (!cmd) return Promise.resolve()
  const full = cmd.includes('{file}') ? cmd.replaceAll('{file}', file) : `${cmd} ${file}`
  log(`shipping backup off-server (BACKUP_SHIP_CMD)...`)
  return new Promise((done) => {
    const child = spawn('sh', ['-c', full], { stdio: ['ignore', 'inherit', 'inherit'] })
    child.on('exit', (code) => {
      if (code === 0) log(`ship OK: ${file}`)
      else log(`ERROR: ship command exited ${code} — backup stays local only`)
      done()
    })
    child.on('error', (err) => {
      log(`ERROR: ship command failed: ${err.message} — backup stays local only`)
      done()
    })
  })
}

// ---------- running the backup (the ONLY child: backup-db-mysql.sh) --------

/** Returns true when the backup run succeeded (verified by the script). */
function runBackup(reason) {
  const before = listBackups()[0]
  const runStartMs = Date.now() - 1_500 // clock-skew tolerance; see success check
  return new Promise((done) => {
    log(`starting backup (${reason})...`)
    // backup-db-mysql.sh logs its own summary; it resolves the read-only
    // tcms_backup credentials itself (defaults file — never a CLI password).
    const child = spawn('bash', [BACKUP_SCRIPT], {
      cwd: ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.on('exit', async (code) => {
      if (code === 0) {
        // Success requires a backup file (re)written by THIS run — compare
        // mtime, not the name: two runs inside the same UTC second share a
        // timestamp and overwrite the same file.
        const newest = newestValidBackup()
        let fresh = false
        if (newest) {
          try { fresh = statSync(resolve(BACKUP_DIR, newest)).mtimeMs >= runStartMs } catch { fresh = false }
        }
        if (!fresh) {
          alertManageUsers(
            NOTIF_TITLE_FAIL,
            'The backup script reported success but no valid backup file appeared in backups/. Check logs/error-*.log.'
          )
          done(false)
          return
        }
        const { kept, pruned } = prune()
        log(`backup OK (${newest}${newest !== before ? ', new' : ''}; retained ${kept}, pruned ${pruned})`)
        if (newest !== before) await shipBackup(resolve(BACKUP_DIR, newest))
        done(true)
      } else {
        alertManageUsers(
          NOTIF_TITLE_FAIL,
          `The MySQL backup exited with code ${code}. Check logs/error-*.log and backups/. The scheduler retries at the next scheduled run.`
        )
        done(false)
      }
    })
    child.on('error', (err) => {
      alertManageUsers(NOTIF_TITLE_FAIL, `Could not spawn the backup script: ${err.message}`)
      done(false)
    })
  })
}

/** Staleness gate: newest valid backup must be younger than STALE_AFTER_H.
 *  Returns true (and alerts) when stale or when no valid backup exists. */
function checkStaleness() {
  const newest = newestValidBackup()
  if (!newest) {
    alertManageUsers(
      NOTIF_TITLE_STALE,
      `No valid backup found in backups/ (a valid file is non-empty, passes gzip -t and ends with mysqldump's "Dump completed" footer).`
    )
    return true
  }
  const ageH = (Date.now() - statSync(resolve(BACKUP_DIR, newest)).mtimeMs) / 3_600_000
  if (ageH > STALE_AFTER_H) {
    alertManageUsers(
      NOTIF_TITLE_STALE,
      `The newest valid backup is ${ageH.toFixed(1)} h old (threshold ${STALE_AFTER_H} h): ${newest}. Take a fresh backup and check why the nightly run stopped.`
    )
    return true
  }
  log(`staleness OK: ${newest} is ${ageH.toFixed(1)} h old (threshold ${STALE_AFTER_H} h)`)
  return false
}

function msUntilNextRun() {
  const [h, m] = BACKUP_AT.split(':').map(Number)
  const now = new Date()
  const next = new Date(now)
  next.setHours(h, m, 0, 0)
  if (next <= now) next.setDate(next.getDate() + 1)
  return next - now
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// ---------- main ----------
if (process.env.BACKUP_DATABASE_URL) {
  log(`backup target override: ${maskUrl(process.env.BACKUP_DATABASE_URL)}`)
}

if (process.argv.includes('--check-stale')) {
  process.exit(checkStaleness() ? 1 : 0)
}

if (process.argv.includes('--run-now')) {
  const ok = await runBackup('manual --run-now')
  const stale = checkStaleness()
  process.exit(ok && !stale ? 0 : 1)
}

log(`backup scheduler started — daily at ${BACKUP_AT} (local), retaining last ${BACKUP_KEEP} backups, staleness threshold ${STALE_AFTER_H} h`)

// Catch-up: booting without a fresh VALID backup (e.g. after downtime) → take
// one now; afterwards the staleness gate turns any remaining gap into an alert.
const newest = newestValidBackup()
const newestAgeH = newest ? (Date.now() - statSync(resolve(BACKUP_DIR, newest)).mtimeMs) / 3_600_000 : Infinity
if (newestAgeH > CATCH_UP_AFTER_H) {
  await runBackup(newest ? `catch-up, newest valid backup is ${newestAgeH.toFixed(1)} h old` : 'no valid backup found')
} else {
  log(`recent valid backup found (${newest}, ${newestAgeH.toFixed(1)} h old) — next run at ${BACKUP_AT}`)
}
checkStaleness()

for (;;) {
  const waitMs = msUntilNextRun()
  log(`sleeping ${Math.round(waitMs / 60000)} min until next backup`)
  await sleep(waitMs)
  await runBackup(`daily schedule ${BACKUP_AT}`)
  checkStaleness()
}
