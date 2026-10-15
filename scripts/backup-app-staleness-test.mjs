#!/usr/bin/env node
// backup-app-staleness-test.mjs — permanent verifier for the INDEPENDENT
// app-side backup staleness check (TASK B, src/lib/server/backup-health.ts):
//
//   1. STALE: a fake VALID backup touched to 27 h (threshold 26 h) in a temp
//      dir (TCMS_BACKUP_DIR) + a freshly booted app -> the boot-time check
//      raises the backup_failed alert: new notification rows appear for
//      manage_users holders, title 'Database backup stale'.
//   2. DEDUPE: a SECOND app process triggered the SAME DAY creates NO second
//      alert (notifications-table dedupe: one backup_failed per UTC day).
//   3. FRESH: with a brand-new valid backup in the dir, a third boot alerts
//      nothing (staleness OK path).
//   4. OFF: with TCMS_BACKUP_DIR pointing at a nonexistent dir, a fourth boot
//      stays silent (check disabled — no alert rows either way).
//
// The real backups/ dir is NEVER touched: the app under test gets a temp dir
// via the TCMS_BACKUP_DIR override; the running :3000 stack is left alone.
// Cleanup (finally-style): all spawned apps killed port-based, temp dir and
// cookie jars removed, test-inserted notifications deleted by id and verified
// gone. No credentials printed (the alert path uses the app's own DATABASE_URL).
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MYSQL = '/tmp/mysql84/bin/mysql'
const DB = 'tcms_test'
const MYSQL_ENV = { ...process.env, LD_LIBRARY_PATH: '/tmp/mysql84/extra-lib' }
const APP_PORT = 3996
const APP_URL = `http://localhost:${APP_PORT}`
const TMP = resolve('/tmp', `tcms-app-stale-test-${randomUUID().slice(0, 8)}`)

let PASS = 0, FAIL = 0
const ok = (m) => { PASS++; console.log(`PASS: ${m}`) }
const bad = (m) => { FAIL++; console.log(`FAIL: ${m}`) }
const section = (m) => console.log(`\n=== ${m} ===`)

const captured = []
function sh(cmd, opts = {}) {
  const res = spawnSync('bash', ['-c', cmd], { cwd: ROOT, encoding: 'utf8', ...opts })
  captured.push(`${res.stdout || ''}\n${res.stderr || ''}`)
  return (res.stdout || '').trim()
}

// root mysql (notifications snapshot/cleanup only — never app data writes)
const cnfRoot = resolve('/tmp', `tcms-app-stale-root-${process.pid}.cnf`)
writeFileSync(cnfRoot, '[client]\nuser=root\nhost=127.0.0.1\nport=5500\n', { mode: 0o600 })
const mysqlRoot = (sql) => {
  const res = spawnSync(MYSQL, [`--defaults-extra-file=${cnfRoot}`, '-N', '-e', sql], {
    encoding: 'utf8', timeout: 20_000, env: MYSQL_ENV,
  })
  captured.push(`${res.stdout || ''}\n${res.stderr || ''}`)
  return { status: res.status, out: (res.stdout || '').trim(), err: (res.stderr || '').trim() }
}

// ---- .env read-only parse (DATABASE_URL for the spawned apps) ---------------
let databaseUrl = `mysql://tcms_app:ChangeMe${'_local_only'}@127.0.0.1:5500/${DB}?connection_limit=40&pool_timeout=10`
try {
  const m = /^DATABASE_URL=(.*)$/m.exec(readFileSync(resolve(ROOT, '.env'), 'utf8'))
  if (m && m[1].trim().startsWith('mysql://')) databaseUrl = m[1].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
} catch { /* sandbox fallback */ }

const CLEAN_BASE = {}
for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TERM', 'SHELL', 'USER', 'LD_LIBRARY_PATH']) {
  if (process.env[k] !== undefined) CLEAN_BASE[k] = process.env[k]
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function bootApp(backupDir) {
  const env = { ...CLEAN_BASE, DATABASE_URL: databaseUrl, TCMS_BACKUP_DIR: backupDir }
  const child = spawn('npx', ['next', 'start', '-p', String(APP_PORT)], {
    cwd: ROOT, detached: true, stdio: 'ignore', env,
  })
  child.unref()
  for (let i = 0; i < 60; i++) {
    if (spawnSync('bash', ['-c', `curl -s -o /dev/null -m 2 ${APP_URL}/api`]).status === 0) return true
    await sleep(2000)
  }
  return false
}

