#!/usr/bin/env node
// Permanent verifier for the PRODUCTION DB SETTINGS GUARD (task
// db-settings-guard-1). Boots the REAL Next app on alt port 3995 with
// TCMS_DEPLOY_ENV=production against the SANDBOX MySQL reached through a
// disposable TCP relay (:5501 -> 127.0.0.1:5500, so the secret startup-guard
// never sees the sandbox endpoint) and proves BOTH directions:
//
//   REFUSE — exit 1, named setting + offending VALUE (requests never served:
//            Next awaits register() before handling any request)
//   UNREACHABLE — owner addition 2: closed port -> 5 attempts 3 s apart ->
//            exit 1 "database unreachable (<host>:<port>)" (>= 11 s elapsed,
//            no credentials anywhere)
//   PASS   — correct settings -> app serves, one
//            "[TCMS] db-settings OK: ... transaction_isolation=..." line
//   SANDBOX — without TCMS_DEPLOY_ENV the app boots with both guards OFF
//
// BAD SETTINGS are applied with SET GLOBAL on the sandbox mysqld (dynamic
// vars; new sessions inherit them) and restored FROM THE CAPTURED ORIGINALS
// in a finally-style cleanup that runs EVEN ON FAILURE — restore proven with
// a raw SELECT, harness user/schema dropped and proven gone, relay closed,
// ports clear, full-output secret-leak scan.
//
// Sandbox-only; nothing here touches the repo .env or any real server.

import { spawn, execFileSync } from 'node:child_process'
import net from 'node:net'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NEXT_BIN = path.join(ROOT, 'node_modules', '.bin', 'next')
const MYSQL_BIN = '/tmp/mysql84/bin/mysql'

const APP_PORT = 3995
const RELAY_PORT = 5501
const DEAD_PORT = 5599 // nothing listens here — the unreachable scenario
const BAD_SCHEMA = 'tcms_guard_bad'
const GUARD_USER = 'tcms_guard'

const hex = (n) => crypto.randomBytes(n).toString('hex')
const VALID_JWT = hex(32)
const VALID_WS_SECRET = hex(24)
const VALID_DB_PASS = hex(24)

let relayServer = null
const relaySockets = new Set()
let guardUserCreated = false
let badSchemaCreated = false
const originals = {} // captured GLOBAL settings, restored in finally
const allOutput = [] // every child output — final leak scan

