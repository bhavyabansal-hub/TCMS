#!/usr/bin/env node
// verify-page-apis.mjs — per-page API audit with headless Chrome (read-only).
//
// For every page route under src/app/(app) and every role it opens the page in a fresh
// browser context, records each /api call the page makes on load, then checks:
//   1. no duplicate call (same method + URL twice in one page load),
//   2. no call that answers 401/403 (the page must check the permission first),
//   3. parallel loading: the "waterfall depth" (calls that could only start after an
//      earlier call finished) stays <= MAX_DEPTH,
//   0. the page is healthy: no browser console error, no uncaught exception, no Next.js
//      error overlay, no "Something went wrong" boundary, and <main> shows content,
//   4. speed: every distinct GET the pages call is re-run SAMPLES times with the role's
//      session; its p95 must stay under P95_LIMIT_MS (local, demo data).
// Writes nothing except the normal login rows (refresh token + LOGIN activity).
//
// Usage: node scripts/verify-page-apis.mjs            (all roles)
//        PAGE_APIS_ROLES=vp,viewer node scripts/verify-page-apis.mjs
// Env: TCMS_BASE_URL (default http://localhost:3000), PAGE_APIS_SAMPLES (20),
//      PAGE_APIS_P95_MS (300), PAGE_APIS_MAX_DEPTH (2), CHROME_PATH.
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Cdp, RolePage, launchChrome, shutdownChrome, parseSetCookie } from './lib/cdp-browser.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.TCMS_BASE_URL || 'http://localhost:3000'
const SAMPLES = Number(process.env.PAGE_APIS_SAMPLES || 20)
const P95_LIMIT_MS = Number(process.env.PAGE_APIS_P95_MS || 300)
const MAX_DEPTH = Number(process.env.PAGE_APIS_MAX_DEPTH || 2)
const IDLE_MS = 1_500
// Every /api request is held this long before it is sent while a page loads, so calls that
// really wait for another response stay sequential and independent ones overlap — with
// 5 ms responses a later component mount would otherwise look like a waterfall.
const API_DELAY_MS = Number(process.env.PAGE_APIS_API_DELAY_MS ?? 300)
// A loaded page shows at least this much text in <main> (skeletons only = empty page).
const MIN_MAIN_CHARS = 20
const LOAD_TIMEOUT_MS = 60_000
const ALL_ROLES = ['vp', 'manager', 'product', 'developer', 'qa_engineer', 'viewer']
const ROLES = (process.env.PAGE_APIS_ROLES || ALL_ROLES.join(',')).split(',')
const PAGE_FILTER = process.env.PAGE_APIS_PAGES ? process.env.PAGE_APIS_PAGES.split(',') : null // e.g. /dashboard,/reports
const PROFILE_DIR = path.join(tmpdir(), `tcms-page-apis-${Date.now()}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) pass++
  else { fail++; failures.push(`${name}${detail ? `  (${detail})` : ''}`); console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`) }
}

// ---------- accounts (seed.service.ts is the single source; passwords never printed) ----------
function readDemoAccounts() {
  const src = readFileSync(path.join(ROOT, 'src', 'app', 'api', 'seed', 'seed.service.ts'), 'utf8')
  const re = /email: '([^']+)'[^}]*?hashPassword\('([^']+)'\)[^}]*?role: '([^']+)'/g
  const byEmail = {}
  for (const m of src.matchAll(re)) byEmail[m[1]] = { email: m[1], password: m[2], role: m[3] }
  const pick = { vp: 'admin@tcms.com', manager: 'teamlead@tcms.com', product: 'product@tcms.com', developer: 'developer@tcms.com', qa_engineer: 'qa1@tcms.com', viewer: 'viewer@tcms.com' }
  return Object.fromEntries(ALL_ROLES.map((r) => [r, byEmail[pick[r]]]))
}