async function killApp() {
  const pids = sh(`ss -tlnp 2>/dev/null | grep ':${APP_PORT} ' | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u`)
  for (const pid of pids.split('\n').filter(Boolean)) {
    try { sh(`kill ${pid} 2>/dev/null; sleep 0.5; kill -9 ${pid} 2>/dev/null || true`) } catch { /* gone */ }
  }
  for (let i = 0; i < 10; i++) {
    if (!sh(`ss -tln 2>/dev/null | grep ':${APP_PORT} '`)) return true
    await sleep(500)
  }
  return false
}

const backupFailedRows = () => {
  const r = mysqlRoot(`SELECT notification_id, user_id, title FROM ${DB}.notifications WHERE type='backup_failed';`)
  if (r.status !== 0) throw new Error(`notification query failed: ${r.err}`)
  return r.out ? r.out.split('\n').map((l) => l.split('\t')) : []
}

async function waitFor(fn, timeoutMs, intervalMs = 3000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > deadline) return null
    await sleep(intervalMs)
  }
}

function assertRecipientsHoldManageUsers(newRows, label) {
  const idList = newRows.map((r) => `'${r[0]}'`).join(',')
  const stray = mysqlRoot(
    `SELECT COUNT(*) FROM ${DB}.notifications n JOIN ${DB}.users u ON u.user_id = n.user_id ` +
    `WHERE n.notification_id IN (${idList}) AND NOT ` +
    `(u.is_active = 1 AND (u.role IN ('vp','manager') OR EXISTS (SELECT 1 FROM ${DB}.role_permissions rp WHERE rp.role = u.role AND rp.action = 'manage_users' AND rp.enabled = 1)));`
  )
  if (stray.out === '0') ok(`${label}: every recipient holds manage_users (stray-recipient count 0)`)
  else bad(`${label}: ${stray.out} recipients WITHOUT manage_users received the alert`)
}

function makeValidBackup(name, ageHours) {
  const f = resolve(TMP, name)
  const res = spawnSync('bash', ['-c',
    `printf '%s\\n' '-- MySQL dump 10.13' '-- dummy header' '-- Dump completed on 2026-10-15 0:00:00' | gzip > "$1" && touch -d "${ageHours} hours ago" "$1"`,
    'bash', f])
  if (res.status !== 0 || !existsSync(f)) throw new Error(`could not create fake backup ${name}`)
  return f
}

