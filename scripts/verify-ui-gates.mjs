/**
 * REQ-001 Q7 — automated UI gate checks for R1–R3 (REQ-001 test-plan (git history) A6), read-only.
 *
 * Headless Chrome over the DevTools protocol (no new dependency: Node's global WebSocket),
 * own profile `--user-data-dir=<os.tmpdir()>\tcms-ui-gates-<stamp>` (never the owner's),
 * random debugging port, one isolated browser context per role. Sessions come from
 * POST /api/auth?path=login (demo accounts read from seed.service.ts at runtime, never
 * printed) and are injected with Network.setCookie. Every page visit is a GET; the only
 * writes are the login rows (refresh token + LOGIN activity), accepted per R9.AC9.
 *
 * Precondition: GET /api/permissions as vp = 126 cells, all source "default", else exit 2.
 * Cleanup (finally + Ctrl+C): Browser.close, then `taskkill /PID <spawned pid> /T /F`
 * (never by image name), prove no chrome.exe command line holds the profile dir, delete it.
 *
 * Usage: node scripts/verify-ui-gates.mjs   (UI_GATES_OBSERVE_MS overrides the 30 s window
 *        for local debugging only; official runs use the default)
 * Exit: 0 green, 1 any FAIL, 2 NOT RUN (precondition, Chrome missing), 130 Ctrl+C.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.TCMS_BASE_URL || 'http://localhost:3000'
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const OBSERVE_MS = Number(process.env.UI_GATES_OBSERVE_MS || 30_000)
const READY_TIMEOUT_MS = 90_000 // first compile of a route in next dev can be slow
const STAMP = Date.now()
const PROFILE_DIR = path.join(tmpdir(), `tcms-ui-gates-${STAMP}`)

const N1 = 'Your role can view work logs but cannot log work. A VP can enable "Create task reports" for your role under Permissions.'
const N2 = "You are viewing another user's report. Switch back to yourself to make edits."
const N3 = "You are viewing another user's report."
const INTEGRATIONS_DENIED = 'Integrations are only available to roles with the manage-integrations permission. A VP can enable it for your role under Permissions.'
const ACTIVITY_DENIED = 'The activity log is only available to roles with view-activity-log rights.'
const CREWDESK_NOT_CONFIGURED = 'Crew Desk integration is not configured'

// Default-matrix expectations (REQ-001 brd (git history) R2 table). Order: vp, manager, product, developer, qa_engineer, viewer.
const ROLES = ['vp', 'manager', 'product', 'developer', 'qa_engineer', 'viewer']
const yes = (...flags) => Object.fromEntries(ROLES.map((r, i) => [r, flags[i]]))
const HEADER_BUTTONS = {
  'New Test Case': yes(1, 1, 1, 0, 1, 0),
  'Report Bug': yes(1, 1, 1, 1, 1, 0),
  Reports: yes(1, 1, 1, 0, 0, 0),
}
const QUICK_ACTIONS = {
  'New Test Case': yes(1, 1, 1, 0, 1, 0),
  'Report Bug': yes(1, 1, 1, 1, 1, 0),
  Reviews: yes(1, 1, 1, 0, 0, 0),
  Tasks: yes(1, 1, 1, 1, 1, 1),
  Modules: yes(1, 1, 1, 1, 1, 1),
  Reports: yes(1, 1, 1, 0, 0, 0),
}
const TILE_COUNT = { vp: 6, manager: 6, product: 6, developer: 3, qa_engineer: 4, viewer: 2 }
const HAS_REVIEW = { vp: true, manager: true, product: true, developer: false, qa_engineer: false, viewer: false } // perform_review
const HAS_ACTIVITY = { vp: true, manager: true, product: true, developer: false, qa_engineer: false, viewer: false } // view_activity_logs

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- accounts (seed.service.ts is the single source; values are never printed) ----------

function readDemoAccounts() {
  const src = readFileSync(path.join(ROOT, 'src', 'app', 'api', 'seed', 'seed.service.ts'), 'utf8')
  const re = /email: '([^']+)'[^}]*?hashPassword\('([^']+)'\)[^}]*?role: '([^']+)'/g
  const byEmail = {}
  for (const m of src.matchAll(re)) byEmail[m[1]] = { email: m[1], password: m[2], role: m[3] }
  const pick = { vp: 'admin@tcms.com', manager: 'teamlead@tcms.com', product: 'product@tcms.com', developer: 'developer@tcms.com', qa_engineer: 'qa1@tcms.com', viewer: 'viewer@tcms.com' }
  return Object.fromEntries(ROLES.map((r) => [r, byEmail[pick[r]]]))
}

async function login(account) {
  const res = await fetch(`${BASE}/api/auth?path=login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms' },
    body: JSON.stringify({ email: account.email, password: account.password }),
  })
  if (res.status !== 200) throw new Error(`login failed for role ${account.role} (${res.status})`)
  const cookies = (res.headers.getSetCookie?.() ?? []).map(parseSetCookie)
  if (!cookies.some((c) => c.name === 'tcms-access')) throw new Error(`login for role ${account.role} set no tcms-access cookie`)
  const { user } = await res.json()
  return { cookies, user }
}

function parseSetCookie(header) {
  const [pair, ...attrs] = header.split(';').map((s) => s.trim())
  const eq = pair.indexOf('=')
  const cookie = { name: pair.slice(0, eq), value: pair.slice(eq + 1), path: '/', httpOnly: false }
  for (const a of attrs) {
    const [k, v] = a.split('=')
    if (k.toLowerCase() === 'path') cookie.path = v
    if (k.toLowerCase() === 'httponly') cookie.httpOnly = true
  }
  return cookie
}

const jarOf = (cookies) => cookies.map((c) => `${c.name}=${c.value}`).join('; ')

async function readMatrixDefaultState(cookies) {
  const res = await fetch(`${BASE}/api/permissions`, { headers: { Cookie: jarOf(cookies) } })
  const cells = res.status === 200 ? await res.json() : null
  if (!Array.isArray(cells)) return { ok: false, detail: `GET /api/permissions -> ${res.status}` }
  const nonDefault = cells.filter((c) => c.source !== 'default')
  return { ok: cells.length === 126 && nonDefault.length === 0, detail: `cells=${cells.length} nonDefault=${nonDefault.map((c) => `${c.role}/${c.action}`).join(',')}` }
}

// ---------- minimal CDP client ----------

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    this.listeners = []
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString())
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(`${msg.error.message}`))
        else resolve(msg.result)
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg)
      }
    })
  }
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error('CDP websocket error')), { once: true })
    })
    return new Cdp(ws)
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify(payload))
    })
  }
  on(fn) {
    this.listeners.push(fn)
  }
  close() {
    try { this.ws.close() } catch { /* already closed */ }
  }
}