async function login(account) {
  const res = await fetch(`${BASE}/api/auth?path=login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms' },
    body: JSON.stringify({ email: account.email, password: account.password }),
  })
  if (res.status !== 200) throw new Error(`login failed for role ${account.role} (${res.status})`)
  const cookies = (res.headers.getSetCookie?.() ?? []).map(parseSetCookie)
  const { user } = await res.json()
  return { cookies, user }
}
const jarOf = (cookies) => cookies.map((c) => `${c.name}=${c.value}`).join('; ')

async function apiGet(session, url) {
  const res = await fetch(`${BASE}${url}`, { headers: { cookie: jarOf(session.cookies), 'X-Requested-With': 'tcms' } })
  return { status: res.status, json: await res.json().catch(() => null) }
}

// ---------- page list (dynamic ids picked from existing rows, read-only) ----------
const firstId = (rows, key) => (Array.isArray(rows) ? rows : rows?.data ?? [])[0]?.[key]
async function buildPages(vp) {
  const modules = (await apiGet(vp, '/api/modules')).json
  const moduleId = modules?.flat?.[0]?.moduleId
  const testCaseId = firstId((await apiGet(vp, '/api/test-cases?pageSize=1')).json, 'testCaseId')
  const reviewId = firstId((await apiGet(vp, '/api/reviews?pageSize=1')).json, 'reviewRequestId')
  const moduleReviewId = firstId((await apiGet(vp, '/api/module-reviews?action=all')).json, 'moduleReviewRequestId')
  const wikiId = firstId((await apiGet(vp, '/api/wiki')).json, 'wikiDocumentId')
  const pages = [
    '/dashboard', '/modules', '/test-cases', '/reviews', '/bugs', '/tasks', '/reports', '/wiki',
    '/activity-log', '/integrations', '/notifications', '/settings/profile', '/settings/users', '/settings/permissions',
  ].map((p) => ({ label: p, url: p }))
  if (moduleId) pages.push({ label: '/modules/[id]', url: `/modules/${moduleId}` })
  if (testCaseId) pages.push({ label: '/test-cases/[id]', url: `/test-cases/${testCaseId}` })
  if (reviewId) pages.push({ label: '/reviews/[id]', url: `/reviews/${reviewId}` })
  if (moduleReviewId) pages.push({ label: '/module-reviews/[id]', url: `/module-reviews/${moduleReviewId}` })
  if (wikiId) pages.push({ label: '/wiki/[id]', url: `/wiki/${wikiId}` })
  return PAGE_FILTER ? pages.filter((p) => PAGE_FILTER.includes(p.label)) : pages
}

// ---------- one page load ----------
const isApi = (r) => { try { return new URL(r.url).pathname.startsWith('/api') } catch { return false } }
const keyOf = (r) => { const u = new URL(r.url); return `${r.method} ${u.pathname}${u.search}` }

async function loadPage(page, url) {
  const mark = await page.goto(url)
  const start = Date.now()
  let lastActivity = Date.now()
  let seen = 0
  while (Date.now() - start < LOAD_TIMEOUT_MS) {
    await sleep(250)
    const reqs = page.since(mark).filter(isApi)
    const pending = reqs.filter((r) => r.t1 === null).length
    if (reqs.length !== seen || pending > 0) { seen = reqs.length; lastActivity = Date.now() }
    // idle = the boot session check (GET /api/auth) has finished, and no new /api request
    // and none pending for IDLE_MS — so a slow first compile is never cut short.
    const booted = reqs.some((r) => r.t1 !== null && new URL(r.url).pathname === '/api/auth' && r.method === 'GET')
    if (booted && Date.now() - lastActivity >= IDLE_MS) break
  }
  return page.since(mark).filter(isApi).filter((r) => !r.url.includes('/api/auth?path=ws-ticket'))
}

/** Longest chain of calls where each one started only after the previous finished. */
function waterfallDepth(reqs) {
  const done = reqs.filter((r) => r.t1 !== null).sort((a, b) => a.t0 - b.t0)
  const depth = new Map()
  let max = 0
  for (const r of done) {
    let d = 1
    for (const p of done) if (p !== r && p.t1 <= r.t0) d = Math.max(d, (depth.get(p) ?? 1) + 1)
    depth.set(r, d)
    max = Math.max(max, d)
  }
  return max
}

/** Delays every /api request of this page by API_DELAY_MS (CDP Fetch interception). */
/** Collects uncaught exceptions, console.error calls and browser log errors of this page. */
async function watchPageErrors(cdp, page) {
  page.errors = []
  cdp.on((msg) => {
    if (msg.sessionId !== page.sessionId) return
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      page.errors.push(`exception: ${(d.exception?.description ?? d.text ?? '').split('\n')[0]}`)
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      page.errors.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').split('\n')[0]}`)
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      page.errors.push(`log: ${msg.params.entry.text} ${msg.params.entry.url ?? ''}`.trim())
    }
  })
  await page.send('Log.enable')
}

