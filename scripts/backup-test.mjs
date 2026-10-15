#!/usr/bin/env node
// backup-test.mjs — permanent verifier for task mysql-backup-1 (daily MySQL
// backups + Task B small fixes). Sandbox-only; the repo's real .env is never
// modified — every child gets EXPORTED env (mysql-env.sh gap-fill semantics).
//
// What it proves, in order:
//   A. SHOW GRANTS for tcms_backup — read-only dump privilege set, no writes.
//   B. Scheduler-path backup (node backup-scheduler.mjs --run-now): exit 0,
//      a NEW .sql.gz appears, non-empty, gzip -t OK, "-- Dump completed" tail.
//   C. ps-safety: while the backup runs, `ps -eo args` shows NO password and
//      no -p flag (credentials travel in a chmod-600 defaults file).
//   D. LOUD failure (wrong dump password): --run-now exits non-zero, a line
//      lands in logs/error-<UTC-day>.log, and an in-app notification
//      (type backup_failed) is inserted for EXACTLY the active users holding
//      manage_users.
//   E. Staleness (27 h old backup): --check-stale exits 1 + error-log line +
//      same notifications.
//   F. Restore drill: restore-mysql.sh per-table row counts match the live
//      schema; the scratch schema is dropped afterwards.
//   G. Task B: login with " Admin@TCMS.com " (spaces + caps) succeeds;
//      the production startup guard refuses a ChangeMe_local_migrate
//      DATABASE_URL (and accepts a real-password URL — precise refusal).
//
// Cleanup (finally-style, even on failure): test-inserted notifications are
// deleted by id (diff against the pre-test snapshot — never real data), the
// fake-stale file is removed, a fresh valid backup is left in backups/, the
// guard-eval temp file is removed. Secrets never appear in output (asserted).
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, rmSync, appendFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BACKUP_DIR = resolve(ROOT, 'backups')
const MYSQL = '/tmp/mysql84/bin/mysql'
const DB = 'tcms_test' // the mysqlRoot helper below never sets a default schema
const MYSQL_ENV = { ...process.env, LD_LIBRARY_PATH: '/tmp/mysql84/extra-lib' }
const BACKUP_PASS = 'ChangeMe_local_backup' // sandbox default, mysql84-boot.sh (safe to embed)

let PASS = 0, FAIL = 0
const ok = (m) => { PASS++; console.log(`PASS: ${m}`) }
const bad = (m) => { FAIL++; console.log(`FAIL: ${m}`) }
const section = (m) => console.log(`\n=== ${m} ===`)

const captured = []
function sh(cmd, opts = {}) {
  const res = spawnSync('bash', ['-c', cmd], { cwd: ROOT, encoding: 'utf8', ...opts })
  const text = `${res.stdout || ''}\n${res.stderr || ''}`
  captured.push(text)
  return res
}

function mysqlRoot(sql) {
  const res = spawnSync(MYSQL, ['--no-defaults', '-N', '-h', '127.0.0.1', '-P', '5500', '-u', 'root', '-e', sql], {
    encoding: 'utf8', timeout: 20_000, env: MYSQL_ENV,
  })
  captured.push(`${res.stdout || ''}\n${res.stderr || ''}`)
  return { status: res.status, out: (res.stdout || '').trim(), err: (res.stderr || '').trim() }
}

// ---- .env read-only parse (gap-fill, never written back) --------------------
const envFile = {}
try {
  for (const line of readFileSync(resolve(ROOT, '.env'), 'utf8').split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim())
    if (m) envFile[m[1]] = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
  }
} catch { /* .env absent — sandbox fallbacks cover it */ }

// CLEAN env base: the harness shell may carry stray exports (DIRECT_URL,
// TCMS_ENABLE_SEED, a &-truncated DATABASE_URL from interactive use) that
// would pollute production-guard scenarios and alert resolution. Children get
// exactly the variables they need — like the boot scripts assemble them.
const CLEAN_BASE = {}
for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TERM', 'SHELL', 'USER', 'LD_LIBRARY_PATH']) {
  if (process.env[k] !== undefined) CLEAN_BASE[k] = process.env[k]
}
const APP_ENV = {
  ...CLEAN_BASE,
  DATABASE_URL: envFile.DATABASE_URL || 'mysql://tcms_app:ChangeMe_local_only@127.0.0.1:5500/tcms_test?connection_limit=40&pool_timeout=10',
}

