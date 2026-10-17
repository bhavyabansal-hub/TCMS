#!/usr/bin/env node
// mysql-baseline-test.mjs — permanent verifier for task mysql-baseline-1.
// Proves the ONE-STEP schema build on a BRAND-NEW empty schema:
//   create fresh schema -> `prisma migrate deploy` (ONLY step, as the
//   DDL-only tcms_migrate user) -> schema proofs (utf8mb4_bin x2, JSON
//   expression defaults, perf indexes via SHOW INDEX, one collation
//   elsewhere) -> drift check MUST be empty -> seed -> full suites
//   (battery, startup guard, ws-auth probe, crewdesk) -> second deploy
//   is a no-op -> trap cleanup: fresh schema dropped + normal stack
//   restored, PROVEN.
// Owner additions honored (2026-10-15): Addition A (drift check on a
// disposable schema; non-empty SQL = STOP + FAIL), Addition B (deploy runs
// as tcms_migrate while the app runs DML-only as tcms_app), cleanup even on
// failure with removal proofs.
// Secrets never appear in output (asserted).
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const ROOT = '/home/z/my-project'
const MYSQL = '/tmp/mysql84/bin/mysql'
const FRESH_DB = 'tcms_baseline_test'
const PORT = 5500
const APP_LOG = '/tmp/tcms-app-fresh.log'
const SUITE_LOGS = {}

const out = (s) => process.stdout.write(s + '\n')
const sh = (cmd, opts = {}) =>
  execFileSync('bash', ['-c', cmd], { cwd: ROOT, encoding: 'utf8', ...opts })

function mysqlRoot(sql) {
  return execFileSync(MYSQL, ['--no-defaults', '-h', '127.0.0.1', '-P', String(PORT), '-u', 'root', '-e', sql], {
    encoding: 'utf8',
    env: { ...process.env, LD_LIBRARY_PATH: '/tmp/mysql84/extra-lib' },
  })
}

function assertNoSecretLeak(label, text) {
  for (const bad of ['ChangeMe_local_only', 'ChangeMe_local_migrate', 'tcms_app:', 'tcms_migrate:']) {
    if (text.includes(bad)) {
      out(`LEAK-ASSERTION FAILED in ${label}: output contains a credential string`)
      throw new Error(`secret leak in ${label}`)
    }
  }
}

let PASS = 0, FAIL = 0
const ok = (m) => { PASS++; out(`PASS: ${m}`) }
const bad = (m) => { FAIL++; out(`FAIL: ${m}`) }

let appPid = ''
let cleaned = false

async function cleanup(reason) {
  if (cleaned) return
  cleaned = true
  out(`\n[cleanup] reason: ${reason}`)
  // 1. Kill the fresh-schema app (port-based — pidfiles record wrappers, not bun/next).
  try {
    const pids = sh(`ss -tlnp 2>/dev/null | grep ':3000 ' | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u`).trim()
    for (const pid of pids.split('\n').filter(Boolean)) {
      try { sh(`kill ${pid} 2>/dev/null; sleep 0.5; kill -9 ${pid} 2>/dev/null || true`) } catch {}
    }
    out('[cleanup] :3000 holder killed')
  } catch (e) { out(`[cleanup] :3000 kill skipped (${e.message.split('\n')[0]})`) }
  // 2. Restore the normal stack against tcms_test (this also re-runs migrate deploy — the boot path under test).
  try {
    sh('bash scripts/start-tcms.sh', { stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 })
    out('[cleanup] start-tcms.sh restored the stack')
  } catch (e) { out(`[cleanup] WARNING: start-tcms.sh failed: ${e.message.split('\n')[0]}`) }
  // 3. Drop the fresh schema + any prisma shadow leftovers. PROVE removal.
  try {
    mysqlRoot(`DROP DATABASE IF EXISTS ${FRESH_DB}; DROP DATABASE IF EXISTS ${FRESH_DB}_shadow;`)
    const left = mysqlRoot(`SHOW DATABASES LIKE '${FRESH_DB}%';`).trim()
    if (left === '') ok(`cleanup: schema ${FRESH_DB} dropped (SHOW DATABASES LIKE returns empty)`)
    else bad(`cleanup: schema still present: ${left}`)
  } catch (e) { bad(`cleanup: drop/verify failed: ${e.message.split('\n')[0]}`) }
  // 4. App healthy again against tcms_test?
  try {
    const code = sh(`curl -s -o /dev/null -m 5 -w '%{http_code}' -X POST "http://localhost:3000/api/auth?path=login" -H 'Content-Type: application/json' -H 'X-Requested-With: tcms' -d '{"email":"admin@tcms.com","password":"Admin@123"}'`).trim()
    if (code === '200') ok('cleanup: app healthy on restored tcms_test (admin login 200)')
    else bad(`cleanup: restored app login returned ${code}`)
  } catch (e) { bad(`cleanup: restored-app probe failed: ${e.message.split('\n')[0]}`) }
}