/** One isolated tab (own browser context) with network capture. */
class RolePage {
  static async open(cdp, { cookies, user }) {
    const page = new RolePage()
    page.cdp = cdp
    page.requests = []
    const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true })
    page.contextId = browserContextId
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    page.sessionId = sessionId
    cdp.on((msg) => {
      if (msg.sessionId !== sessionId) return
      if (msg.method === 'Network.requestWillBeSent') {
        page.requests.push({ id: msg.params.requestId, url: msg.params.request.url, method: msg.params.request.method, status: null })
      } else if (msg.method === 'Network.responseReceived') {
        for (const r of page.requests) if (r.id === msg.params.requestId) r.status = msg.params.response.status
      }
    })
    await page.send('Network.enable')
    await page.send('Page.enable')
    await page.send('Runtime.enable')
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false })
    for (const c of cookies) {
      await page.send('Network.setCookie', { name: c.name, value: c.value, url: BASE, path: c.path, httpOnly: c.httpOnly, sameSite: 'Lax' })
    }
    // The client AuthGate treats a browser without the `tcms-user` display profile as signed
    // out (src/store/index.ts initialize), so the cookies alone land on /login. Seed it the way
    // a real login does (saveUser in src/lib/client/api.ts) before any app script runs.
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('tcms-user', ${JSON.stringify(JSON.stringify(user))}) } catch {}`,
    })
    return page
  }
  send(method, params) {
    return this.cdp.send(method, params, this.sessionId)
  }
  async evaluate(fn, ...args) {
    const expression = `(${fn.toString()})(...${JSON.stringify(args)})`
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (res.exceptionDetails) throw new Error(`page eval: ${res.exceptionDetails.text}`)
    return res.result.value
  }
  /** Navigates (typed URL = full load) and returns the capture start index. */
  async goto(urlPath) {
    const mark = this.requests.length
    await this.send('Page.navigate', { url: `${BASE}${urlPath}` })
    return mark
  }
  async reload() {
    const mark = this.requests.length
    await this.send('Page.reload', { ignoreCache: true })
    return mark
  }
  async waitFor(fn, args = [], timeout = READY_TIMEOUT_MS) {
    const end = Date.now() + timeout
    let last = null
    while (Date.now() < end) {
      try {
        last = await this.evaluate(fn, ...args)
        if (last && last.ready) return last
      } catch { /* page navigating */ }
      await sleep(500)
    }
    return last ?? { ready: false }
  }
  since(mark) {
    return this.requests.slice(mark)
  }
  async responseBody(requestId) {
    try {
      const { body } = await this.send('Network.getResponseBody', { requestId })
      return body
    } catch {
      return ''
    }
  }
  async close() {
    await this.cdp.send('Target.disposeBrowserContext', { browserContextId: this.contextId }).catch(() => {})
  }
}

// ---------- page-side probes (serialized into the page; must be self-contained) ----------

function probeDashboard() {
  const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim()
  const cardByTitle = (title) =>
    [...document.querySelectorAll('[data-slot=card]')].find((c) => text(c.querySelector('[data-slot=card-title]')) === title)
  const kpiSection = document.querySelector('section[aria-label="Key metrics"]')
  const hero = [...document.querySelectorAll('section')].find((s) => s !== kpiSection && text(s).includes('pending reviews'))
  const quick = cardByTitle('Quick Actions')
  const activity = cardByTitle('Latest Activity')
  const kpi = kpiSection ? [...kpiSection.children].find((el) => text(el).includes('My Pending Reviews')) : null
  const chip = hero ? [...hero.querySelectorAll('span')].find((s) => s.children.length === 2 && text(s.children[1]) === 'pending reviews') : null
  return {
    ready: !!hero && !!quick && !!kpi,
    path: location.pathname,
    headerButtons: hero ? [...hero.querySelectorAll('button')].map(text) : [],
    quickActions: quick ? [...quick.querySelectorAll('[data-slot=card-content] button')].map(text) : [],
    viewAll: activity ? [...activity.querySelectorAll('button')].some((b) => text(b).startsWith('View all')) : false,
    kpi: kpi
      ? {
          tag: kpi.tagName,
          role: kpi.getAttribute('role'),
          tabindex: kpi.getAttribute('tabindex'),
          chevron: !!kpi.querySelector('svg.lucide-chevron-right'),
          value: text(kpi.querySelector('.text-3xl')),
        }
      : null,
    heroValue: chip ? text(chip.children[0]) : null,
  }
}

function clickKpi() {
  const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim()
  const kpiSection = document.querySelector('section[aria-label="Key metrics"]')
  const kpi = kpiSection ? [...kpiSection.children].find((el) => text(el).includes('My Pending Reviews')) : null
  if (kpi) kpi.click()
  return { ready: true, clicked: !!kpi }
}

function probePath(expected) {
  return { ready: location.pathname === expected, path: location.pathname }
}

function probeTasks(notices) {
  const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim()
  const buttons = [...document.querySelectorAll('button')]
  const exportCsv = buttons.find((b) => text(b) === 'Export CSV')
  const alerts = [...document.querySelectorAll('[data-slot=alert]')].map((a) => text(a.querySelector('[data-slot=alert-description]') ?? a))
  return {
    ready: !!document.querySelector('#report-date') && !!exportCsv,
    hasAddTask: buttons.some((b) => text(b) === 'Add task'),
    hasSave: buttons.some((b) => text(b) === 'Save report'),
    hasRemove: !!document.querySelector('[aria-label^="Remove task"]'),
    notices: alerts.filter((t) => notices.includes(t)),
    dateValue: document.querySelector('#report-date')?.value ?? null,
    emptyText: [...document.querySelectorAll('p')].map(text).find((t) => t.startsWith('No tasks logged for')) ?? null,
    hasAddFirst: document.body.innerText.includes('Add your first entry'),
    exportDisabled: exportCsv ? exportCsv.disabled : null,
    hasPicker: !!document.querySelector('#user-select'),
  }
}

function probeCaseDetail(title) {
  const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim()
  return {
    ready: document.body.innerText.includes(title),
    activityCard: [...document.querySelectorAll('[data-slot=card-title]')].some((t) => text(t) === 'Activity'),
  }
}

function probeDenied(expected) {
  const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim()
  const descs = [...document.querySelectorAll('[data-slot=alert-description]')].map(text)
  const hasWorkspace = [...document.querySelectorAll('button')].some((b) => text(b) === 'Refresh')
  return { ready: descs.length > 0 || hasWorkspace, denied: descs.includes(expected), descs }
}

// ---------- request filters ----------

const isApi = (r) => r.url.startsWith(`${BASE}/api/`)
const is403 = (reqs) => reqs.filter((r) => isApi(r) && r.status === 403)
const entityActivity = (r) => r.url.includes('/api/activity-logs') && r.url.includes('action=entity')
const activityFeed = (r) => r.url.includes('/api/activity-logs?') && !r.url.includes('action=')
const crewdesk = (r) => r.url.includes('/api/integrations/crewdesk')
const fmt = (reqs) => reqs.map((r) => `${r.method} ${r.url.replace(BASE, '')} ${r.status}`).join('; ').slice(0, 300)

async function observeUntil(startedAt) {
  const left = OBSERVE_MS - (Date.now() - startedAt)
  if (left > 0) await sleep(left)
}

// ---------- blocks ----------

async function checkDashboard(page, role) {
  await page.goto('/dashboard')
  let s = await page.waitFor(probeDashboard)
  if (!s.ready) console.log(`      dashboard ${role}: page not ready (path=${s.path}); the checks below fail`)
  for (const [label, exp] of Object.entries(HEADER_BUTTONS)) {
    const present = s.headerButtons.includes(label)
    check(`R2 ${role}: header "${label}" ${exp[role] ? 'present' : 'absent'}`, present === !!exp[role], `buttons=${JSON.stringify(s.headerButtons)}`)
  }
  for (const [label, exp] of Object.entries(QUICK_ACTIONS)) {
    const present = s.quickActions.includes(label)
    check(`R2 ${role}: quick action "${label}" ${exp[role] ? 'present' : 'absent'}`, present === !!exp[role], `tiles=${JSON.stringify(s.quickActions)}`)
  }
  check(`R2 ${role}: quick action tile count = ${TILE_COUNT[role]}`, s.quickActions.length === TILE_COUNT[role], `got ${s.quickActions.length}`)
  check(`R2.AC8 ${role}: Latest Activity "View all" ${HAS_ACTIVITY[role] ? 'present' : 'absent'}`, s.viewAll === HAS_ACTIVITY[role], `viewAll=${s.viewAll}`)

  // KPI "My Pending Reviews" (R2.AC6); wait for the count-up animation to settle.
  const settleEnd = Date.now() + 6000
  while (Date.now() < settleEnd && s.kpi && s.kpi.value !== s.heroValue) {
    await sleep(500)
    s = await page.evaluate(probeDashboard)
  }
  if (HAS_REVIEW[role]) {
    check(`R2.AC6 ${role}: KPI card is a <button>`, s.kpi?.tag === 'BUTTON', JSON.stringify(s.kpi))
    await page.evaluate(clickKpi)
    const nav = await page.waitFor(probePath, ['/reviews'], 15_000)
    check(`R2.AC6 ${role}: KPI click opens /reviews`, nav.ready, `path=${nav.path}`)
  } else {
    const k = s.kpi
    check(`R2.AC6(a) ${role}: KPI not a button, no role, no tabindex`, !!k && k.tag !== 'BUTTON' && k.role !== 'button' && k.tabindex === null, JSON.stringify(k))
    check(`R2.AC6(b) ${role}: KPI has no chevron`, !!k && !k.chevron, JSON.stringify(k))
    const mark = page.requests.length
    await page.evaluate(clickKpi)
    await sleep(2500)
    const after = await page.evaluate(probePath, '/dashboard')
    const reviewCalls = page.since(mark).filter((r) => r.url.includes('/api/reviews'))
    check(`R2.AC6(c) ${role}: KPI click stays on /dashboard, 0 /api/reviews* requests`, after.path === '/dashboard' && reviewCalls.length === 0, `path=${after.path} ${fmt(reviewCalls)}`)
    check(`R2.AC6(d) ${role}: KPI value equals hero "pending reviews" chip`, !!k && k.value !== '' && k.value === s.heroValue, `kpi=${k?.value} chip=${s.heroValue}`)
  }
}

async function checkTasksViewer(page) {
  const mark = await page.goto('/tasks')
  const s = await page.waitFor(probeTasks, [[N1, N2, N3]])
  await sleep(3000) // let late requests (if any) show up in the capture
  const reqs = page.since(mark)
  check('R1 viewer: no "Add task" button', s.ready && !s.hasAddTask)
  check('R1 viewer: no "Save report" button', s.ready && !s.hasSave)
  check('R1 viewer: no task row card (no remove control)', s.ready && !s.hasRemove)
  check('R1 viewer: exactly one notice and it equals N1', s.notices?.length === 1 && s.notices[0] === N1, JSON.stringify(s.notices))
  check('R1 viewer: empty state "No tasks logged for <date>."', !!s.dateValue && s.emptyText === `No tasks logged for ${s.dateValue}.`, `date=${s.dateValue} text=${s.emptyText}`)
  check('R1 viewer: no "Add your first entry"', s.ready && !s.hasAddFirst)
  check('R1 viewer: "Export CSV" disabled', s.exportDisabled === true, `disabled=${s.exportDisabled}`)
  check('R1 viewer: no "User" picker', s.ready && !s.hasPicker)
  const writes = reqs.filter((r) => r.url.includes('/api/task-reports') && (r.method === 'POST' || r.method === 'PUT'))
  check('R1 viewer: 0 POST/PUT /api/task-reports', writes.length === 0, fmt(writes))
  check('R1 viewer: 0 /api/* 403 on /tasks', is403(reqs).length === 0, fmt(is403(reqs)))
}

async function checkTasksEditable(page, role) {
  await page.goto('/tasks')
  const s = await page.waitFor(probeTasks, [[N1, N2, N3]])
  check(`R1.AC5 ${role}: "Save report" visible`, s.ready && s.hasSave)
  check(`R1.AC5 ${role}: "Add task" visible`, s.ready && s.hasAddTask)
  check(`R1.AC5 ${role}: no N1/N2/N3 notice`, s.ready && s.notices.length === 0, JSON.stringify(s.notices))
}

/** One R3 visit (typed URL or reload) observed for OBSERVE_MS. */
async function observeVisit(page, how, urlPath, probe, args) {
  const startedAt = Date.now()
  const mark = how === 'typed' ? await page.goto(urlPath) : await page.reload()
  const state = await page.waitFor(probe, args)
  await observeUntil(startedAt)
  return { state, reqs: page.since(mark) }
}

async function checkCaseDetailDenied(page, role, tc) {
  let lastState = null
  for (const how of ['typed', 'reload']) {
    const { state, reqs } = await observeVisit(page, how, `/test-cases/${tc.testCaseId}`, probeCaseDetail, [tc.title])
    lastState = state
    const bad = reqs.filter(entityActivity)
    check(`R3 ${role} /test-cases/[id] (${how}): 0 activity-entity requests`, state.ready && bad.length === 0, fmt(bad))
    check(`R3 ${role} /test-cases/[id] (${how}): 0 /api/* 403`, state.ready && is403(reqs).length === 0, fmt(is403(reqs)))
  }
  check(`R3.AC3 ${role}: Activity card not rendered`, !!lastState?.ready && !lastState.activityCard)
}

async function checkDeniedPage(page, role, urlPath, isForbidden, deniedText, label) {
  let lastState = null
  for (const how of ['typed', 'reload']) {
    const { state, reqs } = await observeVisit(page, how, urlPath, probeDenied, [deniedText])
    lastState = state
    const bad = reqs.filter(isForbidden)
    check(`R3 ${role} ${urlPath} (${how}): 0 ${label} requests`, state.ready && bad.length === 0, fmt(bad))
    check(`R3 ${role} ${urlPath} (${how}): 0 /api/* 403`, state.ready && is403(reqs).length === 0, fmt(is403(reqs)))
  }
  check(`R3 ${role} ${urlPath}: PermissionDenied text unchanged`, !!lastState?.denied, JSON.stringify(lastState?.descs))
}

async function waitForRequest(page, mark, predicate, timeout = 20_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const hit = page.since(mark).find((r) => predicate(r) && r.status !== null)
    if (hit) return hit
    await sleep(300)
  }
  return null
}

async function checkVpPositive(page, tc) {
  let mark = await page.goto(`/test-cases/${tc.testCaseId}`)
  const ent = await waitForRequest(page, mark, entityActivity)
  check('R3.AC2 vp: activity-entity request -> 200', ent?.status === 200, ent ? `${ent.status}` : 'not sent')
  const s = await page.waitFor(probeCaseDetail, [tc.title])
  check('R3.AC3 vp: Activity card rendered', s.ready && s.activityCard)

  mark = await page.goto('/integrations')
  const cfg = await waitForRequest(page, mark, (r) => crewdesk(r) && r.url.includes('path=config'))
  check('R3.AC2 vp: Crew Desk config -> 200', cfg?.status === 200, cfg ? `${cfg.status}` : 'not sent')
  const links = await waitForRequest(page, mark, (r) => crewdesk(r) && r.url.includes('pageSize=50'))
  check('R3.AC2 vp: Crew Desk links -> 200', links?.status === 200, links ? `${links.status}` : 'not sent')
  // email-check runs only when Crew Desk credentials are set (page-API audit 2026-10-17:
  // without them it is certain to fail with 502 "not configured").
  const cfgBody = cfg?.status === 200 ? await page.responseBody(cfg.id) : ''
  const configured = /"authConfigured"\s*:\s*true/.test(cfgBody)
  const email = await waitForRequest(page, mark, (r) => crewdesk(r) && r.url.includes('path=email-check'), configured ? 20_000 : 4_000)
  const emailBody = email?.status === 502 ? await page.responseBody(email.id) : ''
  check(
    configured
      ? 'R3.AC2 vp: Crew Desk configured -> email-check 200'
      : `R3.AC2 vp: Crew Desk not configured -> email-check not sent (no certain 502 "${CREWDESK_NOT_CONFIGURED}")`,
    configured ? email?.status === 200 : !email,
    email ? `${email.status} ${emailBody.slice(0, 100)}` : 'not sent'
  )

  mark = await page.goto('/activity-log')
  const feed = await waitForRequest(page, mark, activityFeed)
  check('R3.AC2 vp: activity feed -> 200', feed?.status === 200, feed ? `${feed.status}` : 'not sent')
}

// ---------- Chrome lifecycle ----------

async function launchChrome() {
  mkdirSync(PROFILE_DIR, { recursive: true })
  const child = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-sync', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  const portFile = path.join(PROFILE_DIR, 'DevToolsActivePort')
  const end = Date.now() + 20_000
  while (Date.now() < end) {
    if (existsSync(portFile)) {
      const [port, wsPath] = readFileSync(portFile, 'utf8').split(/\r?\n/)
      if (port && wsPath) return { child, wsUrl: `ws://127.0.0.1:${port}${wsPath}` }
    }
    await sleep(250)
  }
  return { child, wsUrl: null }
}

function chromeProcessesWithProfile() {
  const ps = spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | ForEach-Object { $_.CommandLine }",
  ], { encoding: 'utf8', windowsHide: true })
  return (ps.stdout || '').split(/\r?\n/).filter((l) => l.includes(PROFILE_DIR))
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function shutdownChrome(cdp, child) {
  if (cdp) {
    await Promise.race([cdp.send('Browser.close').catch(() => {}), sleep(3000)])
    cdp.close()
  }
  if (child?.pid) {
    await sleep(1000)
    if (isAlive(child.pid)) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  }
  await sleep(1000)
  const leftovers = chromeProcessesWithProfile()
  check('harness: spawned Chrome pid tree gone', !(child?.pid && isAlive(child.pid)) && leftovers.length === 0, `left=${leftovers.length}`)
  let removed = false
  for (let i = 0; i < 10 && !removed; i++) {
    try { rmSync(PROFILE_DIR, { recursive: true, force: true }); removed = !existsSync(PROFILE_DIR) } catch { await sleep(500) }
  }
  check('harness: Chrome profile dir removed', removed, PROFILE_DIR)
}

// ---------- main ----------

async function main() {
  console.log(`STAMP=${STAMP}`)
  console.log(`PROFILE=${PROFILE_DIR}`)
  if (!existsSync(CHROME)) {
    console.log(`NOT RUN: Chrome not found at ${CHROME}`)
    return 2
  }
  const accounts = readDemoAccounts()
  const missing = ROLES.filter((r) => !accounts[r])
  if (missing.length) {
    console.log(`NOT RUN: demo account(s) not found in seed.service.ts: ${missing.join(', ')}`)
    return 2
  }
  const vpSession = await login(accounts.vp)
  const vpCookies = vpSession.cookies
  const pre = await readMatrixDefaultState(vpCookies)
  if (!pre.ok) {
    console.log(`PRECONDITION: permission matrix is not all default (${pre.detail})`)
    return 2
  }
  const tcRes = await fetch(`${BASE}/api/test-cases?pageSize=1`, { headers: { Cookie: jarOf(vpCookies) } })
  const tc = (await tcRes.json())?.data?.[0]
  if (!tc?.testCaseId) {
    console.log('NOT RUN: no test case available for the /test-cases/[id] checks')
    return 2
  }
  console.log(`CASE ${tc.testCaseId}`)

  let interrupted = false
  let cdp = null
  let child = null
  const onSigint = () => {
    if (interrupted) { console.log('cleanup in progress'); return }
    interrupted = true
    console.log('INTERRUPTED (SIGINT)')
    // Closing the socket makes the pending CDP calls fail; finally runs the cleanup.
    cdp?.close()
  }
  process.on('SIGINT', onSigint)
  try {
    const launched = await launchChrome()
    child = launched.child
    if (!launched.wsUrl) throw new Error('Chrome did not publish DevToolsActivePort')
    cdp = await Cdp.connect(launched.wsUrl)
    for (const role of ROLES) {
      console.log(`\n=== ${role} ===`)
      const session = role === 'vp' ? vpSession : await login(accounts[role])
      const page = await RolePage.open(cdp, session)
      try {
        await checkDashboard(page, role)
        if (role === 'vp') await checkVpPositive(page, tc)
        if (role === 'viewer') await checkTasksViewer(page)
        if (role === 'product' || role === 'qa_engineer') await checkTasksEditable(page, role)
        if (['developer', 'qa_engineer', 'viewer'].includes(role)) {
          await checkCaseDetailDenied(page, role, tc)
          await checkDeniedPage(page, role, '/activity-log', activityFeed, ACTIVITY_DENIED, 'activity feed')
        }
        if (['product', 'developer', 'qa_engineer', 'viewer'].includes(role)) {
          await checkDeniedPage(page, role, '/integrations', crewdesk, INTEGRATIONS_DENIED, 'Crew Desk')
        }
      } finally {
        await page.close()
      }
    }
  } catch (err) {
    check(interrupted ? 'INTERRUPTED (SIGINT)' : `run aborted: ${err.message}`, false)
  } finally {
    await shutdownChrome(cdp, child)
    const end = await readMatrixDefaultState((await login(accounts.vp)).cookies).catch((e) => ({ ok: false, detail: e.message }))
    check('harness: matrix still 126 default at the end', end.ok, end.detail)
    process.removeListener('SIGINT', onSigint)
  }
  console.log(`\nPASS=${pass} FAIL=${fail}`)
  if (interrupted) return 130
  return fail > 0 ? 1 : 0
}

main().then(
  (code) => { process.exitCode = code },
  (err) => { console.error(`UI-GATES ERROR: ${err.message}`); process.exitCode = 1 }
)