/** Page-side health probe: Next.js error overlay, app error boundary, empty main area. */
function probePageHealth() {
  const portal = document.querySelector('nextjs-portal')
  const overlayRoot = portal?.shadowRoot
  const overlay = !!overlayRoot?.querySelector('[data-nextjs-dialog], [data-nextjs-dialog-overlay], [data-nextjs-toast-errors], [data-issues]')
  const overlayText = (overlayRoot?.textContent || '').replace(/\s+/g, ' ').slice(0, 160)
  const bodyText = document.body?.innerText || ''
  const boundary = /Something went wrong/.test(bodyText)
  const main = document.querySelector('main')
  const mainChars = (main?.innerText || '').replace(/\s+/g, ' ').trim().length
  return { overlay, overlayText, boundary, mainChars }
}

async function holdApiRequests(cdp, page) {
  if (API_DELAY_MS <= 0) return
  cdp.on((msg) => {
    if (msg.sessionId !== page.sessionId || msg.method !== 'Fetch.requestPaused') return
    setTimeout(() => page.send('Fetch.continueRequest', { requestId: msg.params.requestId }).catch(() => {}), API_DELAY_MS)
  })
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] })
}

const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] }

async function timeEndpoint(session, url) {
  const times = []
  for (let i = 0; i < SAMPLES + 2; i++) {
    const t = performance.now()
    await fetch(`${BASE}${url}`, { headers: { cookie: jarOf(session.cookies), 'X-Requested-With': 'tcms' } }).then((r) => r.arrayBuffer())
    if (i >= 2) times.push(performance.now() - t) // first two = warm-up (dev compile)
  }
  return Math.round(p95(times))
}

