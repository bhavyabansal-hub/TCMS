#!/usr/bin/env node
// mysql-correctness-test.mjs — permanent verifier for TASK A (MySQL correctness):
//   1. INSERT IGNORE is gone from bug_test_case_links: inserting a link with a
//      NONEXISTENT test case id now FAILS loudly (FK error 1452 surfaces) while
//      a DUPLICATE link stays a no-op success (ON DUPLICATE KEY UPDATE <pk>=<pk>).
//      A raw INSERT IGNORE is run first as a documented BEFORE-contrast: it
//      exits 0 with a warning — exactly the silently-corrupt behavior removed.
//   2. Timezone proof under a hostile session time zone: SET GLOBAL
//      time_zone='+05:30', boot a FRESH app instance (its whole Prisma pool is
//      created after the switch, so every session is +05:30), create a probe
//      user via the Prisma ORM (Prisma must write UTC literals), update the
//      profile via the API (repository raw SQL must write UTC_TIMESTAMP(3)),
//      then compare the two stored timestamps: < 5 s apart and both equal to
//      the UTC wall clock. A NOW()-era write under +05:30 would store a value
//      ~5.5 h ahead and fail. A contrast UPDATE with NOW() demonstrates what
//      the old code stored. time_zone is restored to '+00:00' in finally and
//      the restore is verified.
// Cleanup (finally-style, even on failure): global time_zone restored +
// verified, the spawned :3996 app is killed port-based, the probe user and
// every child row (refresh_tokens, activity_logs, bug links, scratch bug) are
// deleted, temp files removed. Probe credentials are random per run and never
// printed; a leak assertion scans all captured output.
import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync, rmSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MYSQL = '/tmp/mysql84/bin/mysql'
const DB = 'tcms_test'
const MYSQL_ENV = { ...process.env, LD_LIBRARY_PATH: '/tmp/mysql84/extra-lib' }
const APP_PORT = 3996
const APP_URL = `http://localhost:${APP_PORT}`
const BAD_TC_ID = '999999999' // well-formed INT UNSIGNED id, no such test case

let PASS = 0, FAIL = 0
const ok = (m) => { PASS++; console.log(`PASS: ${m}`) }
const bad = (m) => { FAIL++; console.log(`FAIL: ${m}`) }
const section = (m) => console.log(`\n=== ${m} ===`)

const captured = []
function sh(cmd, opts = {}) {
  const res = spawnSync('bash', ['-c', cmd], { cwd: ROOT, encoding: 'utf8', ...opts })
  captured.push(`${res.stdout || ''}\n${res.stderr || ''}`)
  return res.stdout ? res.stdout.trim() : ''
}

// ---- mysql helpers ----------------------------------------------------------
// Credentials travel in a chmod-600 defaults file (never -p on a CLI).
const cnfRoot = resolve('/tmp', `tcms-correctness-root-${process.pid}.cnf`)
const cnfApp = resolve('/tmp', `tcms-correctness-app-${process.pid}.cnf`)
writeFileSync(cnfRoot, '[client]\nuser=root\nhost=127.0.0.1\nport=5500\n', { mode: 0o600 })
writeFileSync(cnfApp, `[client]\nuser=tcms_app\npassword=ChangeMe${'_local_only'}\nhost=127.0.0.1\nport=5500\ndatabase=${DB}\n`, { mode: 0o600 })

function mysqlCnf(cnf, sql) {
  const res = spawnSync(MYSQL, [`--defaults-extra-file=${cnf}`, '-N', '-e', sql], {
    encoding: 'utf8', timeout: 20_000, env: MYSQL_ENV,
  })
  captured.push(`${res.stdout || ''}\n${res.stderr || ''}`)
  return { status: res.status, out: (res.stdout || '').trim(), err: (res.stderr || '').trim() }
}
const mysqlRoot = (sql) => mysqlCnf(cnfRoot, sql)
const mysqlApp = (sql) => mysqlCnf(cnfApp, sql)

const q = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
const storedTs = (table, col, where) =>
  mysqlRoot(`SELECT DATE_FORMAT(${col}, '%Y-%m-%d %H:%i:%s.%f') FROM ${DB}.${table} WHERE ${where};`).out
const asUtcMs = (literal) => Date.parse(`${literal.slice(0, 26).replace(' ', 'T')}Z`)

