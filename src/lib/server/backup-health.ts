// Independent backup staleness check — the app-side SECOND SAFETY NET for the
// daily MySQL backups (owner contract, TASK B): the scheduler's --check-stale
// only runs inside scripts/backup-scheduler.mjs, so if that process dies the
// nightly "backup stale" alert dies with it. This module runs INSIDE the Next
// server, which is a different process with a different lifecycle, and raises
// the SAME backup_failed alert the scheduler raises.
//
// Contract (owner spec):
//   - Runs ONCE PER DAY PER PROCESS: once shortly after boot, then on a
//     lightweight in-process timer at every UTC midnight (each fire is day-
//     gated, so a long-lived process never checks twice in the same UTC day).
//   - The alert itself is additionally deduped against the notifications
//     table: if ANY backup_failed row already exists for the current UTC day
//     (from this process, a restart, or the scheduler), no second alert is
//     written — one alert per day reaches manage_users, never more.
//   - NEVER throws into a request: the monitor is fire-and-forget from
//     instrumentation register(); every async path is wrapped and failures
//     land in the structured logger, never in a handler or the boot path.
//   - OFF when no backup dir is configured: the check resolves
//     TCMS_BACKUP_DIR (override for tests/unusual layouts) or <cwd>/backups
//     — the same directory scripts/backup-scheduler.mjs writes. When the
//     directory does not exist the monitor logs one line and stays dormant.
//
// Validity mirrors the scheduler exactly: a VALID backup is non-empty, passes
// `gzip -t`, and its decompressed tail contains mysqldump's
// "-- Dump completed" footer. Only VALID files count as fresh.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Prisma } from '@prisma/client'
import { logger } from '@/lib/logger'
import { db } from '@/lib/db'
import { BACKUP_DIR } from '@/lib/server/config'

const execFileAsync = promisify(execFile)

const STALE_AFTER_H = 26 // same threshold as backup-scheduler.mjs STALE_AFTER_H
const BOOT_DELAY_MS = 8_000 // let the server finish booting before the first check
const BACKUP_PATTERN = /^tcms-backup-.*\.sql\.gz$/

// Same alert identity as the scheduler (backup_failed type, stale title).
const NOTIF_TYPE = 'backup_failed'
const NOTIF_TITLE = 'Database backup stale'

// Roles that hold manage_users in DEFAULT_PERMISSIONS (src/lib/permissions.ts)
// — mirrored constant, same sync note as backup-scheduler.mjs: runtime
// role_permissions overrides are honoured in the alert SQL below, but the
// DEFAULT matrix lives in code, so it is mirrored here.
const DEFAULT_MANAGE_USERS_ROLES = ['vp', 'manager']

// ---- state (per process) ----------------------------------------------------
let lastRunUtcDay: string | null = null
let monitorStarted = false
const utcDay = () => new Date().toISOString().slice(0, 10)

function resolveBackupDir(): { dir: string; exists: boolean } {
  const dir = BACKUP_DIR
    ? resolve(BACKUP_DIR)
    : resolve(process.cwd(), 'backups')
  return { dir, exists: existsSync(dir) }
}

// ---- backup listing / validation (async mirrors of the scheduler's checks) --

async function isValidBackup(full: string): Promise<boolean> {
  try {
    if (statSync(full).size === 0) return false
    await execFileAsync('gzip', ['-t', full], { timeout: 60_000 })
    const tail = await execFileAsync(
      'sh', ['-c', 'gunzip -c "$1" | tail -n 1', 'sh', full],
      { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }
    )
    return tail.stdout.includes('-- Dump completed')
  } catch {
    return false
  }
}

/** Newest VALID backup file name, or null (invalid newest files don't count). */
async function newestValidBackup(dir: string): Promise<string | null> {
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => BACKUP_PATTERN.test(f)).sort().reverse()
  } catch {
    return null
  }
  for (const f of files) {
    if (await isValidBackup(resolve(dir, f))) return f
  }
  return null
}

// ---- alert ------------------------------------------------------------------

/** One alert per UTC day ACROSS processes: if any backup_failed notification
 *  already exists for today (scheduler OR app), stay silent. */