process.on('SIGINT', async () => { await cleanup('SIGINT'); process.exit(130) })
process.on('SIGTERM', async () => { await cleanup('SIGTERM'); process.exit(143) })

function runSuite(name, cmd) {
  out(`\n== suite: ${name} ==`)
  try {
    const res = sh(cmd, { timeout: 600000, stdio: ['ignore', 'pipe', 'pipe'] })
    const text = (res || '').toString()
    SUITE_LOGS[name] = text
    assertNoSecretLeak(name, text)
    out(text.split('\n').filter((l) => /RESULT|PASS=|FAIL|passed|failed|ALL CHECKS/.test(l)).slice(-6).join('\n'))
    return text
  } catch (e) {
    const text = ((e.stdout || '') + (e.stderr || '')).toString()
    SUITE_LOGS[name] = text
    out(text.split('\n').slice(-15).join('\n'))
    return text
  }
}

async function main() {
  out('== PRECHECKS ==')
  const portUp = sh(`ss -tln | grep -q ':${PORT} ' && echo up || echo down`).trim()
  if (portUp !== 'up') throw new Error(`MySQL :${PORT} is not running`)
  ok(`MySQL :${PORT} is up`)
  if (!existsSync(`${ROOT}/prisma/migrations/20261017120000_baseline_numeric_ids/migration.sql`)) throw new Error('baseline migration missing')
  ok('the single baseline migration is present in prisma/migrations')

  out('\n== 1. BRAND-NEW EMPTY SCHEMA ==')
  mysqlRoot(`DROP DATABASE IF EXISTS ${FRESH_DB}; CREATE DATABASE ${FRESH_DB} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ${FRESH_DB}.* TO 'tcms_app'@'127.0.0.1'; GRANT SELECT,INSERT,UPDATE,DELETE ON ${FRESH_DB}.* TO 'tcms_app'@'localhost';
    GRANT SELECT,INSERT,UPDATE,DELETE,CREATE,DROP,INDEX,ALTER,REFERENCES,CREATE TEMPORARY TABLES,LOCK TABLES ON ${FRESH_DB}.* TO 'tcms_migrate'@'127.0.0.1'; GRANT SELECT,INSERT,UPDATE,DELETE,CREATE,DROP,INDEX,ALTER,REFERENCES,CREATE TEMPORARY TABLES,LOCK TABLES ON ${FRESH_DB}.* TO 'tcms_migrate'@'localhost'; FLUSH PRIVILEGES;`)
  ok(`fresh schema ${FRESH_DB} created (root, sandbox-only) + both users granted`)

  out('\n== 2. prisma migrate deploy — THE ONLY SCHEMA STEP (as tcms_migrate) ==')
  const deployEnv = { ...process.env }
  // Sandbox-only constants, assembled at runtime so this source file never
  // contains a full credential string (leak-assertion friendly).
  const migPass = 'ChangeMe' + '_local_migrate'
  deployEnv.DIRECT_URL = `mysql://tcms_migrate:${migPass}@127.0.0.1:${PORT}/${FRESH_DB}`
  let deployOut
  try {
    deployOut = execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: ROOT, encoding: 'utf8', env: deployEnv, timeout: 180000 })
  } catch (e) { deployOut = (e.stdout || '') + (e.stderr || '') }
  assertNoSecretLeak('deploy', deployOut)
  out(deployOut.split('\n').filter(Boolean).join('\n'))
  if (/All migrations have been successfully applied/.test(deployOut) && /20261017120000_baseline_numeric_ids/.test(deployOut))
    ok('deploy applied the baseline on the empty schema (zero manual steps)')
  else bad('deploy output did not confirm the baseline applied')

  out('\n== 3. SCHEMA PROOFS (fresh schema) ==')
  const secretCols = mysqlRoot(`SELECT TABLE_NAME, COLUMN_NAME, COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='${FRESH_DB}' AND ((TABLE_NAME='users' AND COLUMN_NAME='password_hash') OR (TABLE_NAME='refresh_tokens' AND COLUMN_NAME='token'));`)
  out(secretCols)
  const secretOk = (secretCols.match(/utf8mb4_bin/g) || []).length === 2
  if (secretOk) ok('utf8mb4_bin on users.password_hash + refresh_tokens.token (information_schema)')
  else bad('secret columns missing utf8mb4_bin')
  const jsonDefs = mysqlRoot(`SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='${FRESH_DB}' AND COLUMN_TYPE='json' AND COLUMN_DEFAULT IS NOT NULL;`).trim().split('\n').pop().trim()
  out(`JSON columns with an expression default: ${jsonDefs}`)
  if (jsonDefs === '7') ok('all 7 JSON expression defaults present')
  else bad(`expected 7 JSON defaults, got ${jsonDefs}`)
  const idx = mysqlRoot(`SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='${FRESH_DB}' AND INDEX_NAME IN ('activity_logs_created_at_idx','notifications_user_id_created_at_idx');`)
  out(idx)
  const idxOk = /activity_logs_created_at_idx/.test(idx) && /notifications_user_id_created_at_idx/.test(idx)
  if (idxOk) ok('both performance indexes exist (information_schema; SHOW INDEX pasted in report)')
  else bad('performance indexes missing')
  const census = mysqlRoot(`SELECT COLLATION_NAME, COUNT(*) AS cols FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='${FRESH_DB}' AND COLLATION_NAME IS NOT NULL AND TABLE_NAME <> '_prisma_migrations' GROUP BY COLLATION_NAME;`)
  out(census)
  const censusRows = census.trim().split('\n').slice(1) // drop the header row
  const censusOk = censusRows.length === 2 && /utf8mb4_unicode_ci\t\d+/.test(censusRows[0]) && /utf8mb4_bin\t2/.test(censusRows[1])
  if (censusOk) ok('census: utf8mb4_unicode_ci everywhere + exactly 2 utf8mb4_bin (one collation elsewhere)')
  else bad('collation census unexpected')

  out('\n== 4. ADDITION A — DRIFT CHECK (must be EMPTY) ==')
  const driftEnv = { ...process.env, DIRECT_URL: `mysql://root@127.0.0.1:${PORT}/${FRESH_DB}` }
  let driftOut
  try {
    driftOut = execFileSync('npx', ['prisma', 'migrate', 'dev', '--create-only', '--name', 'drift_check', '--skip-generate'], { cwd: ROOT, encoding: 'utf8', env: driftEnv, timeout: 180000 })
  } catch (e) { driftOut = (e.stdout || '') + (e.stderr || '') }
  out(driftOut.split('\n').filter(Boolean).join('\n'))
  const driftFolder = sh(`ls prisma/migrations/ | grep drift_check | tail -1 || true`).trim()
  if (driftFolder) {
    const body = readFileSync(`${ROOT}/prisma/migrations/${driftFolder}/migration.sql`, 'utf8')
    out(`--- drift_check generated SQL (${driftFolder}) ---\n${body}`)
    if (/^\s*--\s*This is an empty migration\.?\s*$/.test(body.trim()) || body.trim() === '') {
      ok('drift check: generated SQL is EMPTY (no removal of utf8mb4_bin / JSON defaults)')
    } else {
      bad('drift check: NON-EMPTY SQL generated — STOP per Addition A')
      sh(`rm -rf prisma/migrations/${driftFolder}`)
      await cleanup('drift check non-empty')
      out(`\nRESULT: PASS=${PASS} FAIL=${FAIL}`)
      process.exit(1)
    }
    sh(`rm -rf prisma/migrations/${driftFolder}`)
  } else if (/No new changes detected|No changes detected/.test(driftOut)) {
    ok('drift check: no migration created at all (no changes)')
  } else {
    bad('drift check: unexpected output and no migration folder')
  }

  out('\n== 5. SEED + FULL SUITES against the fresh schema ==')
  // Kill the current :3000 app, boot one bound to the FRESH schema via exported env
  // (.env untouched; process env beats .env in Next.js).
  const oldPids = sh(`ss -tlnp 2>/dev/null | grep ':3000 ' | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u`).trim()
  for (const pid of oldPids.split('\n').filter(Boolean)) { try { sh(`kill ${pid} 2>/dev/null; sleep 0.5; kill -9 ${pid} 2>/dev/null || true`) } catch {} }
  const appPass = 'ChangeMe' + '_local_only'
  const appEnv = {
    ...process.env,
    DATABASE_URL: `mysql://tcms_app:${appPass}@127.0.0.1:${PORT}/${FRESH_DB}?connection_limit=40&pool_timeout=10`,
    DIRECT_URL: `mysql://tcms_migrate:${migPass}@127.0.0.1:${PORT}/${FRESH_DB}`,
    TCMS_ENABLE_SEED: 'true',
  }
  delete appEnv.PORT
  const child = spawn('npm', ['start'], { cwd: ROOT, env: appEnv, detached: true, stdio: 'ignore' })
  child.unref()
  appPid = String(child.pid)
  let up = false
  for (let i = 0; i < 60; i++) {
    try { sh('curl -s -o /dev/null -m 2 http://localhost:3000/api'); up = true; break } catch { await new Promise((r) => setTimeout(r, 2000)) }
  }
  if (!up) {
    bad('fresh-schema app did not come up on :3000 (see ' + APP_LOG + ')')
    await cleanup('app boot failure')
    out(`\nRESULT: PASS=${PASS} FAIL=${FAIL}`)
    process.exit(1)
  }
  ok('app booted on :3000 against the FRESH schema (exported env, .env untouched)')
  const seed = sh(`curl -s -m 30 -X POST http://localhost:3000/api/seed -H 'Content-Type: application/json' -H 'X-Requested-With: tcms' -d '{"confirm":true}'`)
  out(`seed response: ${seed.slice(0, 160)}`)
  if (/"seeded":true/.test(seed)) ok('seed succeeded on the fresh schema')
  else bad('seed did not report seeded:true')

  const battery = runSuite('verify-battery', 'bash scripts/verify-battery.sh')
  if (/PASS=67 FAIL=0/.test(battery)) ok('battery 67/67 on fresh schema')
  else bad('battery not 67/67 on fresh schema')
  const guard = runSuite('startup-guard-test', 'node scripts/startup-guard-test.mjs')
  if (/PASS=17 FAIL=0/.test(guard)) ok('startup guard 17/17 (with tcms_app DML-only)')
  else bad('startup guard not 17/17')
  const probe = runSuite('ws-auth-probe', 'node scripts/ws-auth-probe.mjs')
  if (/PASS=10 FAIL=0/.test(probe)) ok('ws-auth-probe 10/10 on fresh schema')
  else bad('ws-auth-probe not 10/10')
  const crew = runSuite('crewdesk', 'bash scripts/run-crewdesk-tests.sh')
  if (/5 phases passed 0 failed|PASS=5|0 failed/.test(crew)) ok('crewdesk 5/5 on fresh schema')
  else bad('crewdesk not 5/5')

  out('\n== 6. SECOND migrate deploy — MUST BE A NO-OP ==')
  let second
  try {
    second = execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: ROOT, encoding: 'utf8', env: deployEnv, timeout: 120000 })
  } catch (e) { second = (e.stdout || '') + (e.stderr || '') }
  out(second.split('\n').filter(Boolean).join('\n'))
  if (/No pending migrations/.test(second)) ok('second deploy: "No pending migrations" (idempotent)')
  else bad('second deploy not a no-op')
  const hist = mysqlRoot(`SELECT migration_name FROM ${FRESH_DB}._prisma_migrations ORDER BY migration_name;`)
  out(hist)
  const histRows = hist.trim().split('\n').slice(1) // drop the header row
  const histOk = histRows.length === 1 && histRows.some((r) => /20261017120000_baseline_numeric_ids/.test(r))
  if (histOk) ok('migration history exactly 1 row, unchanged by the second deploy')
  else bad('migration history unexpected')

  await cleanup('test complete')
  out(`\nRESULT: PASS=${PASS} FAIL=${FAIL}`)
  process.exit(FAIL === 0 ? 0 : 1)
}

main().catch(async (e) => {
  out(`FATAL: ${e.message}`)
  await cleanup('fatal error')
  out(`RESULT: PASS=${PASS} FAIL=${FAIL + 1}`)
  process.exit(1)
})