// ---- .env read-only parse (DATABASE_URL only, never written back) -----------
let databaseUrl = `mysql://tcms_app:ChangeMe${'_local_only'}@127.0.0.1:5500/${DB}?connection_limit=40&pool_timeout=10`
try {
  const envText = readFileSync(resolve(ROOT, '.env'), 'utf8')
  const m = /^DATABASE_URL=(.*)$/m.exec(envText)
  if (m && m[1].trim().startsWith('mysql://')) databaseUrl = m[1].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
} catch { /* sandbox fallback above */ }

const CLEAN_BASE = {}
for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TERM', 'SHELL', 'USER', 'LD_LIBRARY_PATH']) {
  if (process.env[k] !== undefined) CLEAN_BASE[k] = process.env[k]
}

let appChild = null
// Scratch rows are module-scope so the finally-cleanup can remove them even
// when main() throws before/while creating them.
const probeEmail = `tz-probe-${randomUUID().slice(0, 8)}@correctness.test`
const probePassword = `Pb-${randomUUID()}${randomUUID()}` // random per run, never printed
// Explicit key far above the AUTO_INCREMENT range used by the dev data (INT UNSIGNED max 4294967295).
const scratchBugId = String(4_000_000_000 + Math.floor(Math.random() * 100_000_000))
const cookieJar = resolve('/tmp', `tcms-correctness-jar-${process.pid}.txt`) // removed in cleanup (holds session cookies)

async function killApp() {
  const pids = sh(`ss -tlnp 2>/dev/null | grep ':${APP_PORT} ' | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u`)
  for (const pid of pids.split('\n').filter(Boolean)) {
    try { sh(`kill ${pid} 2>/dev/null; sleep 0.5; kill -9 ${pid} 2>/dev/null || true`) } catch { /* gone */ }
  }
  appChild = null
}

function assertNoSecretLeak() {
  for (const secret of ['ChangeMe_local_only', 'ChangeMe_local_migrate', 'ChangeMe_local_backup']) {
    if (captured.join('\n').includes(secret)) {
      bad(`LEAK-ASSERTION FAILED: output contains a credential string`)
      process.exit(1)
    }
  }
  ok('no credential strings in captured output')
}