// =============================================================================
async function main() {
  section('0. Preconditions')
  if (mysqlRoot('SELECT 1;').status !== 0) throw new Error('MySQL :5500 is not running')
  ok('MySQL :5500 is up')
  mkdirSync(TMP, { recursive: true })
  // Sandbox notification hygiene (same class as backup-test.mjs's sanctioned
  // cleanup): the app check dedupes against ANY backup_failed row from the
  // current UTC day — sandbox rows left over from earlier scheduler/test runs
  // today would (correctly) suppress the alert this test must observe. Remove
  // exactly today's backup_failed rows; older alert history stays untouched.
  const preExisting = backupFailedRows().length
  mysqlRoot(`DELETE FROM ${DB}.notifications WHERE type='backup_failed' AND created_at >= UTC_DATE();`)
  const cleaned = backupFailedRows().length
  if (cleaned === 0) ok(`dedupe window clear: ${preExisting} backup_failed row(s) from today's sandbox scheduler/test runs removed, older history untouched`)
  else bad(`today's backup_failed rows could not be cleared (${cleaned} left)`)
  const before = backupFailedRows()
  ok(`notification baseline: ${before.length} backup_failed row(s) present (all pre-today)`)

  // ---------- 1. STALE: 27 h-old valid backup -> boot check alerts ----------
  section("1. Stale: fake 27 h-old valid backup + fresh app -> backup_failed alert")
  makeValidBackup('tcms-backup-20260101T000000.sql.gz', 27)
  if (!(await killApp())) throw new Error(`:${APP_PORT} not free before boot`)
  if (!(await bootApp(TMP))) throw new Error(`probe app did not come up on :${APP_PORT}`)
  ok(`app booted on :${APP_PORT} with TCMS_BACKUP_DIR=${TMP}`)
  const afterStale = await waitFor(() => {
    const rows = backupFailedRows()
    return rows.length > before.length ? rows : null
  }, 90_000)
  if (!afterStale) { bad('no new backup_failed notification within 90 s of boot (boot check did not fire)'); return }
  const newStaleRows = afterStale.slice(before.length)
  ok(`boot-time staleness check fired: ${newStaleRows.length} new backup_failed row(s)`)
  const titles = [...new Set(newStaleRows.map((r) => r[2]))]
  if (titles.length === 1 && titles[0] === 'Database backup stale') ok(`alert title is 'Database backup stale'`)
  else bad(`unexpected alert title(s): ${titles.join(' | ')}`)
  assertRecipientsHoldManageUsers(newStaleRows, 'stale alert')

  // ---------- 2. DEDUPE: second app process the same day -> no second alert ----
  section('2. Dedupe: second app process the same UTC day creates no second alert')
  if (!(await killApp())) bad(`:${APP_PORT} did not free up for the second boot`)
  const staleFile = resolve(TMP, 'tcms-backup-20260101T000000.sql.gz')
  spawnSync('bash', ['-c', `touch -d "27 hours ago" "$1"`, 'bash', staleFile]) // still 27 h old (mtime drifted ~1 min during phase 1)
  if (!(await bootApp(TMP))) throw new Error('second app boot failed')
  const grewDuringDedupe = await waitFor(() => backupFailedRows().length > afterStale.length, 45_000, 3000)
  const finalStaleCount = backupFailedRows().length
  if (!grewDuringDedupe && finalStaleCount === afterStale.length) {
    ok(`second process checked and stayed silent — still exactly ${finalStaleCount} backup_failed row(s) today`)
  } else {
    bad(`second process raised a second alert: rows went ${afterStale.length} -> ${finalStaleCount}`)
  }
  await killApp()

  // ---------- 3. FRESH: new valid backup -> no alert ----------
  section('3. Fresh: brand-new valid backup -> boot check stays silent')
  makeValidBackup(`tcms-backup-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)}00.sql.gz`, 0)
  if (!(await bootApp(TMP))) throw new Error('third app boot failed')
  const grewDuringFresh = await waitFor(() => backupFailedRows().length > finalStaleCount, 45_000, 3000)
  if (!grewDuringFresh && backupFailedRows().length === finalStaleCount) ok('fresh backup: no alert rows added (staleness OK path)')
  else bad('fresh backup unexpectedly alerted')
  await killApp()

  // ---------- 4. OFF: no backup dir -> silent ----------
  section('4. OFF: TCMS_BACKUP_DIR points at a nonexistent dir -> check disabled')
  if (!(await bootApp(resolve('/tmp', `tcms-no-such-backups-${randomUUID().slice(0, 6)}`)))) throw new Error('fourth app boot failed')
  const grewDuringOff = await waitFor(() => backupFailedRows().length > finalStaleCount, 30_000, 3000)
  if (!grewDuringOff && backupFailedRows().length === finalStaleCount) ok('OFF mode: app boots and never alerts (no backup dir configured)')
  else bad('OFF mode unexpectedly alerted')
  await killApp()

  console.log(`\nSUMMARY: PASS=${PASS} FAIL=${FAIL}`)
  if (FAIL !== 0) process.exitCode = 1
}

// ---- finally-style cleanup (runs even on failure) ---------------------------
// Deletes exactly the rows THIS test could have created: type backup_failed +
// the app-check title + created_at after the test's UTC start moment. Real
// (baseline) rows predate testStartIso and are never touched.
const testStartIso = new Date().toISOString().slice(0, 23).replace('T', ' ') // UTC literal for DATETIME(3)
try {
  await main()
} catch (err) {
  console.error(`FATAL: ${err.message}`)
  FAIL++
  process.exitCode = 1
} finally {
  await killApp()
  const testIds = mysqlRoot(
    `SELECT notification_id FROM ${DB}.notifications WHERE type='backup_failed' AND title='Database backup stale' AND created_at >= '${testStartIso}';`
  ).out.split('\n').filter(Boolean)
  if (testIds.length > 0) {
    const idList = testIds.map((i) => `'${i}'`).join(',')
    mysqlRoot(`DELETE FROM ${DB}.notifications WHERE notification_id IN (${idList});`)
    const left = mysqlRoot(`SELECT COUNT(*) FROM ${DB}.notifications WHERE notification_id IN (${idList});`).out
    console.log(`[cleanup] deleted ${testIds.length} test alert row(s); remaining: ${left} (expected 0)`)
  } else {
    console.log('[cleanup] no test alert rows to delete')
  }
  rmSync(TMP, { recursive: true, force: true })
  rmSync(cnfRoot, { force: true })
  console.log(`[cleanup] temp dir removed: ${!existsSync(TMP)}`)
  console.log(`CLEANUP-DONE PASS=${PASS} FAIL=${FAIL}`)
  process.exit(process.exitCode || (FAIL === 0 ? 0 : 1))
}