async function alertAlreadySentToday(): Promise<boolean> {
  const midnightUtc = new Date(`${utcDay()}T00:00:00.000Z`)
  const rows = await db.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*) AS n FROM notifications
    WHERE type = ${NOTIF_TYPE} AND created_at >= ${midnightUtc}`
  return Number(rows[0]?.n ?? 0) > 0
}

/** Inserts the stale-backup notification for every ACTIVE user holding
 *  manage_users (runtime role_permissions overrides OR the default matrix),
 *  mirroring the scheduler's alert SQL — but written through the app's own
 *  Prisma connection, which is alive by definition when this check runs. */
async function insertStaleAlert(ageH: number, newest: string | null): Promise<void> {
  const body = newest === null
    ? 'Second safety net (app-side check): no valid backup found in the backup directory (a valid file is non-empty, passes gzip -t and ends with mysqldump\'s "Dump completed" footer). The backup scheduler may be down.'
    : `Second safety net (app-side check): the newest valid backup is ${ageH.toFixed(1)} h old (threshold ${STALE_AFTER_H} h): ${newest}. The backup scheduler may be down — take a fresh backup and check why the nightly run stopped.`
  await db.$executeRaw`
    INSERT INTO notifications (user_id, type, title, body, created_at)
    SELECT u.user_id, ${NOTIF_TYPE}, ${NOTIF_TITLE}, ${body}, UTC_TIMESTAMP(3)
    FROM users u
    WHERE u.is_active = true AND (
      EXISTS (SELECT 1 FROM role_permissions rp
              WHERE rp.role = u.role AND rp.action = 'manage_users' AND rp.enabled = true)
      OR (NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role = u.role AND rp.action = 'manage_users')
          AND u.role IN (${Prisma.join(DEFAULT_MANAGE_USERS_ROLES)})))`
}

// ---- the check --------------------------------------------------------------

async function runStalenessCheck(): Promise<void> {
  const today = utcDay()
  if (lastRunUtcDay === today) return // once per UTC day, per process
  lastRunUtcDay = today

  const { dir } = resolveBackupDir()
  const newest = await newestValidBackup(dir)
  let stale = false
  let ageH = Number.POSITIVE_INFINITY
  if (newest === null) {
    stale = true
  } else {
    ageH = (Date.now() - statSync(resolve(dir, newest)).mtimeMs) / 3_600_000
    stale = ageH > STALE_AFTER_H
  }

  if (!stale) {
    logger.info(`Backup staleness check OK: newest valid backup ${newest} is ${ageH.toFixed(1)} h old (threshold ${STALE_AFTER_H} h)`)
    return
  }

  if (await alertAlreadySentToday()) {
    logger.warn(`Backup staleness check: backup is stale (newest valid: ${newest ?? 'none'}) — alert already sent today, not duplicating`)
    return
  }
  await insertStaleAlert(ageH, newest)
  logger.error(`Backup staleness check ALERT: ${newest === null ? 'no valid backup found' : `newest valid backup ${newest} is ${ageH.toFixed(1)} h old`} (threshold ${STALE_AFTER_H} h) — backup_failed notification sent to every active user with manage_users`)
}

// ---- monitor lifecycle ------------------------------------------------------

function msUntilNextUtcMidnight(): number {
  const now = new Date()
  const next = new Date(now)
  next.setUTCHours(24, 0, 0, 0) // next UTC midnight (today 24:00 == tomorrow 00:00)
  return next.getTime() - now.getTime()
}

function armDailyTimer(): void {
  const t = setTimeout(() => {
    void runStalenessCheck().catch((err) => logger.error('Backup staleness check failed (daily timer)', err))
    armDailyTimer() // re-arm for the next UTC day
  }, msUntilNextUtcMidnight())
  // The monitor must never keep a shutting-down process alive.
  if (typeof t.unref === 'function') t.unref()
}

/** Called once from src/instrumentation.ts register(). Synchronous, never
 *  throws, never blocks boot: the first check runs after BOOT_DELAY_MS, the
 *  daily timer fires at each UTC midnight. OFF (one log line, no timer) when
 *  the backup directory does not exist. */
export function startBackupHealthMonitor(): void {
  if (monitorStarted) return
  monitorStarted = true

  const { dir, exists } = resolveBackupDir()
  if (!exists) {
    logger.info(`Backup staleness check OFF — no backup dir configured (looked for ${dir}; set TCMS_BACKUP_DIR to override)`)
    return
  }

  const boot = setTimeout(() => {
    void runStalenessCheck().catch((err) => logger.error('Backup staleness check failed (boot)', err))
  }, BOOT_DELAY_MS)
  if (typeof boot.unref === 'function') boot.unref()
  armDailyTimer()
  logger.info(`Backup staleness monitor armed: first check in ${BOOT_DELAY_MS / 1000}s, then daily at UTC midnight (dir ${dir}, threshold ${STALE_AFTER_H} h)`)
}
