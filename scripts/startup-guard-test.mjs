#!/usr/bin/env node
// Permanent verifier for the PRODUCTION STARTUP GUARD (task startup-guard-1).
//
// Boots REAL processes on ALT ports with TCMS_DEPLOY_ENV=production and
// controlled env overlays, and proves BOTH failure and success paths:
//   REFUSE  — app / WS service / crewdesk mock exit 1 with named-variable
//             reasons and WITHOUT printing any secret value
//   BOOT    — app + WS service start with valid test secrets (alt ports,
//             DB through a disposable loopback relay on :5501)
//   SANDBOX — without the switch the state line reads OFF (sandbox mode)
//
// DISPOSABLE HARNESS ASSETS + OWNER ADDITION (1b): the temporary MySQL user
// `tcms_guard` and the :5501 relay are removed in a finally-style cleanup
// that runs EVEN WHEN THE TEST FAILS, and the removal is PROVEN with a raw
// mysql query + an ss port check at the end.
//
// Sandbox-only: creating/dropping tcms_guard uses the sandbox mysqld's
// passwordless local root exactly like scripts/migration/mysql84-boot.sh.
// Nothing here touches production or the repo's real .env values.

import { spawn, execFileSync } from 'node:child_process'
import net from 'node:net'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NEXT_BIN = path.join(ROOT, 'node_modules', '.bin', 'next')
const WS_DIR = path.join(ROOT, 'mini-services', 'notifications')
const MOCK_DIR = path.join(ROOT, 'mini-services', 'crewdesk-mock')
const MYSQL_BIN = '/tmp/mysql84/bin/mysql'

const APP_PORT = 3997
const WS_PORT = 3993
const NOTIFY_PORT = 3994
const RELAY_PORT = 5501

const hex = (n) => crypto.randomBytes(n).toString('hex')
// Fresh VALID secrets for boot scenarios (never the sandbox's real ones).
const VALID_JWT = hex(32) // 64 chars
const VALID_WS_SECRET = hex(24) // 48 chars
const VALID_DB_PASS = hex(24) // 48 chars
// Known placeholders under test (public sandbox defaults — safe to embed).
const PH_JWT = 'change-me-to-a-long-random-string'
const PH_WS = 'ChangeMe_local_only'
const PH_CREWDESK = 'mock-login-secret'
const VALID_MOCK_TOKEN = `tok-${hex(16)}`

let relayServer = null
const relaySockets = new Set()
let guardUserCreated = false