function assertNoSecretLeak(label) {
  const text = captured.join('\n')
  for (const bad of [BACKUP_PASS, 'ChangeMe_local_only', 'ChangeMe_local_migrate']) {
    if (text.includes(bad)) {
      bad(`LEAK-ASSERTION FAILED in ${label}: output contains a credential string`)
      process.exit(1)
    }
  }
  ok(`no credential strings in captured output (${label})`)
}

// ---- scheduler child helpers -------------------------------------------------
function runScheduler(args, extraEnv = {}) {
  const res = spawnSync(process.execPath, ['scripts/backup-scheduler.mjs', ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 120_000,
    env: { ...APP_ENV, ...extraEnv },
  })
  captured.push(`${res.stdout || ''}\n${res.stderr || ''}`)
  return res
}

const listBackups = () => readdirSync(BACKUP_DIR).filter((f) => /^tcms-backup-.*\.sql\.gz$/.test(f)).sort().reverse()

function newestValid() {
  for (const f of listBackups()) {
    const full = resolve(BACKUP_DIR, f)
    if (statSync(full).size === 0) continue
    if (spawnSync('gzip', ['-t', full]).status !== 0) continue
    const tail = spawnSync('sh', ['-c', 'gunzip -c "$1" | tail -n 1', 'sh', full], { encoding: 'utf8' })
    if (tail.status === 0 && tail.stdout.includes('-- Dump completed')) return f
  }
  return null
}

const errLogFile = () => resolve(ROOT, 'logs', `error-${new Date().toISOString().slice(0, 10)}.log`)
const errLogBackupLines = () => {
  try {
    return readFileSync(errLogFile(), 'utf8').split('\n').filter((l) => l.includes('backup')).length
  } catch { return 0 }
}

// ---- notification snapshot / diff (test rows are deleted at the end) --------
const MANAGE_USERS_SQL =
  `(u.is_active = 1 AND (u.role IN ('vp','manager') OR EXISTS (SELECT 1 FROM ${DB}.role_permissions rp WHERE rp.role = u.role AND rp.action = 'manage_users' AND rp.enabled = 1)))`

function backupFailedIds() {
  const r = mysqlRoot(`SELECT notification_id FROM ${DB}.notifications WHERE type='backup_failed';`)
  if (r.status !== 0) throw new Error(`notification query failed: ${r.err}`)
  return new Set(r.out ? r.out.split('\n') : [])
}

function insertAlertRows(label, beforeSet) {
  const now = backupFailedIds()
  const newIds = [...now].filter((id) => !beforeSet.has(id))
  if (newIds.length === 0) { bad(`${label}: no new backup_failed notifications inserted`); return }
  ok(`${label}: ${newIds.length} backup_failed notification rows inserted`)
  // Every recipient must hold manage_users (no strays, none skipped).
  const idList = newIds.map((id) => `'${id}'`).join(',')
  const q = `SELECT COUNT(*) FROM ${DB}.notifications n JOIN ${DB}.users u ON u.user_id = n.user_id WHERE n.notification_id IN (${idList}) AND NOT ${MANAGE_USERS_SQL};`
  const stray = mysqlRoot(q)
  if (stray.out === '0') ok(`${label}: every recipient holds manage_users (stray-recipient count 0)`)
  else bad(`${label}: ${stray.out} recipients WITHOUT manage_users received the alert`)
  globalThis.__testNotifIds = (globalThis.__testNotifIds || []).concat(newIds)
}

const cleanupNotifs = () => {
  const ids = globalThis.__testNotifIds || []
  if (ids.length > 0) {
    mysqlRoot(`DELETE FROM ${DB}.notifications WHERE notification_id IN (${ids.map((i) => `'${i}'`).join(',')});`)
    const left = mysqlRoot(`SELECT COUNT(*) FROM ${DB}.notifications WHERE notification_id IN (${ids.map((i) => `'${i}'`).join(',')});`)
    if (left.out === '0') console.log(`[cleanup] deleted ${ids.length} test-inserted notification rows (verified 0 remain)`)
    else console.log(`[cleanup] WARNING: ${left.out} test notification rows remain`)
  }
}

