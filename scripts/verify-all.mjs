#!/usr/bin/env node
/**
 * npm run verify:all — the whole Definition of Done in one command.
 *
 * Runs, ONE AT A TIME (the suites share the tcms_verify DB lock and a headless Chrome):
 *   static  tsc --noEmit · eslint . · audit-standards
 *   suites  every verify suite against TCMS_BASE_URL (default http://localhost:3000)
 * Before each step it checks free memory (VERIFY_MIN_FREE_MB, default 2000) and skips the
 * step when memory is short (counted as a failure). Each suite has a time limit
 * (VERIFY_SUITE_TIMEOUT_MIN, default 40) so a hung browser can never block the run.
 * Raw output goes to <tmp>/tcms-verify-all/<stamp>/ (never into the repo).
 *
 * Usage:
 *   npm run verify:all                                   dev server on :3000
 *   TCMS_BASE_URL=http://localhost:3999 npm run verify:all   a production build
 *   npm run verify:all -- --only=verify-security,verify-import
 *   npm run verify:all -- --skip-static
 * Dev mode (detected from the page) sets PAGE_APIS_P95_MS=5000 unless it is set already.
 * Exit code 0 only when every step passed.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { freemem, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.TCMS_BASE_URL || 'http://localhost:3000'
const MIN_FREE_MB = Number(process.env.VERIFY_MIN_FREE_MB) || 2000
const SUITE_TIMEOUT_MS = (Number(process.env.VERIFY_SUITE_TIMEOUT_MIN) || 40) * 60_000
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const OUT_DIR = path.join(tmpdir(), 'tcms-verify-all', STAMP)

const STATIC_STEPS = [
  { name: 'tsc', cmd: 'npx tsc --noEmit' },
  { name: 'eslint', cmd: 'npx eslint .' },
  { name: 'audit-standards', cmd: 'node scripts/audit-standards.mjs' },
]

/** Every suite of the Definition of Done + the production-readiness and e2e suites. */
const SUITES = [
  'verify-security',
  'verify-numeric-ids',
  'verify-import',
  'verify-permissions',
  'verify-notifications',
  'verify-review-matrix',
  'verify-concurrency',
  'verify-db-errors',
  'verify-flagged-fields',
  'verify-safety',
  'create-first-vp-test',
  'verify-ui-gates',
  'verify-page-apis',
  'verify-role-flows-e2e',
  'verify-permission-toggle-e2e',
]

function parseFlags(argv) {
  const flags = {}
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg)
    if (m) flags[m[1]] = m[2] ?? true
  }
  return flags
}

/** "<n> passed, <m> failed" / "PASS=<n> FAIL=<m>" from a suite's output. */
function parseCounts(text) {
  const all = [...text.matchAll(/(\d+) passed, (\d+) failed|PASS=(\d+) FAIL=(\d+)/g)]
  const last = all[all.length - 1]
  if (!last) return null
  return { pass: Number(last[1] ?? last[3]), fail: Number(last[2] ?? last[4]) }
}

/** Runs one command; output to its log file; resolves { code, text, ms }. */
function run(step, env) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(step.cmd, { cwd: ROOT, env, shell: true, windowsHide: true })
    let text = ''
    child.stdout.on('data', (d) => { text += d })
    child.stderr.on('data', (d) => { text += d })
    const timer = setTimeout(() => {
      text += `\nVERIFY-ALL: time limit ${SUITE_TIMEOUT_MS / 60_000} min reached — stopped\n`
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      else child.kill('SIGKILL')
    }, SUITE_TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      writeFileSync(path.join(OUT_DIR, `${step.name}.txt`), text)
      resolve({ code: code ?? 1, text, ms: Date.now() - started })
    })
  })
}

async function serverMode() {
  try {
    const ready = await fetch(`${BASE}/api/ready`, { signal: AbortSignal.timeout(30_000) })
    if (ready.status !== 200) return null
    const html = await (await fetch(`${BASE}/login`, { signal: AbortSignal.timeout(60_000) })).text()
    return html.includes('next-devtools') ? 'development' : 'production'
  } catch {
    return null
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2))
  const only = typeof flags.only === 'string' ? flags.only.split(',').map((s) => s.trim()) : null
  mkdirSync(OUT_DIR, { recursive: true })
  const mode = await serverMode()
  if (!mode) {
    console.log(`VERIFY-ALL: ${BASE}/api/ready is not answering 200 — start the app first.`)
    process.exitCode = 1
    return
  }
  const env = { ...process.env, TCMS_BASE_URL: BASE }
  if (mode === 'development' && !env.PAGE_APIS_P95_MS) env.PAGE_APIS_P95_MS = '5000'
  console.log(`VERIFY-ALL against ${BASE} (${mode}) — logs in ${OUT_DIR}`)

  const steps = [
    ...(flags['skip-static'] || only ? [] : STATIC_STEPS.map((s) => ({ ...s, kind: 'static' }))),
    ...SUITES.filter((s) => !only || only.includes(s)).map((name) => ({ name, cmd: `node scripts/${name}.mjs`, kind: 'suite' })),
  ]
  const rows = []
  for (const step of steps) {
    const freeMb = Math.round(freemem() / 1024 / 1024)
    if (freeMb < MIN_FREE_MB) {
      rows.push({ name: step.name, result: `SKIPPED (free memory ${freeMb} MB < ${MIN_FREE_MB} MB)`, ok: false, min: 0 })
      console.log(`SKIP  ${step.name} — free memory ${freeMb} MB`)
      continue
    }
    process.stdout.write(`run   ${step.name} (free ${freeMb} MB) … `)
    const { code, text, ms } = await run(step, env)
    const counts = parseCounts(text)
    let ok = code === 0
    let result
    if (step.kind === 'static') {
      const errors = step.name === 'eslint' ? /(\d+) errors?/.exec(text)?.[1] ?? '0' : null
      result = code === 0 ? (errors !== null ? `0 errors` : 'OK') : `FAILED (exit ${code})`
      if (step.name === 'audit-standards') {
        const v = /(\d+) violations/.exec(text)?.[1]
        result = v !== undefined ? `${v} violations` : result
        ok = ok && v === '0'
      }
    } else {
      result = counts ? `${counts.pass} passed, ${counts.fail} failed` : `no result line (exit ${code})`
      ok = ok && Boolean(counts) && counts.fail === 0
    }
    rows.push({ name: step.name, result, ok, min: Math.round(ms / 6000) / 10 })
    console.log(`${ok ? 'ok' : 'FAIL'} — ${result} (${Math.round(ms / 1000)} s)`)
  }

  const width = Math.max(...rows.map((r) => r.name.length))
  console.log(`\n=== VERIFY-ALL RESULTS (${mode}, ${BASE}) ===`)
  for (const r of rows) console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.result}  (${r.min} min)`)
  const failed = rows.filter((r) => !r.ok).length
  console.log(`VERIFY-ALL: ${rows.length - failed} of ${rows.length} steps passed${failed ? ` — ${failed} FAILED` : ''}`)
  process.exitCode = failed ? 1 : 0
}

main()