// =============================================================================
async function main() {
  // ---------- 0. preconditions ----------
  section('0. Preconditions')
  if (mysqlRoot('SELECT 1;').status !== 0) throw new Error('MySQL :5500 is not running')
  ok('MySQL :5500 is up')

  // ---------- 1. FK failure + duplicate no-op (the INSERT IGNORE fix) ----------
  section('1. bug_test_case_links: FK failure surfaces, duplicate stays a no-op')
  const realTcId = mysqlRoot(`SELECT test_case_id FROM ${DB}.test_cases ORDER BY created_at DESC LIMIT 1;`).out
  const realUserId = mysqlRoot(`SELECT user_id FROM ${DB}.users WHERE is_active = 1 ORDER BY created_at LIMIT 1;`).out
  if (!/^[1-9][0-9]*$/.test(realTcId) || !/^[1-9][0-9]*$/.test(realUserId)) throw new Error('could not resolve a real test_case_id/user_id for the probe')
  const ins = mysqlApp(`INSERT INTO ${DB}.bugs (bug_id, title, description, severity, status, reported_by_id, attachments, created_at, updated_at) VALUES ('${scratchBugId}', 'correctness-test scratch bug', 'created by mysql-correctness-test.mjs', 'P3', 'open', '${realUserId}', CAST('[]' AS JSON), UTC_TIMESTAMP(3), UTC_TIMESTAMP(3));`)
  if (ins.status === 0) ok('scratch bug created (deleted again in cleanup)')
  else throw new Error(`could not create scratch bug: ${ins.err}`)

  // BEFORE-contrast (documenting the removed behavior): INSERT IGNORE exits 0
  // and only warns — silently dropping the link. SHOW WARNINGS runs in the
  // same session so the downgraded 1452 warning is visible in stdout.
  const ignoreRun = mysqlApp(`INSERT IGNORE INTO ${DB}.bug_test_case_links (bug_id, test_case_id, created_at) VALUES ('${scratchBugId}', '${BAD_TC_ID}', UTC_TIMESTAMP(3)); SHOW WARNINGS;`)
  const ignoreKept = mysqlRoot(`SELECT COUNT(*) FROM ${DB}.bug_test_case_links WHERE bug_id='${scratchBugId}' AND test_case_id='${BAD_TC_ID}';`).out
  const ignoreEvidence = `${ignoreRun.out}\n${ignoreRun.err}`
  if (ignoreRun.status === 0 && ignoreKept === '0' && /1452|Cannot add or update/.test(ignoreEvidence)) {
    console.log(`contrast: INSERT IGNORE exit=0, warning=${ignoreRun.out.split('\n').find((l) => /1452/.test(l))?.trim() || '(shown below)'}, rows stored=${ignoreKept}`)
    ok('BEFORE-contrast: INSERT IGNORE silently swallows the FK violation (exit 0, 0 rows) — the removed behavior')
  } else bad(`unexpected INSERT IGNORE contrast result (exit ${ignoreRun.status}, kept=${ignoreKept}, evidence=${ignoreEvidence.slice(0, 160)})`)

  // NEW behavior: the same insert with ON DUPLICATE KEY UPDATE must FAIL.
  const fkRun = mysqlApp(`INSERT INTO ${DB}.bug_test_case_links (bug_id, test_case_id, created_at) VALUES ('${scratchBugId}', '${BAD_TC_ID}', UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE bug_id = bug_id;`)
  console.log(`new behavior: exit=${fkRun.status}, error=${fkRun.err.split('\n').slice(0, 2).join(' | ').trim()}`)
  if (fkRun.status !== 0 && /1452|Cannot add or update/.test(fkRun.err)) ok('nonexistent test case id now FAILS with FK error 1452 (strict mode intact)')
  else bad(`nonexistent test case id did NOT fail (exit ${fkRun.status})`)
  const fkKept = mysqlRoot(`SELECT COUNT(*) FROM ${DB}.bug_test_case_links WHERE bug_id='${scratchBugId}';`).out
  if (fkKept === '0') ok('no partial row was stored by the failed insert')
  else bad(`failed insert left ${fkKept} row(s) behind`)

  // Duplicate link must stay a no-op success.
  const dup1 = mysqlApp(`INSERT INTO ${DB}.bug_test_case_links (bug_id, test_case_id, created_at) VALUES ('${scratchBugId}', '${realTcId}', UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE bug_id = bug_id;`)
  const dup2 = mysqlApp(`INSERT INTO ${DB}.bug_test_case_links (bug_id, test_case_id, created_at) VALUES ('${scratchBugId}', '${realTcId}', UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE bug_id = bug_id;`)
  const dupCount = mysqlRoot(`SELECT COUNT(*) FROM ${DB}.bug_test_case_links WHERE bug_id='${scratchBugId}' AND test_case_id='${realTcId}';`).out
  if (dup1.status === 0 && dup2.status === 0 && dupCount === '1') ok('duplicate link: both inserts exit 0, exactly 1 row stored (no-op upsert confirmed)')
  else bad(`duplicate link broken (d1=${dup1.status}, d2=${dup2.status}, count=${dupCount})`)

  // ---------- 2. timezone proof under GLOBAL time_zone='+05:30' ----------
  section("2. Timezone proof: SET GLOBAL time_zone='+05:30', ORM write vs API raw-SQL write")
  await killApp() // ensure :3996 is free before we boot the probe app
  const setTz = mysqlRoot(`SET GLOBAL time_zone = '+05:30';`)
  if (setTz.status !== 0) throw new Error(`could not SET GLOBAL time_zone: ${setTz.err}`)
  const sessionTz = mysqlRoot(`SELECT @@session.time_zone;`).out
  if (sessionTz === '+05:30') ok(`fresh CLI session inherits time_zone='${sessionTz}' (global switch effective)`)
  else bad(`fresh CLI session has time_zone='${sessionTz}' (expected +05:30)`)

  try {
    // Fresh app instance: every pool connection is created AFTER the SET GLOBAL,
    // so the API's raw SQL runs under +05:30 — the hostile case. `next start`
    // gets an explicit -p (package.json's npm start hardcodes -p 3000).
    appChild = spawn('npx', ['next', 'start', '-p', String(APP_PORT)], {
      cwd: ROOT, detached: true, stdio: 'ignore',
      env: { ...CLEAN_BASE, DATABASE_URL: databaseUrl },
    })
    appChild.unref()
    let up = false
    for (let i = 0; i < 60 && !up; i++) {
      up = spawnSync('bash', ['-c', `curl -s -o /dev/null -m 2 ${APP_URL}/api`]).status === 0
      if (!up) await new Promise((r) => setTimeout(r, 2000))
    }
    if (!up) throw new Error(`probe app did not come up on :${APP_PORT}`)
    ok(`probe app booted on :${APP_PORT} (pool created AFTER the +05:30 switch)`)

    // ORM write (Prisma must store UTC regardless of session tz).
    const wallBefore = Date.now()
    const probeHash = bcrypt.hashSync(probePassword, 10)
    const ormScript = resolve(ROOT, 'scripts', `.orm-probe-${process.pid}.mjs`) // inside ROOT so '@prisma/client' resolves
    writeFileSync(ormScript, `
import { PrismaClient } from '@prisma/client'
const pc = new PrismaClient()
try {
  await pc.user.create({ data: { email: ${JSON.stringify(probeEmail)}, fullName: 'TZ Proof Probe', passwordHash: ${JSON.stringify(probeHash)}, role: 'viewer' } })
  console.log('ORM-CREATE-OK')
} finally { await pc.$disconnect() }
`)
    try {
      const ormRun = spawnSync(process.execPath, [ormScript], {
        cwd: ROOT, encoding: 'utf8', timeout: 60_000,
        env: { ...CLEAN_BASE, DATABASE_URL: databaseUrl },
      })
      captured.push(`${ormRun.stdout || ''}\n${ormRun.stderr || ''}`)
      if (ormRun.status !== 0 || !ormRun.stdout.includes('ORM-CREATE-OK')) throw new Error(`ORM probe create failed: ${(ormRun.stderr || ormRun.stdout).slice(0, 300)}`)
    } finally {
      rmSync(ormScript, { force: true }) // never leave the probe script behind
    }
    ok('probe user created via the Prisma ORM (under +05:30 sessions)')

    // API write (login -> PUT profile hits `updated_at = UTC_TIMESTAMP(3)` raw SQL).
    // Token contract: login sets HttpOnly COOKIES (tcms-access) — no tokens in
    // the body — so the profile PUT authenticates with the cookie jar.
    const jar = cookieJar
    const loginRes = spawnSync('bash', ['-c',
      `curl -s -m 15 -c '${jar}' -X POST "${APP_URL}/api/auth?path=login" -H 'Content-Type: application/json' -H 'X-Requested-With: tcms' -d '${JSON.stringify({ email: probeEmail, password: probePassword })}'`],
      { encoding: 'utf8' })
    captured.push(loginRes.stdout || '')
    const login = JSON.parse(loginRes.stdout || '{}')
    if (!login.user?.userId) throw new Error(`probe login failed: ${(loginRes.stdout || '').slice(0, 200)}`)
    const putRes = spawnSync('bash', ['-c',
      `curl -s -m 15 -o /dev/null -w '%{http_code}' -b '${jar}' -X PUT "${APP_URL}/api/auth" -H 'Content-Type: application/json' -H 'X-Requested-With: tcms' -d '{"fullName":"TZ Proof Probe Updated"}'`],
      { encoding: 'utf8' })
    captured.push(putRes.stdout || '')
    if ((putRes.stdout || '').trim() !== '200') throw new Error(`profile PUT failed: HTTP ${(putRes.stdout || '').trim()}`)
    ok('profile updated via the API (raw-SQL timestamp write)')

    // Read the RAW stored literals and compare.
    const createdAt = storedTs('users', 'created_at', `email='${q(probeEmail)}'`)
    const updatedAt = storedTs('users', 'updated_at', `email='${q(probeEmail)}'`)
    console.log(`stored literals — created_at (Prisma-written): ${createdAt} | updated_at (raw SQL UTC_TIMESTAMP(3)): ${updatedAt}`)
    const cMs = asUtcMs(createdAt), uMs = asUtcMs(updatedAt)
    const diffMs = Math.abs(uMs - cMs)
    if (diffMs < 5_000) ok(`raw-SQL-written vs Prisma-written timestamps differ by ${(diffMs / 1000).toFixed(2)} s (< 5 s)`)
    else bad(`timestamp gap too large: ${(diffMs / 1000).toFixed(1)} s (expected < 5 s — a NOW() write under +05:30 would be ~5.5 h)`)
    const wallSkewC = Math.abs(cMs - wallBefore), wallSkewU = Math.abs(uMs - Date.now())
    if (wallSkewC < 30_000 && wallSkewU < 30_000) ok('both timestamps equal the UTC wall clock (within 30 s) — both UTC, not +05:30 local')
    else bad(`timestamps are not UTC: created_at skew ${(wallSkewC / 1000).toFixed(1)} s, updated_at skew ${(wallSkewU / 1000).toFixed(1)} s`)

    // Contrast: what NOW() would have stored on the same +05:30 session.
    mysqlApp(`UPDATE ${DB}.users SET updated_at = NOW() WHERE email='${q(probeEmail)}';`)
    const nowStored = storedTs('users', 'updated_at', `email='${q(probeEmail)}'`)
    const nowSkewH = Math.abs(asUtcMs(nowStored) - Date.now()) / 3_600_000
    console.log(`contrast: NOW() on the same +05:30 session stores ${nowStored} (${nowSkewH.toFixed(2)} h off the UTC wall clock) — the bug this task fixes`)
    if (nowSkewH > 4) ok('contrast confirms the session really is +05:30 (NOW() would have corrupted the column)')
    else bad('contrast did NOT show a +05:30 shift — the proof is vacuous (session tz was not hostile)')
  } finally {
    // RESTORE FIRST — never leave the sandbox on a hostile global tz.
    const restore = mysqlRoot(`SET GLOBAL time_zone = '+00:00';`)
    const tzNow = mysqlRoot(`SELECT @@global.time_zone, @@session.time_zone;`).out
    if (restore.status === 0 && tzNow === '+00:00\t+00:00') ok(`time_zone restored and verified: ${tzNow.replace('\t', ' / ')}`)
    else bad(`time_zone restore verification failed: '${tzNow}' (SET exit ${restore.status})`)
  }

  // ---------- summary ----------
  assertNoSecretLeak()
  console.log(`\nSUMMARY: PASS=${PASS} FAIL=${FAIL}`)
  if (FAIL !== 0) process.exitCode = 1
}