// =============================================================================
async function main() {
  // ---------- A. SHOW GRANTS for tcms_backup ----------
  section('A. SHOW GRANTS for tcms_backup')
  const grants = mysqlRoot("SHOW GRANTS FOR 'tcms_backup'@'127.0.0.1';")
  console.log(grants.out)
  const g = grants.out.toLowerCase()
  if (grants.status === 0 && g.includes('select') && g.includes('show view') && g.includes('trigger')) ok('grants include SELECT, SHOW VIEW, TRIGGER')
  else bad(`grants missing dump privileges: ${grants.err || grants.out}`)
  if (/\b(insert|update|delete|create|drop|alter)\b/.test(g)) bad('grants contain a WRITE privilege (must be read-only)')
  else ok('grants contain NO write privilege (read-only dump user confirmed)')

  // ---------- B. scheduler-path backup ----------
  section('B. Backup through the scheduler path (--run-now)')
  const beforeFiles = listBackups()
  const run1 = runScheduler(['--run-now'])
  console.log(run1.stdout.trim())
  const file1 = newestValid()
  if (run1.status === 0) ok('--run-now exited 0')
  else bad(`--run-now exited ${run1.status}`)
  if (file1 && !beforeFiles.includes(file1)) ok(`new valid backup file appeared: ${file1}`)
  else bad(`no new valid backup file (newest: ${file1})`)
  const size1 = statSync(resolve(BACKUP_DIR, file1)).size
  if (size1 > 1000) ok(`backup non-empty (${size1} bytes)`)
  else bad(`backup suspiciously small: ${size1} bytes`)
  const tail1 = spawnSync('sh', ['-c', 'gunzip -c "$1" | tail -n 1', 'sh', resolve(BACKUP_DIR, file1)], { encoding: 'utf8' })
  if (tail1.stdout.includes('-- Dump completed')) ok(`dump tail verified: ${tail1.stdout.trim()}`)
  else bad(`dump tail missing "Dump completed": ${tail1.stdout.trim()}`)

  // ---------- C. ps shows no password ----------
  section('C. ps during a backup shows no password / no -p flag')
  let sawDump = false, leak = false
  for (let attempt = 0; attempt < 3 && !sawDump; attempt++) {
    const child = spawn(process.execPath, ['scripts/backup-scheduler.mjs', '--run-now'], {
      cwd: ROOT, env: APP_ENV, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out1 = ''
    child.stdout.on('data', (d) => { out1 += d })
    child.stderr.on('data', (d) => { out1 += d })
    while (child.exitCode === null && child.signalCode === null) {
      const ps = spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' })
      for (const line of (ps.stdout || '').split('\n')) {
        if (!/mysqldump/.test(line)) continue
        sawDump = true
        captured.push(line)
        if (line.includes(BACKUP_PASS) || /(^|\s)-p(\s|=|$)/.test(line)) {
          leak = true
          console.log(`PS-LEAK LINE: ${line}`)
        }
      }
      // Yield to the event loop: without this, the synchronous ps polling
      // starves libuv and the child's exit is never reaped (exitCode stays
      // null forever — the loop would never terminate).
      await new Promise((r) => setTimeout(r, 20))
    }
    // Race-safe wait: attach the exit listener only when the child has NOT
    // already exited (a settled child never re-fires 'exit' — the await
    // below would hang forever).
    await new Promise((r) => {
      if (child.exitCode !== null || child.signalCode !== null) r()
      else child.once('exit', r)
    })
    captured.push(out1)
  }
  if (sawDump) ok(`observed ${sawDump ? 'the running mysqldump' : ''} process via ps (polling)`)
  else bad('never caught mysqldump in ps (backup too fast?) — increase attempts')
  if (!leak) ok('no ps line contains the dump password or a -p flag')
  else bad('PASSWORD VISIBLE IN ps — credentials contract violated')

  // ---------- D. failure is LOUD (wrong dump password) ----------
  section('D. Failure test: wrong dump password -> error log + notifications')
  const notifsBefore = backupFailedIds()
  const errBefore = errLogBackupLines()
  const wrongUrl = `mysql://tcms_backup:WrongPass-${randomUUID().slice(0, 8)}@127.0.0.1:5500/tcms_test`
  const run2 = runScheduler(['--run-now'], { BACKUP_DATABASE_URL: wrongUrl })
  console.log((run2.stdout || '').trim().split('\n').slice(0, 4).join('\n'))
  if (run2.status !== 0) ok(`failed backup exits non-zero (${run2.status})`)
  else bad('failed backup exited 0 — failure is NOT loud')
  const errAfter = errLogBackupLines()
  if (errAfter > errBefore) ok(`logs/error-<day>.log gained ${errAfter - errBefore} backup line(s)`)
  else bad('no new line in logs/error-<day>.log')
  insertAlertRows('failure alert', notifsBefore)

  // ---------- E. staleness (fake 27-hour-old backup) ----------
  section('E. Stale test: newest valid backup touched to 27 h old')
  const run3 = runScheduler(['--run-now'])
  if (run3.status !== 0) bad(`fresh backup before stale test failed (${run3.status})`)
  const fresh = newestValid()
  execFileSync('touch', ['-d', '27 hours ago', resolve(BACKUP_DIR, fresh)])
  const notifsBeforeStale = backupFailedIds()
  const errBeforeStale = errLogBackupLines()
  const run4 = runScheduler(['--check-stale'])
  console.log(run4.stdout.trim())
  if (run4.status === 1) ok('--check-stale exited 1 (stale detected)')
  else bad(`--check-stale exited ${run4.status} (expected 1)`)
  if (errLogBackupLines() > errBeforeStale) ok('stale alert line written to logs/error-<day>.log')
  else bad('no stale alert line in error log')
  insertAlertRows('stale alert', notifsBeforeStale)
  rmSync(resolve(BACKUP_DIR, fresh)) // remove the fake-stale file (test artifact)
  const run5 = runScheduler(['--run-now'])
  if (run5.status === 0 && newestValid()) ok('fresh valid backup restored after stale test (fake file removed)')
  else bad('could not restore a fresh valid backup after the stale test')

  // ---------- F. restore drill ----------
  section('F. Restore drill into a scratch schema')
  const drillDb = `tcms_restore_drill_${randomUUID().slice(0, 8)}`
  const fileF = newestValid()
  const drill = sh(`bash scripts/restore-mysql.sh --file "${resolve(BACKUP_DIR, fileF)}" --database ${drillDb}`, { timeout: 180_000 })
  console.log(drill.stdout.trim().split('\n').slice(-6).join('\n'))
  if (drill.status === 0) ok('restore drill exited 0 (all per-table counts match live)')
  else bad(`restore drill exited ${drill.status}`)
  const counts = (drill.stdout || '').match(/drill-counts (\w+)=(\d+) \(live (\d+)\)/g) || []
  if (counts.length >= 10) ok(`per-table drill-counts lines present (${counts.length} tables)`)
  else bad(`too few drill-counts lines: ${counts.length}`)
  const left = mysqlRoot(`SHOW DATABASES LIKE '${drillDb}';`)
  if (left.out === '') ok(`scratch schema ${drillDb} dropped (SHOW DATABASES LIKE returns empty)`)
  else bad(`scratch schema still present: ${left.out}`)

  // ---------- G1. Task B: spaced/caps email login ----------
  section('G1. Task B: login with " Admin@TCMS.com " (spaces + caps)')
  let health = sh(`curl -s -o /dev/null -m 5 -w '%{http_code}' http://localhost:3000/api`).stdout.trim()
  if (health !== '200') {
    console.log('[setup] app not responding — booting the stack via start-tcms.sh...')
    sh('bash scripts/start-tcms.sh', { timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'] })
    health = sh(`curl -s -o /dev/null -m 5 -w '%{http_code}' http://localhost:3000/api`).stdout.trim()
  }
  if (health !== '200') bad(`app not reachable on :3000 (GET /api -> ${health})`)
  else {
    const login = sh(`curl -s -m 15 -w '\\n%{http_code}' -X POST "http://localhost:3000/api/auth?path=login" -H 'Content-Type: application/json' -H 'X-Requested-With: tcms' -d '{"email":" Admin@TCMS.com ","password":"Admin@123"}'`)
    const lines = (login.stdout || '').trim().split('\n')
    const code = lines[lines.length - 1]
    const body = lines.slice(0, -1).join('\n')
    if (code === '200' && body.includes('"email":"admin@tcms.com"') && body.includes('Alice Admin')) ok('login with " Admin@TCMS.com " -> 200, session for the normalized admin@tcms.com account')
    else bad(`spaced/caps login failed: http ${code}, body: ${body.slice(0, 200)}`)
  }

  // ---------- G2. Task B: startup guard refuses ChangeMe_local_migrate ----------
  section('G2. Task B: production guard refuses ChangeMe_local_migrate')
  const guardTs = `/tmp/tcms-guard-eval-${randomUUID().slice(0, 8)}.ts`
  writeFileSync(guardTs, `const { assertAppStartup } = await import('${ROOT}/src/lib/server/startup-guard.ts')\nassertAppStartup('tcms-backup-test')\n`)
  try {
    const hex = () => randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')
    const prodEnv = {
      ...CLEAN_BASE,
      TCMS_DEPLOY_ENV: 'production',
      JWT_SECRET: hex() + hex(), // 64 chars, valid
      WS_NOTIFY_SECRET: hex(),   // 32 chars, valid
    }
    const refusal = spawnSync('bun', [guardTs], {
      encoding: 'utf8', timeout: 60_000, cwd: '/tmp', // bun auto-loads .env from CWD — /tmp has none
      env: { ...prodEnv, DATABASE_URL: 'mysql://tcms_migrate:ChangeMe_local_migrate@db.internal.example:3306/tcms' },
    })
    captured.push(`${refusal.stdout || ''}\n${refusal.stderr || ''}`)
    console.log((refusal.stderr || refusal.stdout || '').trim())
    if (refusal.status === 1 && `${refusal.stdout}${refusal.stderr}`.includes('matches a known placeholder')) ok('guard REFUSES a ChangeMe_local_migrate DATABASE_URL (exit 1, placeholder reason)')
    else bad(`guard did not refuse as expected (exit ${refusal.status})`)
    if (/found 1 problem/.test(`${refusal.stdout}${refusal.stderr}`)) ok('the placeholder password is the ONLY problem (precise refusal, clean env)')
    else bad('refusal fired for additional reasons (env not clean)')
    if (!`${refusal.stdout}${refusal.stderr}`.includes('ChangeMe_local_migrate')) ok('refusal output does not print the placeholder value')
    else bad('refusal output printed the placeholder value')

    const pass = spawnSync('bun', [guardTs], {
      encoding: 'utf8', timeout: 60_000, cwd: '/tmp',
      env: { ...prodEnv, DATABASE_URL: `mysql://tcms_migrate:${hex()}@db.internal.example:3306/tcms` },
    })
    captured.push(`${pass.stdout || ''}\n${pass.stderr || ''}`)
    if (pass.status === 0) ok('positive control: same URL with a real password passes the guard (exit 0)')
    else bad(`positive control failed (exit ${pass.status}): ${(pass.stderr || '').trim().slice(0, 200)}`)
  } finally {
    rmSync(guardTs, { force: true })
  }

  // ---------- leak assertion + summary ----------
  assertNoSecretLeak('full run')
  console.log(`\nSUMMARY: PASS=${PASS} FAIL=${FAIL}`)
  process.exit(FAIL === 0 ? 0 : 1)
}

// ---- finally-style cleanup (runs even on failure) ---------------------------
try {
  await main()
} catch (err) {
  console.error(`FATAL: ${err.message}`)
  FAIL++
} finally {
  cleanupNotifs()
  const leftovers = existsSync('/tmp') ? readdirSync('/tmp').filter((f) => f.startsWith('tcms-backup-') && f.endsWith('.cnf')) : []
  if (leftovers.length > 0) {
    for (const f of leftovers) rmSync(resolve('/tmp', f), { force: true })
    appendFileSync(errLogFile(), `[tcms] ${new Date().toISOString()} ERROR backup-test: removed leftover defaults files: ${leftovers.join(', ')}\n`)
    console.log(`[cleanup] removed leftover defaults files: ${leftovers.join(', ')}`)
  } else {
    console.log('[cleanup] no leftover defaults files in /tmp (all removed by their owners)')
  }
  console.log(`CLEANUP-DONE PASS=${PASS} FAIL=${FAIL}`)
  process.exit(FAIL === 0 ? 0 : 1)
}