const results = []
function record(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`)
}

function mysql(query) {
  // Passwordless local root on the SANDBOX mysqld only (same pattern as
  // scripts/migration/mysql84-boot.sh). Error output is sanitized so a
  // failed statement can never echo harness credentials.
  try {
    return execFileSync(
      MYSQL_BIN,
      ['--no-defaults', '-h', '127.0.0.1', '-P', '5500', '-u', 'root', '-N', '-e', query],
      { encoding: 'utf8', timeout: 15_000, env: { ...process.env, LD_LIBRARY_PATH: '/tmp/mysql84/extra-lib' } }
    )
  } catch (err) {
    const stderr = String(err.stderr || '')
    throw new Error(`mysql client failed: ${stderr.split('\n')[0] || err.message.split('\n')[0]}`)
  }
}

function startRelay() {
  return new Promise((resolve, reject) => {
    relayServer = net.createServer((client) => {
      const upstream = net.connect(5500, '127.0.0.1')
      relaySockets.add(client)
      relaySockets.add(upstream)
      client.pipe(upstream)
      upstream.pipe(client)
      const bye = (s) => {
        relaySockets.delete(s)
        try { s.destroy() } catch { /* already gone */ }
      }
      client.on('error', () => bye(client))
      upstream.on('error', () => bye(upstream))
      client.on('close', () => bye(client))
      upstream.on('close', () => bye(upstream))
    })
    relayServer.once('error', reject)
    relayServer.listen(RELAY_PORT, '127.0.0.1', () => resolve())
  })
}

async function stopRelay() {
  if (!relayServer) return
  await new Promise((resolve) => relayServer.close(() => resolve()))
  for (const s of relaySockets) {
    try { s.destroy() } catch { /* already gone */ }
  }
  relaySockets.clear()
  relayServer = null
}

function createGuardUser() {
  mysql(`CREATE USER IF NOT EXISTS '${GUARD_USER}'@'127.0.0.1' IDENTIFIED BY '${VALID_DB_PASS}';`)
  mysql(`GRANT SELECT, INSERT, UPDATE, DELETE ON tcms_test.* TO '${GUARD_USER}'@'127.0.0.1'; FLUSH PRIVILEGES;`)
  guardUserCreated = true
}

function dropGuardUser() {
  if (!guardUserCreated) return
  try {
    mysql(`DROP USER IF EXISTS '${GUARD_USER}'@'127.0.0.1'; FLUSH PRIVILEGES;`)
  } catch (err) {
    console.log(`[cleanup] WARN: DROP USER failed: ${err.message}`)
  }
  guardUserCreated = false
}

/** Run a child to completion. Returns { code, signal, out, elapsedMs }. */
function runOnce(cmd, args, cwd, extraEnv, timeoutMs = 90_000) {
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    const grab = (d) => (out += d.toString())
    child.stdout.on('data', grab)
    child.stderr.on('data', grab)
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }, timeoutMs)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      allOutput.push(out)
      resolve({ code, signal, out, elapsedMs: Date.now() - started })
    })
  })
}

/** Spawn a child expected to STAY UP; returns the child (caller kills it). */
function spawnUp(cmd, args, cwd, extraEnv) {
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.output = ''
  const grab = (d) => (child.output += d.toString())
  child.stdout.on('data', grab)
  child.stderr.on('data', grab)
  return child
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastErr = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return { ok: true, status: res.status, body: await res.text() }
      lastErr = `HTTP ${res.status}`
    } catch (err) {
      lastErr = err.message
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return { ok: false, lastErr }
}

function killChild(child) {
  return new Promise((resolve) => {
    if (child && child.output && allOutput[allOutput.length - 1] !== child.output) allOutput.push(child.output)
    if (!child || child.exitCode !== null || child.signalCode) return resolve()
    child.on('exit', () => resolve())
    try { child.kill('SIGTERM') } catch { resolve() }
    setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* gone */ }
      resolve()
    }, 5_000)
  })
}

const countLines = (out, needle) => out.split(needle).length - 1
const leaks = () =>
  [VALID_JWT, VALID_WS_SECRET, VALID_DB_PASS].filter((v) => allOutput.join('').includes(v))

// App overlay — explicit env BEATS the repo .env that Next loads.
const DB_RELAY = `mysql://${GUARD_USER}:${VALID_DB_PASS}@127.0.0.1:${RELAY_PORT}/tcms_test`
const PROD = { TCMS_DEPLOY_ENV: 'production' }
const APP_VALID = {
  ...PROD,
  JWT_SECRET: VALID_JWT,
  WS_NOTIFY_SECRET: VALID_WS_SECRET,
  DATABASE_URL: DB_RELAY,
  DIRECT_URL: DB_RELAY,
  TCMS_ENABLE_SEED: '',
  TCMS_ALLOW_SIGNUP: '',
}

async function refusalScenario(name, dbUrl, expectFragments) {
  const r = await runOnce(NEXT_BIN, ['start', '-p', String(APP_PORT)], ROOT, { ...APP_VALID, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl })
  const ok =
    r.code === 1 &&
    countLines(r.out, 'db-settings guard ACTIVE') === 1 &&
    countLines(r.out, 'production guard ACTIVE') === 1 &&
    !r.out.includes('db-settings OK') &&
    expectFragments.every((f) => r.out.includes(f)) &&
    leaks().length === 0
  console.log(`--- ${name} (raw output) ---`)
  console.log(r.out.trim() || '(no output)')
  console.log(`--- end (${((r.elapsedMs) / 1000).toFixed(1)}s) ---`)
  record(
    name,
    ok,
    ok
      ? 'exit 1, both guards ACTIVE, setting named with value, exits before serving, no secrets'
      : `exit=${r.code} signal=${r.signal} fragmentsMissing=${JSON.stringify(expectFragments.filter((f) => !r.out.includes(f)))} leaks=${JSON.stringify(leaks())}`
  )
}

async function main() {
  console.log('=== TCMS production DB settings guard test (task db-settings-guard-1) ===')
  console.log(`alt ports: app=${APP_PORT} db-relay=${RELAY_PORT} dead-db=${DEAD_PORT}`)

  // ---------- SETUP ----------
  for (const key of ['sql_mode', 'time_zone', 'character_set_server', 'collation_server']) {
    originals[key] = mysql(`SELECT @@GLOBAL.${key};`).trim()
  }
  console.log(`[harness] captured originals: ${JSON.stringify(originals)}`)
  createGuardUser()
  await startRelay()
  console.log(`[harness] ${GUARD_USER} user created (random password, NOT printed) + relay :${RELAY_PORT} -> 127.0.0.1:5500 up`)

  // ---------- 1. REFUSE: sql_mode without ONLY_FULL_GROUP_BY ----------
  mysql(`SET GLOBAL sql_mode = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';`)
  await refusalScenario(
    'refuses: sql_mode lacks ONLY_FULL_GROUP_BY',
    DB_RELAY,
    ['sql_mode =', 'ONLY_FULL_GROUP_BY', 'FATAL (db-settings)']
  )

  // ---------- 2. REFUSE: time_zone not UTC ----------
  mysql(`SET GLOBAL sql_mode = '${originals.sql_mode}'; SET GLOBAL time_zone = '+05:30';`)
  await refusalScenario(
    'refuses: time_zone = +05:30 (not UTC)',
    DB_RELAY,
    ['time_zone =', '+05:30', "must be '+00:00' or 'UTC'"]
  )

  // ---------- 3. REFUSE: server charset not utf8mb4 ----------
  mysql(`SET GLOBAL time_zone = '${originals.time_zone}'; SET GLOBAL character_set_server = latin1;`)
  await refusalScenario(
    'refuses: character_set_server = latin1',
    DB_RELAY,
    ['character_set_server =', 'latin1', 'utf8mb4']
  )

  // ---------- 4. REFUSE: SCHEMA default charset not utf8mb4 (owner addition 1) ----------
  mysql(`SET GLOBAL character_set_server = '${originals.character_set_server}'; SET GLOBAL collation_server = '${originals.collation_server}';`)
  mysql(`CREATE DATABASE ${BAD_SCHEMA} CHARACTER SET latin1;`)
  mysql(`GRANT SELECT ON ${BAD_SCHEMA}.* TO '${GUARD_USER}'@'127.0.0.1'; FLUSH PRIVILEGES;`)
  badSchemaCreated = true
  await refusalScenario(
    `refuses: schema ${BAD_SCHEMA} default charset = latin1`,
    `mysql://${GUARD_USER}:${VALID_DB_PASS}@127.0.0.1:${RELAY_PORT}/${BAD_SCHEMA}`,
    [BAD_SCHEMA, 'latin1', 'utf8mb4']
  )

  // ---------- 5. UNREACHABLE: 5 attempts, 3 s apart (owner addition 2) ----------
  mysql(`DROP DATABASE ${BAD_SCHEMA};`)
  badSchemaCreated = false
  {
    const dbUrl = `mysql://${GUARD_USER}:${VALID_DB_PASS}@127.0.0.1:${DEAD_PORT}/tcms_test`
    const r = await runOnce(NEXT_BIN, ['start', '-p', String(APP_PORT)], ROOT, { ...APP_VALID, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl })
    const ok =
      r.code === 1 &&
      r.elapsedMs >= 11_000 && // 4 retry gaps x 3 s = 12 s minimum (boot overhead on top)
      r.out.includes(`database unreachable (127.0.0.1:${DEAD_PORT})`) &&
      r.out.includes('5 attempts') &&
      leaks().length === 0
    console.log(`--- unreachable scenario (raw output) ---`)
    console.log(r.out.trim() || '(no output)')
    console.log(`--- end (${(r.elapsedMs / 1000).toFixed(1)}s elapsed) ---`)
    record(
      'refuses: database unreachable — 5 attempts, 3 s apart, host:port only',
      ok,
      ok ? 'exit 1 after >= 11 s, "database unreachable (127.0.0.1:5599)", never listened, no secrets'
         : `exit=${r.code} elapsed=${r.elapsedMs}ms`
    )
  }

  // ---------- 6. PASS: correct settings ----------
  {
    console.log(`--- PASS scenario: app on :${APP_PORT} with correct server settings (raw output) ---`)
    const child = spawnUp(NEXT_BIN, ['start', '-p', String(APP_PORT)], ROOT, APP_VALID)
    const health = await waitForHttp(`http://127.0.0.1:${APP_PORT}/api`, 60_000)
    const out = child.output
    const ok =
      health.ok &&
      health.body.includes('"status"') &&
      countLines(out, 'db-settings guard ACTIVE') === 1 &&
      out.includes('[TCMS] db-settings OK:') &&
      out.includes('time_zone=+00:00') &&
      out.includes('server_charset=utf8mb4') &&
      out.includes('schema_charset=utf8mb4') &&
      /transaction_isolation=\S+/.test(out) &&
      out.includes('production guard ACTIVE') &&
      leaks().length === 0
    console.log(out.trim() || '(no output)')
    console.log(`health: ${health.ok ? `HTTP ${health.status} ${health.body.trim().slice(0, 80)}` : `FAILED (${health.lastErr})`}`)
    console.log('--- end PASS scenario ---')
    await killChild(child)
    record(
      'passes: correct settings — app serves, db-settings OK line with transaction_isolation reported',
      ok,
      ok ? 'ACTIVE + OK line + /api 200 + transaction_isolation printed (not failed on)'
         : `health=${health.ok} lastErr=${health.lastErr}`
    )
  }

  // ---------- 7. SANDBOX OFF (no TCMS_DEPLOY_ENV) ----------
  {
    console.log(`--- SANDBOX scenario: app on :${APP_PORT} without the switch (raw output) ---`)
    const sandboxUrl = 'mysql://tcms_app:ChangeMe_local_only@127.0.0.1:5500/tcms_test'
    const child = spawnUp(NEXT_BIN, ['start', '-p', String(APP_PORT)], ROOT, {
      JWT_SECRET: VALID_JWT,
      WS_NOTIFY_SECRET: VALID_WS_SECRET,
      DATABASE_URL: sandboxUrl,
      TCMS_ENABLE_SEED: '',
    })
    const health = await waitForHttp(`http://127.0.0.1:${APP_PORT}/api`, 60_000)
    const out = child.output
    const ok =
      health.ok &&
      out.includes('[TCMS] db-settings guard OFF (sandbox mode)') &&
      out.includes('[TCMS] production guard OFF (sandbox mode)') &&
      !out.includes('db-settings OK') &&
      leaks().length === 0
    console.log(out.trim() || '(no output)')
    console.log(`health: ${health.ok ? `HTTP ${health.status}` : `FAILED (${health.lastErr})`}`)
    console.log('--- end SANDBOX scenario ---')
    await killChild(child)
    record(
      'sandbox unaffected: no TCMS_DEPLOY_ENV — both guards print OFF, app serves, zero DB probing',
      ok,
      ok ? 'OFF lines + /api 200' : `health=${health.ok}`
    )
  }
}

async function finallyCleanup() {
  console.log('\n=== finally-style cleanup (runs even after failures) ===')
  // Restore the captured originals, then PROVE the restore with a raw SELECT.
  try {
    mysql(`SET GLOBAL sql_mode = '${originals.sql_mode ?? ''}';`)
    mysql(`SET GLOBAL time_zone = '${originals.time_zone ?? '+00:00'}';`)
    mysql(`SET GLOBAL character_set_server = '${originals.character_set_server ?? 'utf8mb4'}';`)
    mysql(`SET GLOBAL collation_server = '${originals.collation_server ?? 'utf8mb4_0900_ai_ci'}';`)
  } catch (err) {
    console.log(`[cleanup] WARN: restore failed: ${err.message}`)
  }
  const now = mysql(
    `SELECT @@GLOBAL.sql_mode, @@GLOBAL.time_zone, @@GLOBAL.character_set_server, @@GLOBAL.collation_server;`
  ).trim()
  console.log(`[cleanup] globals now: ${now.replace(/\n/g, ' | ')}`)
  const restoredOk =
    now.includes(originals.sql_mode) &&
    now.includes(originals.time_zone) &&
    now.includes(originals.character_set_server)
  record('sandbox restored: sql_mode/time_zone/character_set_server back to captured originals (raw SELECT)', restoredOk)

  dropGuardUser()
  if (badSchemaCreated) {
    try { mysql(`DROP DATABASE ${BAD_SCHEMA};`) } catch (err) { console.log(`[cleanup] WARN: ${err.message}`) }
    badSchemaCreated = false
  }
  const userGone = mysql(`SELECT COUNT(*) FROM mysql.user WHERE user = '${GUARD_USER}';`).trim() === '0'
  const schemaGone = mysql(`SHOW DATABASES LIKE '${BAD_SCHEMA}';`).trim() === ''
  record('harness assets dropped: tcms_guard user + tcms_guard_bad schema proven gone (raw queries)', userGone && schemaGone)

  await stopRelay()
  const { execSync } = await import('node:child_process')
  const ssOut = execSync('ss -tln 2>/dev/null || true', { encoding: 'utf8' })
  const portsClear = [String(APP_PORT), String(RELAY_PORT)].every((p) => !ssOut.includes(`:${p} `))
  record(`harness ports released: :${APP_PORT} and :${RELAY_PORT} clear (ss)`, portsClear)

  const leakHit = leaks()
  record('no credential strings in ANY captured output (full run)', leakHit.length === 0, JSON.stringify(leakHit))
}

main()
  .catch((err) => {
    console.log(`[harness] FATAL: ${err.message}`)
    process.exitCode = 1
  })
  .finally(async () => {
    await finallyCleanup()
    const pass = results.filter((r) => r.ok).length
    const fail = results.length - pass
    console.log(`\n=== SUMMARY: PASS=${pass} FAIL=${fail} ===`)
    if (fail > 0) process.exitCode = 1
  })