async function main() {
  console.log(`PAGE-APIS base=${BASE} roles=${ROLES.join(',')} samples=${SAMPLES} p95<${P95_LIMIT_MS}ms depth<=${MAX_DEPTH}`)
  const accounts = readDemoAccounts()
  const sessions = {}
  for (const role of ROLES) sessions[role] = await login(accounts[role])
  const vp = sessions.vp ?? (await login(accounts.vp))
  const pages = await buildPages(vp)

  const launched = await launchChrome(PROFILE_DIR)
  if (!launched.wsUrl) throw new Error('Chrome did not start')
  const cdp = await Cdp.connect(launched.wsUrl)
  const rows = [] // { page, role, calls, dupes, denied, depth, endpoints }
  const errorRows = [] // { page, role, errors }
  const endpoints = new Map() // url -> { role, pages:Set }
  try {
    for (const role of ROLES) {
      const page = await RolePage.open(cdp, sessions[role], BASE)
      await holdApiRequests(cdp, page)
      await watchPageErrors(cdp, page)
      try {
        await loadPage(page, '/settings/profile') // warm the shell once per role (not a measured URL twice in a row)
        for (const pg of pages) {
          const errMark = page.errors.length
          const reqs = await loadPage(page, pg.url)
          const health = await page.evaluate(probePageHealth).catch((e) => ({ overlay: false, boundary: false, mainChars: 0, overlayText: `probe failed: ${e.message}` }))
          const errs = page.errors.slice(errMark)
          errorRows.push({ page: pg.label, role, errors: errs.length + (health.overlay ? 1 : 0) + (health.boundary ? 1 : 0) + (health.mainChars < MIN_MAIN_CHARS ? 1 : 0) })
          const counts = new Map()
          for (const r of reqs) counts.set(keyOf(r), (counts.get(keyOf(r)) ?? 0) + 1)
          const dupes = [...counts].filter(([, n]) => n > 1).map(([k, n]) => `${k} x${n}`)
          const denied = reqs.filter((r) => r.status === 401 || r.status === 403).map((r) => `${keyOf(r)} -> ${r.status}`)
          const depth = waterfallDepth(reqs)
          const where = `[${role}] ${pg.label}`
          check(`${where}: no console error / uncaught exception`, errs.length === 0, errs.slice(0, 3).join(' || '))
          check(`${where}: no Next.js error overlay`, !health.overlay, health.overlayText)
          check(`${where}: no error boundary ("Something went wrong")`, !health.boundary)
          check(`${where}: page shows content (not empty)`, health.mainChars >= MIN_MAIN_CHARS, `main=${health.mainChars} chars`)
          check(`${where}: no duplicate API call`, dupes.length === 0, dupes.join(', '))
          check(`${where}: no 401/403 call`, denied.length === 0, denied.join(', '))
          check(`${where}: waterfall depth <= ${MAX_DEPTH}`, depth <= MAX_DEPTH, `depth=${depth} calls=${[...counts.keys()].join(' | ')}`)
          if (depth > MAX_DEPTH) {
            const base = Math.min(...reqs.map((r) => r.t0))
            for (const r of [...reqs].sort((a, b) => a.t0 - b.t0)) console.log(`      timeline +${Math.round(r.t0 - base)}ms..+${Math.round((r.t1 ?? r.t0) - base)}ms ${keyOf(r)}`)
          }
          for (const r of reqs) {
            if (r.method !== 'GET' || r.status !== 200) continue
            const u = new URL(r.url)
            const url = `${u.pathname}${u.search}`
            if (!endpoints.has(url)) endpoints.set(url, { role, pages: new Set() })
            endpoints.get(url).pages.add(pg.label)
          }
          rows.push({ page: pg.label, role, calls: reqs.length, dupes: dupes.length, denied: denied.length, depth, urls: [...counts.keys()] })
        }
      } finally {
        await page.close()
      }
    }
  } finally {
    const sd = await shutdownChrome(cdp, launched.child, PROFILE_DIR)
    console.log(`chrome shutdown: processGone=${sd.processGone} profileRemoved=${sd.profileRemoved}`)
  }

  // speed: p95 per distinct GET, with the session of the first role that called it
  const timing = new Map()
  for (const [url, info] of endpoints) {
    const ms = await timeEndpoint(sessions[info.role], url)
    timing.set(url, ms)
    check(`p95 ${url} < ${P95_LIMIT_MS}ms`, ms < P95_LIMIT_MS, `p95=${ms}ms role=${info.role}`)
  }

  console.log('\n=== TABLE (page | role | api calls | dupes | 401/403 | depth | slowest p95 ms) ===')
  for (const r of rows) {
    const slowest = Math.max(0, ...r.urls.filter((k) => k.startsWith('GET ')).map((k) => timing.get(k.slice(4)) ?? 0))
    console.log(`ROW | ${r.page} | ${r.role} | ${r.calls} | ${r.dupes} | ${r.denied} | ${r.depth} | ${slowest}`)
  }
  console.log('\n=== PAGE ERRORS (page | role | errors = console + exception + overlay + boundary + empty) ===')
  for (const r of errorRows) console.log(`ERR | ${r.page} | ${r.role} | ${r.errors}`)
  console.log('\n=== CALLS PER PAGE (vp, or first role) ===')
  const seenPage = new Set()
  for (const r of rows) {
    if (seenPage.has(r.page)) continue
    seenPage.add(r.page)
    console.log(`CALLS | ${r.page} | ${r.urls.join(' ; ')}`)
  }
  console.log('\n=== SLOWEST ENDPOINTS (p95 ms) ===')
  for (const [url, ms] of [...timing].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`P95 | ${ms} | ${url}`)
  console.log(`\nPASS=${pass} FAIL=${fail}`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('PAGE-APIS ERROR:', err.message)
  process.exit(2)
})
