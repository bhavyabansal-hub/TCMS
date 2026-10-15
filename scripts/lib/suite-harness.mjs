// Shared harness for the REQ-001 writing suites (verify-wiki, verify-permission-matrix):
// PASS/FAIL counter, VERIFY_FAIL_AT / VERIFY_PAUSE_AT hooks, SIGINT -> abort + cleanup,
// cookie-session HTTP helpers, manifest file, 126-cell matrix snapshot compare.
// Exit codes (05-test-plan.md A0): 0 green, 1 any FAIL, 2 NOT RUN, 130 Ctrl+C.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const BASE = process.env.TCMS_BASE_URL || 'http://localhost:3000'
export const PERMISSION_CACHE_WAIT_MS = 3_500 // outlives the 3 s permission cache (permissions.ts:70)
const PAUSE_MS = 20_000

/** Thrown by a VERIFY_FAIL_AT hook; counted as one FAIL `forced failure at <step>`. */
export class ForcedFailure extends Error {
  constructor(step) {
    super(`forced failure at ${step}`)
    this.name = 'ForcedFailure'
  }
}

/** Creates the PASS/FAIL counter. `ok`/`check` print one line per executed check. */
export function createCounter() {
  const counter = { pass: 0, fail: 0 }
  counter.check = (name, cond, detail = '') => {
    if (cond) {
      counter.pass++
      console.log(`  ok  ${name}`)
    } else {
      counter.fail++
      console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`)
    }
    return !!cond
  }
  return counter
}

/**
 * Reads VERIFY_FAIL_AT / VERIFY_PAUSE_AT and validates them against the suite's steps.
 * @returns {{ ok: boolean, failAt: string|null, pauseAt: string|null, message?: string }}
 */
export function readHooks(allowedSteps) {
  const failAt = process.env.VERIFY_FAIL_AT || null
  const pauseAt = process.env.VERIFY_PAUSE_AT || null
  for (const [name, value] of [['VERIFY_FAIL_AT', failAt], ['VERIFY_PAUSE_AT', pauseAt]]) {
    if (value && !allowedSteps.includes(value)) {
      return { ok: false, failAt, pauseAt, message: `${name}=${value} is not a known step (${allowedSteps.join(', ')})` }
    }
  }
  return { ok: true, failAt, pauseAt }
}

/**
 * Run state: abort signal for main-flow requests, SIGINT handling, hook firing.
 * The SIGINT handler aborts the in-flight main request; the suite's finally runs
 * cleanup (cleanup requests use no signal). A second Ctrl+C during cleanup is ignored.
 */
export function createRunState(hooks) {
  const controller = new AbortController()
  const state = {
    interrupted: false,
    cleaning: false,
    signal: controller.signal,
    hooks,
  }
  state.onSigint = () => {
    if (state.cleaning) {
      console.log('cleanup in progress')
      return
    }
    if (state.interrupted) return
    state.interrupted = true
    console.log('INTERRUPTED (SIGINT)')
    controller.abort()
  }
  process.on('SIGINT', state.onSigint)
  /** Fires the test-only hooks for `step` (pause first, then the forced throw). */
  state.hook = async (step) => {
    if (hooks.pauseAt === step) {
      console.log(`PAUSED ${step}`)
      await sleep(PAUSE_MS, state.signal)
    }
    if (hooks.failAt === step) throw new ForcedFailure(step)
  }
  return state
}

/** Abortable sleep. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'))
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason ?? new Error('aborted'))
      },
      { once: true }
    )
  })
}

/** Final exit code from the run state and counter (process.exitCode only, never process.exit). */
export function resolveExitCode(state, counter) {
  if (state.interrupted) return 130
  return counter.fail > 0 ? 1 : 0
}

// ---------- HTTP (cookie session, CSRF marker on every call) ----------

/** JSON request; returns { status, json }. `signal` aborts main-flow calls on Ctrl+C. */
export async function requestJson(method, urlPath, { jar, body, signal } = {}) {
  const headers = { 'X-Requested-With': 'tcms', Origin: BASE }
  if (jar) headers.Cookie = jar
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text.slice(0, 120) }
  }
  return { status: res.status, json, setCookie: res.headers.getSetCookie?.() ?? [] }
}

/** Cookie jar string (`name=value; name2=value2`) from Set-Cookie headers. */
export function jarFromSetCookie(setCookie) {
  return setCookie.map((c) => c.split(';')[0]).join('; ')
}

/** Logs a fixture in; the error names the role only (never the password). */
export async function loginFixture(user, signal) {
  const res = await requestJson('POST', '/api/auth?path=login', {
    body: { email: user.email, password: user.password },
    signal,
  })
  if (res.status !== 200) throw new Error(`login failed for fixture role ${user.role} (${res.status})`)
  const jar = jarFromSetCookie(res.setCookie)
  if (!jar.includes('tcms-access=')) throw new Error(`login for fixture role ${user.role} set no tcms-access cookie`)
  return { jar, user: res.json.user, permissions: res.json.permissions }
}

// ---------- manifest (ids only, no secrets) ----------

export function manifestPath(suite, stamp) {
  return path.join(tmpdir(), 'tcms-verify', `${suite}-${stamp}.json`)
}

export function writeManifest(file, data) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2))
}

export function readManifest(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

// ---------- permission matrix snapshot (GET /api/permissions, never the PUT response, C1) ----------

/** Map `role:action` -> `enabled|source` from GET /api/permissions, or null when unreadable. */
export async function readMatrixSnapshot(jar, signal) {
  const res = await requestJson('GET', '/api/permissions', { jar, signal })
  if (res.status !== 200 || !Array.isArray(res.json)) return null
  const snapshot = new Map()
  for (const cell of res.json) snapshot.set(`${cell.role}:${cell.action}`, `${cell.enabled}|${cell.source}`)
  return snapshot
}

/** Cells whose value differs between two snapshots, limited to `keys` or excluding them. */
export function diffMatrix(before, after, { only = null, except = [] } = {}) {
  const keys = new Set([...before.keys(), ...after.keys()])
  const changed = []
  for (const key of keys) {
    if (only && !only.includes(key)) continue
    if (!only && except.includes(key)) continue
    if (before.get(key) !== after.get(key)) changed.push(`${key} ${before.get(key)} -> ${after.get(key)}`)
  }
  return changed
}

/**
 * Runs one cleanup step as one counted check. A failing step never stops the later ones.
 * `fn` returns { ok: boolean, detail: string }; a throw counts as FAIL with its message.
 */
export async function runCleanupStep(counter, name, fn) {
  try {
    const { ok, detail } = await fn()
    if (ok) console.log(`      ${name}: ${detail}`)
    return counter.check(`cleanup: ${name}`, ok, detail)
  } catch (err) {
    return counter.check(`cleanup: ${name}`, false, err.message)
  }
}

/** Prints and counts one residue check per table (`residue: <table>=0`). */
export function checkResidue(counter, residue) {
  for (const [table, pks] of Object.entries(residue)) {
    counter.check(`residue: ${table}=0`, pks.length === 0, `${table}=${pks.length} ${pks.slice(0, 5).join(',')}`)
  }
}

/** Parses `--name=value` CLI flags into an object. */
export function parseFlags(argv) {
  const flags = {}
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg)
    if (m) flags[m[1]] = m[2] ?? true
  }
  return flags
}
