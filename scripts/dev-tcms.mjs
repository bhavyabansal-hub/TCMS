// Sandbox/dev boot wrapper for TCMS (MySQL-only).
// Replaces the old dev-with-pg.mjs: TCMS runs on MySQL 8.4 exclusively —
// this wrapper NEVER boots any PostgreSQL process.
//
// What it does:
//   1. ENV SANITIZATION — some shells inject a stale non-mysql DATABASE_URL
//      (e.g. a sqlite file: URL) which would override .env and crash Prisma.
//      If DATABASE_URL/DIRECT_URL are not mysql:// URLs, they are replaced
//      from .env. If .env has no mysql URL either, this fails fast with a
//      clear message (no silent PostgreSQL fallback — MySQL-only by rule).
//   2. If DATABASE_URL points at the local sandbox MySQL (127.0.0.1:5500 or
//      localhost:5500) and the port is down, boot it via
//      scripts/migration/mysql84-boot.sh (idempotent, TEST schema only,
//      limited tcms_app user). Any other host (e.g. IT's server) is a
//      pass-through — we never try to boot someone else's database.
//   3. Starts `next dev -p 3000` and warms routes in the background so the
//      first click on a sidebar section never pays the dev compile cost.
//
// This file is a sandbox helper; it is NOT part of the shipped package.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MYSQL_PORT = 5500
const MYSQL_BOOT = `${ROOT}scripts/migration/mysql84-boot.sh`

function readEnvFile() {
  try {
    const raw = fs.readFileSync(`${ROOT}.env`, 'utf8')
    const map = {}
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m) map[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
    return map
  } catch {
    return {}
  }
}

function isPortOpen(port, host = 'localhost', timeout = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })
    const done = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeout)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

function waitForPort(port, timeoutMs = 90000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await isPortOpen(port)) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error(`port ${port} not ready in ${timeoutMs}ms`))
      setTimeout(tick, 500)
    }
    tick()
  })
}

function logToFile(...lines) {
  try {
    fs.appendFileSync(`${ROOT}dev.log`, lines.join(' ') + '\n')
  } catch {}
}

async function main() {
  const envFile = readEnvFile()
  const env = { ...process.env }

  // ENV SANITIZATION (MySQL-only): reject/replace any non-mysql DATABASE_URL.
  const isMysqlUrl = (u) => /^mysql:\/\//.test(u ?? '')
  let dbUrl = env.DATABASE_URL || envFile.DATABASE_URL || ''
  if (!isMysqlUrl(dbUrl)) dbUrl = isMysqlUrl(envFile.DATABASE_URL) ? envFile.DATABASE_URL : ''
  if (!dbUrl) {
    console.error('[dev-tcms] no mysql:// DATABASE_URL in env or .env — TCMS is MySQL-only; refusing to start on a non-mysql URL.')
    process.exit(1)
  }
  env.DATABASE_URL = dbUrl
  if (!isMysqlUrl(env.DIRECT_URL)) {
    env.DIRECT_URL = isMysqlUrl(envFile.DIRECT_URL) ? envFile.DIRECT_URL : dbUrl
  }
  if (!env.JWT_SECRET && envFile.JWT_SECRET) env.JWT_SECRET = envFile.JWT_SECRET

  const isSandboxMysql = /@(127\.0\.0\.1|localhost):5500/.test(dbUrl)
  if (isSandboxMysql && !(await isPortOpen(MYSQL_PORT))) {
    logToFile(`[dev-tcms] booting sandbox MySQL 8.4 on :${MYSQL_PORT}`)
    const boot = spawn('bash', [MYSQL_BOOT], {
      cwd: ROOT,
      env: { ...env, LD_LIBRARY_PATH: '/tmp/mysql84/extra-lib' },
      stdio: 'ignore',
      detached: false,
    })
    boot.unref()
    await waitForPort(MYSQL_PORT)
    logToFile('[dev-tcms] sandbox MySQL is ready')
  }

  const child = spawn('npx', ['next', 'dev', '-p', '3000'], {
    cwd: ROOT,
    env,
    shell: process.platform === 'win32',
    stdio: ['inherit', 'pipe', 'pipe'],
  })
  const forward = (stream, pipeTo) => (chunk) => {
    pipeTo.write(chunk)
    logToFile(...chunk.toString().split('\n').filter(Boolean))
  }
  child.stdout.on('data', forward(child.stdout, process.stdout))
  child.stderr.on('data', forward(child.stderr, process.stderr))
  child.on('exit', (code) => process.exit(code ?? 0))

  const warmer = spawn('node', [`${ROOT}scripts/warm-routes.mjs`], {
    cwd: ROOT,
    env,
    stdio: 'ignore',
    detached: true,
  })
  warmer.unref()
}

main().catch((err) => {
  console.error('[dev-tcms] failed:', err)
  process.exit(1)
})