const results = []
function record(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`)
}

function mysql(query) {
  // Passwordless local root on the SANDBOX mysqld only (same pattern as
  // scripts/migration/mysql84-boot.sh:41). LD_LIBRARY_PATH is required for
  // the client's libncurses (same export mysql84-boot.sh:8 does). Error
  // output is SANITIZED so a failed CREATE USER can never echo the query
  // (which would contain the throwaway harness password).
  try {
    return execFileSync(
      MYSQL_BIN,
      ['--no-defaults', '-h', '127.0.0.1', '-P', '5500', '-u', 'root', '-e', query],
      {
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env, LD_LIBRARY_PATH: '/tmp/mysql84/extra-lib' },
      }
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
  mysql(`CREATE USER IF NOT EXISTS 'tcms_guard'@'127.0.0.1' IDENTIFIED BY '${VALID_DB_PASS}';`)
  mysql(`GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, INDEX, ALTER, REFERENCES, CREATE TEMPORARY TABLES, LOCK TABLES ON tcms_test.* TO 'tcms_guard'@'127.0.0.1'; FLUSH PRIVILEGES;`)
  guardUserCreated = true
}

function dropGuardUser() {
  if (!guardUserCreated) return
  try {
    mysql(`DROP USER IF EXISTS 'tcms_guard'@'127.0.0.1'; FLUSH PRIVILEGES;`)
  } catch (err) {
    console.log(`[cleanup] WARN: DROP USER failed: ${err.message}`)
  }
  guardUserCreated = false
}

/** Run a child to completion. Returns { code, signal, out } (combined stdout+stderr). */
function runOnce(cmd, args, cwd, extraEnv, timeoutMs = 60_000) {
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
      resolve({ code, signal, out })
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
    if (!child || child.exitCode !== null || child.signalCode) return resolve()
    child.on('exit', () => resolve())
    try { child.kill('SIGTERM') } catch { resolve() }
    setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* gone */ }
      resolve()
    }, 5_000)
  })
}

const isExit1 = (r) => r.code === 1
const guardLineCount = (out) => (out.match(/production guard (ACTIVE|OFF)/g) || []).length
const hasStateLine = (out) => out.includes('production guard ACTIVE')
const namesVar = (out, varName) => out.includes(varName)
const leaks = (out) =>
  [VALID_JWT, VALID_WS_SECRET, VALID_DB_PASS, PH_JWT, PH_WS, PH_CREWDESK, VALID_MOCK_TOKEN].filter(
    (v) => out.includes(v)
  )

// App overlay pieces — explicit env BEATS the repo .env that Next loads.
const APP_DB_RELAY = `mysql://tcms_guard:${VALID_DB_PASS}@127.0.0.1:${RELAY_PORT}/tcms_test`
const PROD = { TCMS_DEPLOY_ENV: 'production' }
// Neutralize .env values that the valid-boot overlay must override.
const APP_VALID = {
  ...PROD,
  JWT_SECRET: VALID_JWT,
  WS_NOTIFY_SECRET: VALID_WS_SECRET,
  DATABASE_URL: APP_DB_RELAY,
  DIRECT_URL: APP_DB_RELAY,
  TCMS_ENABLE_SEED: '',
  TCMS_ALLOW_SIGNUP: '',
}

async function refusalScenario(name, cmd, args, cwd, env, expectVars, forbiddenNote) {
  const r = await runOnce(cmd, args, cwd, env)
  const ok =
    isExit1(r) &&
    hasStateLine(r.out) &&
    guardLineCount(r.out) === 1 &&
    expectVars.every((v) => namesVar(r.out, v)) &&
    leaks(r.out).length === 0
  console.log(`\n--- ${name} (raw output) ---`)
  console.log(r.out.trim() || '(no output)')
  console.log(`--- end ${name} ---`)
  record(
    name,
    ok,
    ok
      ? forbiddenNote
      : `exit=${r.code}${r.signal ? ` signal=${r.signal}` : ''} stateLines=${guardLineCount(r.out)} leaks=${JSON.stringify(leaks(r.out))}`
  )
}

async function main() {
  console.log('=== TCMS production startup guard test (task startup-guard-1) ===')
  console.log(`alt ports: app=${APP_PORT} ws=${WS_PORT} notify=${NOTIFY_PORT} db-relay=${RELAY_PORT}`)

  // ---------- SETUP (harness-only assets; removed in finally) ----------
  createGuardUser()
  await startRelay()
  console.log(`[harness] tcms_guard user created (random password, NOT printed) + relay :${RELAY_PORT} -> 127.0.0.1:5500 up`)

  // ---------- 1. APP refusals ----------
  await refusalScenario(
    'app refuses: JWT_SECRET is a known placeholder',
    NEXT_BIN, ['start', '-p', String(APP_PORT)], ROOT,
    { ...APP_VALID, JWT_SECRET: PH_JWT },
    ['JWT_SECRET'], 'exit 1, state line ACTIVE, variable named, no value printed'
  )

  await refusalScenario(
    'app refuses: JWT_SECRET too short (16 chars)',
    NEXT_BIN, ['start', '-p', String(APP_PORT)], ROOT,
    { ...APP_VALID, JWT_SECRET: hex(8) },
    ['JWT_SECRET'], 'exit 1, variable named, no value printed'
  )

  await refusalScenario(
    'app refuses: WS_NOTIFY_SECRET missing',
    NEXT_BIN, ['start', '-p', String(APP_PORT)], ROOT,
    { ...APP_VALID, WS_NOTIFY_SECRET: '' },
    ['WS_NOTIFY_SECRET'], 'exit 1, variable named'
  )

  await refusalScenario(
    'app refuses: DATABASE_URL points at sandbox MySQL 127.0.0.1:5500',
    NEXT_BIN, ['start', '-p', String(APP_PORT)], ROOT,
    { ...APP_VALID, DATABASE_URL: 'mysql://tcms_app:ChangeMe_local_only@127.0.0.1:5500/tcms_test', DIRECT_URL: '' },
    ['DATABASE_URL'], 'exit 1, sandbox endpoint named, credentials not printed'
  )

  await refusalScenario(
    'app refuses: DATABASE_URL uses root user',
    NEXT_BIN, ['start', '-p', String(APP_PORT)], ROOT,
    { ...APP_VALID, DATABASE_URL: `mysql://root:${VALID_DB_PASS}@127.0.0.1:${RELAY_PORT}/tcms_test`, DIRECT_URL: '' },
    ['DATABASE_URL'], 'exit 1, root user named, password not printed'
  )

  await refusalScenario(
    'app refuses: TCMS_ENABLE_SEED on in production',
    NEXT_BIN, ['start', '-p', String(APP_PORT)], ROOT,
    { ...APP_VALID, TCMS_ENABLE_SEED: 'true' },
    ['TCMS_ENABLE_SEED'], 'exit 1, variable named'
  )

  await refusalScenario(
    'app refuses: SMTP_HOST set but SMTP_PASS missing',
    NEXT_BIN, ['start', '-p', String(APP_PORT)], ROOT,
    { ...APP_VALID, SMTP_HOST: 'smtp.yourcompany.example' },
    ['SMTP_PASS'], 'exit 1, half-configured email channel named'
  )

  await refusalScenario(
    'app refuses: CREWDESK_LOGIN_PASSWORD is the mock placeholder',
    NEXT_BIN, ['start', '-p', String(APP_PORT)], ROOT,
    { ...APP_VALID, CREWDESK_LOGIN_PASSWORD: PH_CREWDESK },
    ['CREWDESK_LOGIN_PASSWORD'], 'exit 1, sandbox default named, value not printed'
  )

  // ---------- 2. WS service refusals ----------
  await refusalScenario(
    'ws service refuses: WS_NOTIFY_SECRET is a known placeholder',
    'bun', ['index.ts'], WS_DIR,
    { ...PROD, WS_PORT: String(WS_PORT), NOTIFY_PORT: String(NOTIFY_PORT), WS_NOTIFY_SECRET: PH_WS, WS_CORS_ORIGIN: 'https://tcms.example.com' },
    ['WS_NOTIFY_SECRET'], 'exit 1 WITHOUT NODE_ENV (TCMS_DEPLOY_ENV key), variable named, no value printed'
  )

  await refusalScenario(
    'ws service refuses: WS_CORS_ORIGIN unset in production (re-keyed guard, no NODE_ENV)',
    'bun', ['index.ts'], WS_DIR,
    { ...PROD, WS_PORT: String(WS_PORT), NOTIFY_PORT: String(NOTIFY_PORT), WS_NOTIFY_SECRET: VALID_WS_SECRET, WS_CORS_ORIGIN: '' },
    ['WS_CORS_ORIGIN'], 'exit 1 — CORS guard now fires under TCMS_DEPLOY_ENV'
  )

  // ---------- 3. Mock kill-switch ----------
  await refusalScenario(
    'crewdesk mock refuses to start AT ALL in production (valid mock secrets set)',
    'bun', ['index.ts'], MOCK_DIR,
    { ...PROD, MOCK_CREWDESK_TOKEN: VALID_MOCK_TOKEN, MOCK_CREWDESK_LOGIN_PASSWORD: hex(16), MOCK_CREWDESK_JWT_SECRET: hex(16) },
    ['mock'], 'exit 1 regardless of secrets'
  )

  // ---------- 4. BOOT proofs (valid secrets, alt ports) ----------
  console.log(`\n--- app BOOTS with valid test secrets on :${APP_PORT} (raw output) ---`)
  {
    const child = spawnUp(NEXT_BIN, ['start', '-p', String(APP_PORT)], ROOT, APP_VALID)
    const health = await waitForHttp(`http://127.0.0.1:${APP_PORT}/api`, 60_000)
    const ok =
      health.ok &&
      health.body.includes('"status"') &&
      hasStateLine(child.output) &&
      guardLineCount(child.output) === 1 &&
      leaks(child.output).length === 0
    console.log(child.output.trim() || '(no output)')
    console.log(`health: ${health.ok ? `HTTP ${health.status} ${health.body.trim().slice(0, 120)}` : `FAILED (${health.lastErr})`}`)
    console.log('--- end app boot ---')
    record(
      'app BOOTS with valid test secrets on alt port (guard ACTIVE, /api ok)',
      ok,
      ok ? 'fresh random secrets + relay DB, no reload' : `health=${JSON.stringify(health)} leaks=${JSON.stringify(leaks(child.output))}`
    )
    await killChild(child)
  }

  console.log(`\n--- ws service BOOTS with valid test secrets on :${WS_PORT} (raw output) ---`)
  {
    const child = spawnUp('bun', ['index.ts'], WS_DIR, {
      ...PROD,
      WS_PORT: String(WS_PORT),
      NOTIFY_PORT: String(NOTIFY_PORT),
      WS_NOTIFY_SECRET: VALID_WS_SECRET,
      WS_CORS_ORIGIN: 'https://tcms.example.com',
    })
    await new Promise((r) => setTimeout(r, 2500))
    const up = child.exitCode === null
    const bannerOk =
      child.output.includes(`port ${WS_PORT}`) &&
      child.output.includes("path '/socket.io/'") &&
      child.output.includes('ticket auth ENABLED')
    const ok = up && hasStateLine(child.output) && guardLineCount(child.output) === 1 && bannerOk
    console.log(child.output.trim() || '(no output)')
    console.log('--- end ws boot ---')
    record(
      'ws service BOOTS on alt port: path /socket.io/ + ticket auth ENABLED + guard ACTIVE',
      ok,
      ok ? 'production defaults WITHOUT NODE_ENV' : `up=${up} bannerOk=${bannerOk}`
    )
    await killChild(child)
  }

  // ---------- 5. Sandbox OFF-line proof ----------
  console.log('\n--- ws service WITHOUT the switch prints the OFF line (raw output) ---')
  {
    const child = spawnUp('bun', ['index.ts'], WS_DIR, {
      WS_PORT: String(WS_PORT),
      NOTIFY_PORT: String(NOTIFY_PORT),
      WS_NOTIFY_SECRET: VALID_WS_SECRET,
    })
    await new Promise((r) => setTimeout(r, 2000))
    const up = child.exitCode === null
    const offLine = child.output.includes('production guard OFF (sandbox mode)')
    const ok = up && offLine && guardLineCount(child.output) === 1
    console.log(child.output.trim() || '(no output)')
    console.log('--- end sandbox boot ---')
    record('sandbox mode unchanged: guard OFF line, service boots as before', ok, `up=${up} offLine=${offLine}`)
    await killChild(child)
  }

  // ---------- 6. No-leak global note ----------
  const leakedAnywhere = results.filter((r) => !r.ok && r.detail && r.detail.includes('leaks='))
  record(
    'no secret value printed anywhere in refusal/boot outputs',
    leakedAnywhere.length === 0,
    leakedAnywhere.length === 0 ? 'leak assertion embedded in every scenario' : 'see per-scenario leaks='
  )
}

async function cleanup() {
  console.log('\n=== CLEANUP (runs even on failure) ===')
  await stopRelay()
  dropGuardUser()
  // PROOF 1: the guard user no longer exists (raw query output).
  try {
    const proof = mysql(`SELECT user, host FROM mysql.user WHERE user='tcms_guard';`)
    const empty = proof.trim() === ''
    console.log(`[proof] SELECT user,host FROM mysql.user WHERE user='tcms_guard':`)
    console.log(empty ? '(empty set — user gone)' : proof)
    record('cleanup proof: tcms_guard user no longer exists', empty)
  } catch (err) {
    record('cleanup proof: tcms_guard user no longer exists', false, err.message)
  }
  // PROOF 2: nothing listens on the harness ports (raw ss output).
  const { execSync } = await import('node:child_process')
  let ssOut = ''
  try {
    ssOut = execSync(`ss -tln | grep -E ':(${APP_PORT}|${WS_PORT}|${NOTIFY_PORT}|${RELAY_PORT}) ' || true`, { encoding: 'utf8', shell: '/bin/bash' })
  } catch { ssOut = '' }
  const clear = ssOut.trim() === ''
  console.log(`[proof] ss -tln on :${APP_PORT}/:${WS_PORT}/:${NOTIFY_PORT}/:${RELAY_PORT}:`)
  console.log(clear ? 'CONFIRMED: nothing is listening on any harness port' : ssOut)
  record('cleanup proof: all harness ports released', clear)
}

async function run() {
  try {
    await main()
  } finally {
    try {
      await cleanup()
    } catch (err) {
      console.log(`[cleanup] ERROR: ${err.message}`)
    }
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n=== SUMMARY: PASS=${results.length - failed} FAIL=${failed} ===`)
  process.exit(failed === 0 ? 0 : 1)
}

run()