// ---- finally-style cleanup (runs even on failure) ---------------------------
try {
  await main()
} catch (err) {
  console.error(`FATAL: ${err.message}`)
  FAIL++
  process.exitCode = 1
} finally {
  // 1. global time_zone back to +00:00 (idempotent — the try-block restored it
  //    on the happy path too) + verify.
  const restore = mysqlRoot(`SET GLOBAL time_zone = '+00:00';`)
  const tzNow = mysqlRoot(`SELECT @@global.time_zone;`).out
  console.log(`[cleanup] global time_zone = '${tzNow}' (restore exit ${restore.status})${tzNow === '+00:00' ? ' — verified' : ' — VERIFY FAILED'}`)
  // 2. probe app down (port-based — pid records wrappers, not next-server).
  await killApp()
  const stillUp = sh(`ss -tln 2>/dev/null | grep ':${APP_PORT} ' || true`)
  console.log(`[cleanup] :${APP_PORT} ${stillUp ? 'STILL LISTENING' : 'clear'}`)
  // 3. scratch rows (children first — FK order).
  const del = [
    `DELETE FROM ${DB}.bug_test_case_links WHERE bug_id='${scratchBugId}';`,
    `DELETE FROM ${DB}.bugs WHERE bug_id='${scratchBugId}';`,
    `DELETE FROM ${DB}.refresh_tokens WHERE user_id = (SELECT user_id FROM ${DB}.users WHERE email='${q(probeEmail)}');`,
    `DELETE FROM ${DB}.activity_logs WHERE user_id = (SELECT user_id FROM ${DB}.users WHERE email='${q(probeEmail)}');`,
    `DELETE FROM ${DB}.users WHERE email='${q(probeEmail)}';`,
  ]
  for (const stmt of del) mysqlRoot(stmt)
  const left = mysqlRoot(`SELECT (SELECT COUNT(*) FROM ${DB}.bugs WHERE bug_id='${scratchBugId}') + (SELECT COUNT(*) FROM ${DB}.users WHERE email='${q(probeEmail)}');`).out
  console.log(`[cleanup] scratch rows remaining: ${left} (expected 0)`)
  // 4. temp files + credential defaults files + cookie jar.
  for (const f of [cnfRoot, cnfApp, cookieJar]) rmSync(f, { force: true })
  const tmpLeft = spawnSync('bash', ['-c', `ls /tmp/tcms-correctness-* ${ROOT}/scripts/.orm-probe-* 2>/dev/null || true`], { encoding: 'utf8' })
  console.log(`[cleanup] temp files: ${tmpLeft.stdout.trim() ? tmpLeft.stdout.trim() : 'none left'}`)
  console.log(`CLEANUP-DONE PASS=${PASS} FAIL=${FAIL}`)
  process.exit(process.exitCode || (FAIL === 0 ? 0 : 1))
}
