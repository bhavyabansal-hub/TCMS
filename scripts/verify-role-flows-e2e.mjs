/**
 * ROLE FLOWS END-TO-END SUITE (deep test, tester 2, 2026-10-16).
 *
 * Real daily flows with the DEFAULT permission matrix (nothing is toggled), one fixture user
 * per role (vp, manager, product, developer, qa_engineer, viewer, created by SQL). Actions go
 * through the API, UI checks through headless Chrome (scripts/lib/cdp-browser.mjs).
 *   1 Review flow: case submit -> needs_revision (+ flagged fields) -> QA fix (expectedUpdatedAt)
 *     -> resubmit -> approve; plus one module-level submit + module-review bulk verdict.
 *   2 Bug flow: QA + developer report, manager assigns, developer in_progress -> resolved,
 *     manager closes; reassign rights.
 *   3 Work logs: every role saves a log for a fixed far-past date (2001-03-0X); team visibility.
 *   4 Wiki: written docs, create / edit / view / delete per role.
 *   5 Users page: VP/manager only.
 * Every step: UI (allowed + at least one denied role), API status codes, DB row (actor ids,
 * status, fresh UTC timestamps), activity_logs row, notifications (exact recipient set, nobody
 * else), isolation by URL and by API id. Rules are derived from the services (cited per check
 * group below and in docs/qa/DEEP-TEST-2026-10-16.md (Appendix C)).
 *
 * Safety: DB guard + GET_LOCK (scripts/lib/db-guard.mjs) with the lock-holder watchdog from
 * tester 1 (Prisma may replace the single connection); precondition role_permissions = 0 rows
 * AND GET /api/permissions = 126 cells all 'default' (else exit 2). Reviewer ids are always
 * explicit (fixture manager) so no demo user is auto-picked. Work-log saves notify every
 * view_all_task_reports holder by design (task-reports.service.ts:160-186), demo accounts
 * included: those rows are deleted by entity id at the end. No email/Telegram, no Crew Desk.
 * Cleanup in finally + Ctrl+C: rows deleted by fixture ids / collected ids, residue 0 proven,
 * matrix 126 default proven.
 *
 * Usage: node scripts/verify-role-flows-e2e.mjs
 *        node scripts/verify-role-flows-e2e.mjs --cleanup-stamp=<STAMP>   (recovery: cleanup only, for a killed run)
 * Exit: 0 all pass, 1 any FAIL, 2 NOT RUN, 130 Ctrl+C.
 */
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { GuardAbort, openGuardedDb, sqlIn } from './lib/db-guard.mjs'
import { createFixtureUsers, findUsersByEmails, fixtureEmail } from './lib/fixture-users.mjs'
import { BASE, PERMISSION_CACHE_WAIT_MS, checkResidue, createRunState, requestJson, runCleanupStep, sleep } from './lib/suite-harness.mjs'
import {
  ALL_RESIDUE_TABLES, collectEntities, countModuleDependents, countResidue, deleteActivityLogsByUsers,
  deleteBugsByIds, deleteLoginAttemptsByEmails, deleteModulesByIds, deleteNotificationsByEntity,
  deleteReviewsByParticipants, deleteTestCaseById, deleteUsersByIds, deleteWikiDocById, emptyEntities,
} from './lib/suite-data.mjs'
import { DEFAULT_CHROME, Cdp, RolePage, launchChrome, parseSetCookie, shutdownChrome } from './lib/cdp-browser.mjs'

// A well-formed id that no row has (keys are INT UNSIGNED AUTO_INCREMENT, max 4294967295).
const MISSING_ID = '999999999'

const PREFIX = 'roleflow'
const CLEANUP_STAMP = (process.argv.find((a) => a.startsWith('--cleanup-stamp=')) || '').split('=')[1] || null
const STAMP = CLEANUP_STAMP || String(Date.now())
const PROFILE_DIR = path.join(tmpdir(), `tcms-roleflow-${STAMP}`)
const ROLES = ['vp', 'manager', 'product', 'developer', 'qa_engineer', 'viewer']
const KEY = { vp: 'vp', manager: 'mgr', product: 'prod', developer: 'dev', qa_engineer: 'qa', viewer: 'view' }
const LOG_DATE = { vp: '2001-03-01', manager: '2001-03-02', product: '2001-03-03', developer: '2001-03-04', qa_engineer: '2001-03-05', viewer: '2001-03-06' }
const READY_MS = 40_000
const MIN_FREE_GB_START = 1.2
const MIN_FREE_GB_RUN = 0.8
const CHROME_LOW_MEMORY_ARGS = ['--disable-gpu', '--disable-dev-shm-usage', '--js-flags=--max-old-space-size=256', '--renderer-process-limit=2',
  '--disable-features=Translate,OptimizationHints,MediaRouter', '--disable-component-update', '--mute-audio']
const T = (what) => `${PREFIX} ${STAMP} ${what}`

const D = {
  reviews: 'The reviews workspace is only available to roles with perform-review rights. You are assigned as reviewer only when a review is sent to you — ask a manager if you should be able to review.',
  reviewDetail: 'Review details are only available to roles with perform-review rights.',
  moduleReview: 'Module reviews are only available to roles with perform-review rights.',
  reports: 'The reports view is only available to roles with view-all-reports rights.',
  users: 'You need administrator privileges to manage users.',
  tasksN1: 'Your role can view work logs but cannot log work. A VP can enable "Create task reports" for your role under Permissions.',
}

// ---------- results ----------

const totals = { pass: 0, fail: 0 }
const rows = []
let cur = null

function beginStep(flow, step, role) {
  cur = { flow, step, role, cats: {}, issues: [] }
  rows.push(cur)
  console.log(`\n--- [${flow}] ${step} (${role}) ---`)
}

/** cat: UI | API | DB | NOTIF | H (harness). */
function check(cat, name, cond, detail = '') {
  if (cond) {
    totals.pass++
    console.log(`  ok  [${cat}] ${name}`)
  } else {
    totals.fail++
    console.log(`FAIL  [${cat}] ${name}${detail ? `  (${String(detail).slice(0, 500)})` : ''}`)
  }
  if (cur && cat !== 'H') {
    cur.cats[cat] = (cur.cats[cat] ?? true) && !!cond
    if (!cond) cur.issues.push(name)
  }
  return !!cond
}
const info = (msg) => console.log(`INFO  ${msg}`)

// ---------- run state ----------

const ctx = {
  db: null,
  guard: null,
  fixtures: [],
  byRole: {},
  sess: {},
  pages: {},
  known: emptyEntities(),
  invitedEmails: [],
  accounted: new Set(),
  cdp: null,
  chrome: null,
  openPages: new Set(),
  lockConn: undefined,
}
let state = null

const q = (strings, ...values) => ctx.db.$queryRaw(strings, ...values)
const uid = (role) => ctx.byRole[role].userId
async function dbNow() {
  const r = await q`SELECT UTC_TIMESTAMP(3) AS now`
  return new Date(r[0].now)
}
const isFresh = (ts, t0, t1) => ts instanceof Date && ts.getTime() >= t0.getTime() - 1000 && ts.getTime() <= t1.getTime() + 1000
const iso = (d) => (d instanceof Date ? d.toISOString() : String(d))
const parseJ = (v) => (typeof v === 'string' ? JSON.parse(v) : v)
const short = (res) => `status=${res.status} ${JSON.stringify(res.json).slice(0, 220)}`
function who(userId) {
  const f = ctx.fixtures.find((u) => u.userId === userId)
  return f ? f.role : `demo:${String(userId).slice(0, 8)}`
}

// ---------- memory gate ----------

/** Free physical memory in GB (Win32_OperatingSystem.FreePhysicalMemory is in KB); null when unreadable. */
function freeMemGB() {
  const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory'], { encoding: 'utf8', windowsHide: true }).stdout
  const kb = Number(String(out || '').trim())
  return Number.isFinite(kb) && kb > 0 ? kb / 1024 / 1024 : null
}

// ---------- HTTP ----------

async function login(user) {
  const res = await fetch(`${BASE}/api/auth?path=login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms', Origin: BASE },
    body: JSON.stringify({ email: user.email, password: user.password }),
    signal: state?.signal,
  })
  if (res.status !== 200) throw new Error(`login failed for fixture role ${user.role} (${res.status})`)
  const cookies = (res.headers.getSetCookie?.() ?? []).map(parseSetCookie)
  if (!cookies.some((c) => c.name === 'tcms-access')) throw new Error(`login for fixture role ${user.role} set no tcms-access cookie`)
  const json = await res.json()
  return { jar: cookies.map((c) => `${c.name}=${c.value}`).join('; '), cookies, user: json.user, permissions: json.permissions ?? [] }
}

/** API call as a role; one re-login on 401 (the run can outlive the 15 min access token). */
async function api(role, method, urlPath, body) {
  let res = await requestJson(method, urlPath, { jar: ctx.sess[role].jar, body, signal: state.signal })
  if (res.status === 401) {
    ctx.sess[role] = await login(ctx.byRole[role])
    res = await requestJson(method, urlPath, { jar: ctx.sess[role].jar, body, signal: state.signal })
  }
  return res
}

/** Runs the call between two UTC_TIMESTAMP(3) reads. */
async function timed(fn) {
  const t0 = await dbNow()
  const res = await fn()
  const t1 = await dbNow()
  return { res, t0, t1 }
}

// ---------- DB checks ----------

async function checkActivity(L, role, action, entityType, entityId, t0, t1) {
  const r = await q`SELECT activity_log_id, created_at FROM activity_logs
    WHERE user_id = ${uid(role)} AND action = ${action} AND entity_type = ${entityType} AND entity_id = ${entityId}
      AND created_at >= ${t0}`
  check('DB', `${L} activity_logs ${action} ${entityType} by ${role}, fresh UTC`, r.length === 1 && isFresh(r[0].created_at, t0, t1), `rows=${r.length}`)
}

async function activityCount(role) {
  return Number((await q`SELECT COUNT(*) AS n FROM activity_logs WHERE user_id = ${uid(role)} AND action <> 'LOGIN'`)[0].n)
}

/** Exact recipient set of the notifications written for one entity since t0. */
async function checkNotifs(L, entityType, entityId, t0, t1, expected) {
  const got = await q`SELECT notification_id, user_id, type, created_at FROM notifications
    WHERE entity_type = ${entityType} AND entity_id = ${entityId} AND created_at >= ${t0}`
  for (const r of got) ctx.accounted.add(r.notification_id)
  const g = got.map((r) => `${who(r.user_id)}:${r.type}`).sort()
  const e = expected.map((x) => `${who(x.userId)}:${x.type}`).sort()
  const label = e.length > 6 ? `${e.length} rows (${[...new Set(expected.map((x) => x.type))].join(',')})` : `[${e.join(', ') || 'none'}]`
  check('NOTIF', `${L} notifications for ${entityType}: exactly ${label}, nobody else`, JSON.stringify(g) === JSON.stringify(e) && got.every((r) => isFresh(r.created_at, t0, t1)),
    `got=${JSON.stringify(g)} expected=${JSON.stringify(e)}`)
  return got
}

/** No-write proof for a denied call: signature + the role's activity count unchanged. */
async function denied(L, role, call, sigFn, expectStatus = 403) {
  const before = sigFn ? await sigFn() : null
  const act0 = await activityCount(role)
  const res = await call()
  const okStatus = Array.isArray(expectStatus) ? expectStatus.includes(res.status) : res.status === expectStatus
  check('API', `${L} -> ${Array.isArray(expectStatus) ? expectStatus.join('/') : expectStatus}`, okStatus, short(res))
  if (sigFn) {
    const after = await sigFn()
    check('DB', `${L}: nothing written (row signature unchanged)`, before === after, `before=${before} after=${after}`)
  }
  const act1 = await activityCount(role)
  check('DB', `${L}: no activity_logs row for ${role}`, act0 === act1, `before=${act0} after=${act1}`)
  return res
}
const sigOf = (fn) => async () => JSON.stringify(await fn(), (k, v) => (typeof v === 'bigint' ? Number(v) : v))

// ---------- browser ----------

function probe(spec) {
  const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim()
  const nav = [...document.querySelectorAll('aside nav a')].map((a) => text(a.querySelector('span.flex-1') ?? a))
  const alerts = [...document.querySelectorAll('[data-slot=alert-description]')].map(text)
  const deniedShown = spec.deniedText ? alerts.includes(spec.deniedText) : false
  const body = document.body ? document.body.innerText : ''
  const lower = body.toLowerCase()
  const values = [...document.querySelectorAll('input,textarea')].map((i) => i.value).filter(Boolean)
  let markerOk = true
  if (spec.markerText) markerOk = markerOk && body.includes(spec.markerText)
  if (spec.markerSelector) markerOk = markerOk && !!document.querySelector(spec.markerSelector)
  if (spec.markerValue) markerOk = markerOk && values.some((v) => v.includes(spec.markerValue))
  const scope = spec.scopeSelector ? document.querySelector(spec.scopeSelector) : document
  const buttons = scope ? [...scope.querySelectorAll('button')].map(text).filter(Boolean) : []
  const selectors = {}
  for (const s of spec.selectors || []) {
    const el = document.querySelector(s)
    selectors[s] = el ? (el.disabled || el.hasAttribute('data-disabled') ? 'disabled' : 'enabled') : 'absent'
  }
  const has = {}
  for (const t of spec.texts || []) has[t] = lower.includes(t.toLowerCase())
  return { ready: nav.length > 0 && (deniedShown || markerOk), path: location.pathname, nav, alerts, deniedShown, buttons, selectors, has, values: values.slice(0, 40) }
}

function locateByText(selector, wanted, scopeSelector, prefix) {
  const scope = scopeSelector ? document.querySelector(scopeSelector) : document
  if (!scope) return null
  const el = [...scope.querySelectorAll(selector)].find((e) => {
    const t = (e.textContent || '').replace(/\s+/g, ' ').trim()
    return prefix ? t.startsWith(wanted) : t === wanted
  })
  if (!el) return null
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}
function locateSelector(selector) {
  const el = document.querySelector(selector)
  if (!el) return null
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}
function hasText(selector, wanted, prefix) {
  return { ready: [...document.querySelectorAll(selector)].some((e) => { const t = (e.textContent || '').replace(/\s+/g, ' ').trim(); return prefix ? t.startsWith(wanted) : t === wanted }) }
}
function cardTitleHas(name) {
  return { ready: [...document.querySelectorAll('[data-slot=card-title]')].some((e) => (e.textContent || '').includes(name)) }
}
function setInputValue(selector, value) {
  const el = document.querySelector(selector)
  if (!el) return false
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}
function pressEscape() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  return true
}

/** ONE browser context at a time (memory): switching role disposes the open context first. */
async function pageFor(role) {
  if (ctx.pageRole === role && ctx.page) return ctx.page
  if (ctx.page) {
    ctx.openPages.delete(ctx.page)
    await ctx.page.close().catch(() => {})
    ctx.page = null
    ctx.pageRole = null
  }
  const s = await login(ctx.byRole[role])
  const page = await RolePage.open(ctx.cdp, { cookies: s.cookies, user: s.user }, BASE, { readyTimeoutMs: READY_MS })
  ctx.openPages.add(page)
  ctx.page = page
  ctx.pageRole = role
  return page
}

/** Navigates the role's page and returns the settled probe state. */
async function visit(role, urlPath, spec) {
  const page = await pageFor(role)
  await page.goto(urlPath)
  const st = await page.waitFor(probe, [spec])
  await sleep(800)
  const fin = await page.evaluate(probe, spec).catch(() => st)
  return { ...fin, ready: st.ready && fin.ready }
}
async function settle(role, spec, timeout = 20_000) {
  const page = await pageFor(role)
  const st = await page.waitFor(probe, [spec], timeout)
  await sleep(600)
  const fin = await page.evaluate(probe, spec).catch(() => st)
  return { ...fin, ready: st.ready && fin.ready }
}
const hasButton = (st, label, prefix = false) => st.buttons.some((b) => (prefix ? b.startsWith(label) : b === label))
const where = (role, p) => `UI ${role} ${p.replace(/\/\d+(?=\/|\?|$)/g, '/<id>')}`

/** Standard UI expectation block. */
function uiExpect(role, p, st, { link, linkShown, deniedShown, buttons = {}, texts = {}, selectors = {} } = {}) {
  const W = where(role, p)
  check('UI', `${W}: page ready`, st.ready, `path=${st.path} alerts=${JSON.stringify(st.alerts)}`)
  if (link) check('UI', `${W}: sidebar "${link}" ${linkShown ? 'shown' : 'hidden'}`, st.nav.includes(link) === linkShown, `nav=${JSON.stringify(st.nav)}`)
  if (deniedShown !== undefined) check('UI', `${W}: PermissionDenied ${deniedShown ? 'shown' : 'absent'}`, st.deniedShown === deniedShown, `alerts=${JSON.stringify(st.alerts)}`)
  for (const [b, want] of Object.entries(buttons)) {
    const prefix = b.endsWith('*')
    const label = prefix ? b.slice(0, -1) : b
    check('UI', `${W}: button "${label}" ${want ? 'visible' : 'hidden'}`, st.ready && hasButton(st, label, prefix) === want, `buttons=${JSON.stringify(st.buttons.slice(0, 40))}`)
  }
  for (const [t, want] of Object.entries(texts)) check('UI', `${W}: text "${t}" ${want ? 'shown' : 'not shown'}`, st.ready && st.has[t] === want)
  for (const [s, want] of Object.entries(selectors)) check('UI', `${W}: ${s} ${want}`, st.ready && st.selectors[s] === want, `state=${st.selectors[s]}`)
}

// ---------- lock watchdog (approach of tester 1, scripts/verify-permission-toggle-e2e.mjs:731-766) ----------

function ownMysqlClientPorts() {
  const out = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true }).stdout || ''
  const ports = []
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length >= 5 && cols[2] === '127.0.0.1:5500' && cols[3] === 'ESTABLISHED' && cols[4] === String(process.pid)) ports.push(cols[1].split(':').pop())
  }
  return ports
}
async function watchLock(whereAt) {
  const [r] = await q`SELECT CONNECTION_ID() AS cid, IS_USED_LOCK('tcms_verify') AS holder`
  const cid = Number(r.cid)
  const holder = r.holder === null ? null : Number(r.holder)
  if (ctx.lockConn !== undefined && cid !== ctx.lockConn) console.log(`      LOCK-WATCH connection changed ${ctx.lockConn} -> ${cid} (${whereAt})`)
  if (holder !== null && holder !== cid) {
    const [p] = await q`SELECT HOST AS host FROM information_schema.PROCESSLIST WHERE ID = ${holder}`
    const port = String(p?.host ?? '').split(':')[1]
    const mine = ownMysqlClientPorts()
    const isOwn = !!port && mine.includes(port)
    console.log(`      LOCK-WATCH lock on connection ${holder} (client port ${port ?? '?'}), this process' ports to :5500 = ${mine.join(',')}`)
    check('H', `harness: lock tcms_verify still held by this process (${whereAt})`, isOwn, `holder=${holder} port=${port}`)
    if (!isOwn) throw new Error('lock tcms_verify held by another session')
  } else if (holder === null) {
    const [g] = await q`SELECT GET_LOCK('tcms_verify', 0) AS got`
    console.log(`      LOCK-WATCH lock released with a replaced connection; re-acquired on ${cid}: got=${Number(g.got)} (${whereAt})`)
    check('H', `harness: lock tcms_verify re-acquired (${whereAt})`, Number(g.got) === 1)
    if (Number(g.got) !== 1) throw new Error('lock tcms_verify taken by another session')
  }
  ctx.lockConn = cid
}

// =====================================================================================
// FLOW 1 — review (rules: test-cases.service.ts:101,158-159,251-264; reviews.service.ts:59-81,208-229,
// 274-298; modules.service.ts:244-312; module-reviews.service.ts:58-60,106,156-176,224-253)
// =====================================================================================

const F = {} // ids of the flow entities

async function getTc(role, id) {
  return (await api(role, 'GET', `/api/test-cases?id=${id}`)).json
}

async function flowReview() {
  await watchLock('flow 1')
  // 1.1 product creates the module (create_module); QA is denied
  beginStep('1 review', '1.1 create module', 'product')
  let { res, t0, t1 } = await timed(() => api('product', 'POST', '/api/modules', { name: T('module review'), description: 'roleflow module' }))
  check('API', '1.1 product POST /api/modules -> 200', res.status === 200, short(res))
  F.m1 = res.json?.moduleId
  if (F.m1) ctx.known.modules.push(F.m1)
  let [m] = await q`SELECT created_by_id, owner_id, updated_by_id, created_at, updated_at FROM modules WHERE module_id = ${F.m1 ?? ''}`
  check('DB', '1.1 modules row: created_by/owner/updated_by = product, fresh UTC', !!m && m.created_by_id === uid('product') && m.owner_id === uid('product') && m.updated_by_id === uid('product') && isFresh(m.created_at, t0, t1) && isFresh(m.updated_at, t0, t1), JSON.stringify(m ?? null))
  await checkActivity('1.1', 'product', 'CREATE', 'module', F.m1, t0, t1)
  beginStep('1 review', '1.1 create module denied', 'qa_engineer')
  await denied('1.1 qa POST /api/modules (no create_module)', 'qa_engineer', () => api('qa_engineer', 'POST', '/api/modules', { name: T('module denied'), description: 'x' }),
    sigOf(() => q`SELECT COUNT(*) AS n FROM modules WHERE name = ${T('module denied')}`))

  // 1.2 QA creates the case; developer and viewer denied
  beginStep('1 review', '1.2 create test case', 'qa_engineer')
  ;({ res, t0, t1 } = await timed(() => api('qa_engineer', 'POST', '/api/test-cases', { title: T('case review'), moduleId: F.m1, description: 'roleflow case', priority: 'P1', tags: ['roleflow'] })))
  check('API', '1.2 qa POST /api/test-cases -> 200', res.status === 200, short(res))
  F.c1 = res.json?.testCaseId
  if (F.c1) ctx.known.cases.push(F.c1)
  let [c] = await q`SELECT author_id, last_edited_by_id, module_id, status, version, priority, created_at, updated_at FROM test_cases WHERE test_case_id = ${F.c1 ?? ''}`
  check('DB', '1.2 test_cases row: author = last_edited_by = qa, module, draft, v1, P1, fresh UTC', !!c && c.author_id === uid('qa_engineer') && c.last_edited_by_id === uid('qa_engineer') && c.module_id === F.m1 && c.status === 'draft' && Number(c.version) === 1 && c.priority === 'P1' && isFresh(c.created_at, t0, t1) && isFresh(c.updated_at, t0, t1), JSON.stringify(c ?? null))
  await checkActivity('1.2', 'qa_engineer', 'CREATE', 'test_case', F.c1, t0, t1)
  for (const role of ['developer', 'viewer']) {
    beginStep('1 review', '1.2 create test case denied', role)
    await denied(`1.2 ${role} POST /api/test-cases (no create_test_case)`, role, () => api(role, 'POST', '/api/test-cases', { title: T(`case denied ${role}`), moduleId: F.m1, description: 'x' }),
      sigOf(() => q`SELECT COUNT(*) AS n FROM test_cases WHERE module_id = ${F.m1}`))
  }
  beginStep('1 review', '1.2 case page per role', 'qa_engineer, viewer, developer')
  let st = await visit('qa_engineer', `/test-cases/${F.c1}`, { markerText: T('case review') })
  uiExpect('qa_engineer', `/test-cases/${F.c1}`, st, { link: 'Reviews', linkShown: false, buttons: { Edit: true, 'Submit for Review': true, Delete: true } })
  st = await visit('viewer', `/test-cases/${F.c1}`, { markerText: T('case review') })
  uiExpect('viewer', `/test-cases/${F.c1}`, st, { buttons: { Edit: false, 'Submit for Review': false, Delete: false } })
  st = await visit('developer', `/test-cases/${F.c1}`, { markerText: T('case review') })
  uiExpect('developer', `/test-cases/${F.c1}`, st, { buttons: { Edit: false, 'Submit for Review': false } })

  // 1.3 submit for review (reviewer = fixture manager, explicit)
  beginStep('1 review', '1.3 submit denied', 'developer, viewer')
  for (const role of ['developer', 'viewer']) {
    await denied(`1.3 ${role} PUT submit-review (no submit_review)`, role, () => api(role, 'PUT', `/api/test-cases?id=${F.c1}&action=submit-review`, { reviewerId: uid('manager') }),
      sigOf(() => q`SELECT COUNT(*) AS n FROM review_requests WHERE test_case_id = ${F.c1}`))
  }
  beginStep('1 review', '1.3 submit for review (cycle 1)', 'qa_engineer')
  ;({ res, t0, t1 } = await timed(() => api('qa_engineer', 'PUT', `/api/test-cases?id=${F.c1}&action=submit-review`, { reviewerId: uid('manager') })))
  check('API', '1.3 qa PUT submit-review {reviewerId: manager} -> 200', res.status === 200, short(res))
  F.r1 = res.json?.reviewRequestId
  if (F.r1) ctx.known.reviews.push(F.r1)
  let [r] = await q`SELECT test_case_id, requester_id, reviewer_id, status, cycle, created_at, updated_at FROM review_requests WHERE review_request_id = ${F.r1 ?? ''}`
  check('DB', '1.3 review_requests row: requester qa, reviewer manager, pending, cycle 1, fresh UTC', !!r && r.test_case_id === F.c1 && r.requester_id === uid('qa_engineer') && r.reviewer_id === uid('manager') && r.status === 'pending' && Number(r.cycle) === 1 && isFresh(r.created_at, t0, t1) && isFresh(r.updated_at, t0, t1), JSON.stringify(r ?? null))
  ;[c] = await q`SELECT status, updated_at FROM test_cases WHERE test_case_id = ${F.c1}`
  check('DB', '1.3 test case status in_review', c?.status === 'in_review', c?.status)
  await checkActivity('1.3', 'qa_engineer', 'REVIEW_SUBMITTED', 'test_case', F.c1, t0, t1)
  await checkNotifs('1.3', 'review', F.r1, t0, t1, [{ userId: uid('manager'), type: 'review_assigned' }])

  beginStep('1 review', '1.3 review detail isolation (API)', 'all')
  for (const role of ROLES) {
    const want = ['vp', 'manager', 'product'].includes(role) ? 200 : 403 // reviews.service.ts:59-63,73
    const g = await api(role, 'GET', `/api/reviews?id=${F.r1}`)
    check('API', `1.3 ${role} GET /api/reviews?id=<r1> -> ${want}`, g.status === want, short(g))
  }
  const mq = await api('manager', 'GET', '/api/reviews?action=queue')
  check('API', '1.3 manager queue contains r1', mq.status === 200 && (mq.json ?? []).some((x) => x.reviewRequestId === F.r1), short(mq))
  const pq = await api('product', 'GET', '/api/reviews?action=queue')
  check('API', '1.3 product queue does not contain r1 (not assigned)', pq.status === 200 && !(pq.json ?? []).some((x) => x.reviewRequestId === F.r1), short(pq))
  const anon = await requestJson('GET', `/api/reviews?id=${F.r1}`, {})
  check('API', '1.3 no session GET /api/reviews?id -> 401', anon.status === 401, short(anon))

  beginStep('1 review', '1.3 review pages per role', 'qa, manager, product, developer')
  st = await visit('qa_engineer', `/test-cases/${F.c1}`, { markerText: T('case review'), texts: ['awaiting review'] })
  uiExpect('qa_engineer', `/test-cases/${F.c1}`, st, { buttons: { 'Submit for Review': false }, texts: { 'awaiting review': true } })
  st = await visit('manager', `/reviews/${F.r1}`, { markerText: T('case review'), deniedText: D.reviewDetail })
  uiExpect('manager', `/reviews/${F.r1}`, st, { link: 'Reviews', linkShown: true, deniedShown: false, buttons: { Approve: true, Fail: true, 'Needs Revision': true } })
  st = await visit('product', `/reviews/${F.r1}`, { markerText: T('case review'), deniedText: D.reviewDetail, texts: ['verdict is reserved for the assigned reviewer'] })
  uiExpect('product', `/reviews/${F.r1}`, st, { deniedShown: false, buttons: { Approve: false, 'Needs Revision': false, 'Change Reviewer': true }, texts: { 'verdict is reserved for the assigned reviewer': true } })
  for (const role of ['qa_engineer', 'developer']) {
    st = await visit(role, `/reviews/${F.r1}`, { markerText: T('case review'), deniedText: D.reviewDetail })
    uiExpect(role, `/reviews/${F.r1}`, st, { link: 'Reviews', linkShown: false, deniedShown: true, buttons: { Approve: false } })
  }

  // 1.4 verdict needs_revision with flagged fields
  beginStep('1 review', '1.4 verdict by non-assigned reviewer denied', 'product')
  await denied('1.4 product POST verdict (perform_review, not assigned)', 'product', () => api('product', 'POST', `/api/reviews?id=${F.r1}`, { verdict: 'approved', comment: 'x' }),
    sigOf(() => q`SELECT status, updated_at, (SELECT COUNT(*) FROM review_events WHERE review_request_id = ${F.r1}) AS ev FROM review_requests WHERE review_request_id = ${F.r1}`))
  beginStep('1 review', '1.4 verdict denied', 'qa_engineer')
  await denied('1.4 qa POST verdict on own case (no perform_review)', 'qa_engineer', () => api('qa_engineer', 'POST', `/api/reviews?id=${F.r1}`, { verdict: 'approved' }),
    sigOf(() => q`SELECT status, updated_at FROM review_requests WHERE review_request_id = ${F.r1}`))
  beginStep('1 review', '1.4 needs_revision + flagged fields', 'manager')
  const flagged = ['Missing preconditions', 'Ambiguous title']
  const rv = (await api('manager', 'GET', `/api/reviews?id=${F.r1}`)).json
  ;({ res, t0, t1 } = await timed(() => api('manager', 'POST', `/api/reviews?id=${F.r1}`, { verdict: 'needs_revision', comment: T('please add preconditions'), flaggedFields: flagged, expectedUpdatedAt: rv?.updatedAt })))
  check('API', '1.4 manager POST verdict needs_revision (expectedUpdatedAt) -> 200', res.status === 200 && res.json?.testCaseStatus === 'needs_revision', short(res))
  let [ev] = await q`SELECT reviewer_id, verdict, comment, flagged_fields, created_at FROM review_events WHERE review_request_id = ${F.r1}`
  check('DB', '1.4 review_events row: reviewer manager, needs_revision, comment, flagged fields stored, fresh UTC', !!ev && ev.reviewer_id === uid('manager') && ev.verdict === 'needs_revision' && ev.comment === T('please add preconditions') && JSON.stringify(parseJ(ev.flagged_fields)) === JSON.stringify(flagged) && isFresh(ev.created_at, t0, t1), JSON.stringify(ev ? { ...ev, flagged_fields: parseJ(ev.flagged_fields) } : null))
  ;[r] = await q`SELECT status, updated_at FROM review_requests WHERE review_request_id = ${F.r1}`
  check('DB', '1.4 review r1 stays open (in_progress), updated_at fresh', r?.status === 'in_progress' && isFresh(r?.updated_at, t0, t1), JSON.stringify(r ?? null))
  ;[c] = await q`SELECT status FROM test_cases WHERE test_case_id = ${F.c1}`
  check('DB', '1.4 test case status needs_revision', c?.status === 'needs_revision', c?.status)
  await checkActivity('1.4', 'manager', 'REVIEW_VERDICT', 'test_case', F.c1, t0, t1)
  // author == requester (qa): one notification only (reviews.service.ts:275-298 dedupe)
  await checkNotifs('1.4', 'review', F.r1, t0, t1, [{ userId: uid('qa_engineer'), type: 'review_needs_revision' }])
  beginStep('1 review', '1.4 stale verdict (double submit) 409', 'manager')
  await denied('1.4 manager repeats the verdict with the old expectedUpdatedAt', 'manager', () => api('manager', 'POST', `/api/reviews?id=${F.r1}`, { verdict: 'needs_revision', comment: 'again', flaggedFields: flagged, expectedUpdatedAt: rv?.updatedAt }),
    sigOf(() => q`SELECT COUNT(*) AS n FROM review_events WHERE review_request_id = ${F.r1}`), 409)

  // 1.5 QA sees the status + flagged fields
  beginStep('1 review', '1.5 QA sees needs_revision + flagged fields', 'qa_engineer')
  const tcNow = await getTc('qa_engineer', F.c1)
  check('API', '1.5 qa GET /api/test-cases?id -> status needs_revision', tcNow?.status === 'needs_revision', JSON.stringify(tcNow?.status))
  const hist = await api('qa_engineer', 'GET', `/api/test-cases?id=${F.c1}&action=reviews`)
  const evs = (hist.json ?? []).flatMap((x) => x.events ?? [])
  check('API', '1.5 qa GET ?action=reviews -> flaggedFields of the event', hist.status === 200 && evs.some((e) => JSON.stringify(e.flaggedFields) === JSON.stringify(flagged)), short(hist))
  st = await visit('qa_engineer', `/test-cases/${F.c1}`, { markerText: T('case review'), texts: ['needs revision', 'Missing preconditions', 'Ambiguous title', T('please add preconditions')] })
  uiExpect('qa_engineer', `/test-cases/${F.c1}`, st, { buttons: { Edit: true, 'Submit for Review': true },
    texts: { 'needs revision': true, [T('please add preconditions')]: true, 'Missing preconditions': true, 'Ambiguous title': true } })
  st = await visit('qa_engineer', '/notifications', { markerText: 'Review needs revision', texts: ['Review needs revision'] })
  uiExpect('qa_engineer', '/notifications', st, { texts: { 'Review needs revision': true } })
  st = await visit('manager', `/reviews/${F.r1}`, { markerText: T('case review'), texts: ['Missing preconditions'] })
  uiExpect('manager', `/reviews/${F.r1}`, st, { texts: { 'Missing preconditions': true } })

  // 1.6 QA fixes the case (editor payload, expectedUpdatedAt)
  beginStep('1 review', '1.6 edit denied', 'developer, product')
  for (const role of ['developer', 'product']) {
    await denied(`1.6 ${role} PUT /api/test-cases (not author / no edit right)`, role, () => api(role, 'PUT', `/api/test-cases?id=${F.c1}`, { title: T('case hijack'), expectedUpdatedAt: tcNow?.updatedAt }),
      sigOf(() => q`SELECT title, version, updated_at FROM test_cases WHERE test_case_id = ${F.c1}`))
  }
  beginStep('1 review', '1.6 QA fixes the case', 'qa_engineer')
  const editBody = { title: T('case review'), moduleId: F.m1, priority: 'P1', description: 'roleflow case', preconditions: 'User is signed in', expectedResult: 'Dashboard shown', tags: ['roleflow'], assigneeId: null, expectedUpdatedAt: tcNow?.updatedAt }
  ;({ res, t0, t1 } = await timed(() => api('qa_engineer', 'PUT', `/api/test-cases?id=${F.c1}`, editBody)))
  check('API', '1.6 qa PUT /api/test-cases (editor payload + expectedUpdatedAt) -> 200', res.status === 200, short(res))
  ;[c] = await q`SELECT version, last_edited_by_id, preconditions, status, updated_at FROM test_cases WHERE test_case_id = ${F.c1}`
  check('DB', '1.6 test_cases: version 2, last_edited_by qa, preconditions saved, updated_at fresh', !!c && Number(c.version) === 2 && c.last_edited_by_id === uid('qa_engineer') && c.preconditions === 'User is signed in' && isFresh(c.updated_at, t0, t1), JSON.stringify(c ?? null))
  const [h] = await q`SELECT version, changed_by_id, created_at FROM test_case_history WHERE test_case_id = ${F.c1} ORDER BY created_at DESC LIMIT 1`
  check('DB', '1.6 test_case_history snapshot v1 by qa, fresh', !!h && Number(h.version) === 1 && h.changed_by_id === uid('qa_engineer') && isFresh(h.created_at, t0, t1), JSON.stringify(h ?? null))
  await checkActivity('1.6', 'qa_engineer', 'UPDATE', 'test_case', F.c1, t0, t1)
  await checkNotifs('1.6', 'test_case', F.c1, t0, t1, [])
  beginStep('1 review', '1.6 stale edit 409', 'qa_engineer')
  await denied('1.6 qa PUT again with the pre-edit expectedUpdatedAt', 'qa_engineer', () => api('qa_engineer', 'PUT', `/api/test-cases?id=${F.c1}`, { ...editBody, title: T('case stale') }),
    sigOf(() => q`SELECT title, version, updated_at FROM test_cases WHERE test_case_id = ${F.c1}`), 409)

  // 1.7 resubmit (cycle 2)
  beginStep('1 review', '1.7 resubmit (cycle 2)', 'qa_engineer')
  ;({ res, t0, t1 } = await timed(() => api('qa_engineer', 'PUT', `/api/test-cases?id=${F.c1}&action=submit-review`, { reviewerId: uid('manager') })))
  check('API', '1.7 qa resubmit -> 200', res.status === 200, short(res))
  F.r2 = res.json?.reviewRequestId
  if (F.r2) ctx.known.reviews.push(F.r2)
  ;[r] = await q`SELECT requester_id, reviewer_id, status, cycle, created_at FROM review_requests WHERE review_request_id = ${F.r2 ?? ''}`
  check('DB', '1.7 review_requests r2: cycle 2, pending, reviewer manager, requester qa, fresh', !!r && Number(r.cycle) === 2 && r.status === 'pending' && r.reviewer_id === uid('manager') && r.requester_id === uid('qa_engineer') && isFresh(r.created_at, t0, t1), JSON.stringify(r ?? null))
  ;[c] = await q`SELECT status FROM test_cases WHERE test_case_id = ${F.c1}`
  check('DB', '1.7 test case back to in_review', c?.status === 'in_review', c?.status)
  await checkActivity('1.7', 'qa_engineer', 'REVIEW_SUBMITTED', 'test_case', F.c1, t0, t1)
  await checkNotifs('1.7', 'review', F.r2, t0, t1, [{ userId: uid('manager'), type: 'review_assigned' }])
  const [old] = await q`SELECT status FROM review_requests WHERE review_request_id = ${F.r1}`
  check('DB', '1.7 superseded cycle-1 review r1 is no longer open after the resubmit', old && !['pending', 'in_progress'].includes(old.status), `r1.status=${old?.status}`)
  const mq2 = await api('manager', 'GET', '/api/reviews?action=queue')
  const openForCase = (mq2.json ?? []).filter((x) => x.testCaseId === F.c1).map((x) => `cycle${x.cycle}:${x.status}`)
  check('API', '1.7 manager queue holds exactly one open review for the case (cycle 2)', openForCase.length === 1 && openForCase[0].startsWith('cycle2'), JSON.stringify(openForCase))

  // 1.8 approve cycle 2
  beginStep('1 review', '1.8 approve cycle 2', 'manager')
  const rv2 = (await api('manager', 'GET', `/api/reviews?id=${F.r2}`)).json
  ;({ res, t0, t1 } = await timed(() => api('manager', 'POST', `/api/reviews?id=${F.r2}`, { verdict: 'approved', comment: 'looks good', expectedUpdatedAt: rv2?.updatedAt })))
  check('API', '1.8 manager POST verdict approved -> 200', res.status === 200 && res.json?.testCaseStatus === 'approved', short(res))
  ;[ev] = await q`SELECT reviewer_id, verdict, created_at FROM review_events WHERE review_request_id = ${F.r2}`
  check('DB', '1.8 review_events r2: manager approved, fresh', !!ev && ev.reviewer_id === uid('manager') && ev.verdict === 'approved' && isFresh(ev.created_at, t0, t1), JSON.stringify(ev ?? null))
  ;[r] = await q`SELECT status, updated_at FROM review_requests WHERE review_request_id = ${F.r2}`
  ;[c] = await q`SELECT status FROM test_cases WHERE test_case_id = ${F.c1}`
  check('DB', '1.8 r2 completed (fresh updated_at) and case approved', r?.status === 'completed' && isFresh(r?.updated_at, t0, t1) && c?.status === 'approved', `${r?.status}/${c?.status}`)
  await checkActivity('1.8', 'manager', 'REVIEW_VERDICT', 'test_case', F.c1, t0, t1)
  await checkNotifs('1.8', 'review', F.r2, t0, t1, [{ userId: uid('qa_engineer'), type: 'review_approved' }])
  beginStep('1 review', '1.8 double approve rejected', 'manager')
  await denied('1.8 manager approves r2 again (completed)', 'manager', () => api('manager', 'POST', `/api/reviews?id=${F.r2}`, { verdict: 'approved' }),
    sigOf(() => q`SELECT COUNT(*) AS n FROM review_events WHERE review_request_id = ${F.r2}`), 400)
  beginStep('1 review', '1.8 stale cycle-1 verdict cannot override the approval', 'manager')
  const rv1 = (await api('manager', 'GET', `/api/reviews?id=${F.r1}`)).json
  const stale = await api('manager', 'POST', `/api/reviews?id=${F.r1}`, { verdict: 'failed', comment: 'stale cycle', expectedUpdatedAt: rv1?.updatedAt })
  ;[c] = await q`SELECT status FROM test_cases WHERE test_case_id = ${F.c1}`
  check('API', '1.8 verdict on the superseded cycle-1 review r1 -> 400/409', [400, 409].includes(stale.status), short(stale))
  check('DB', '1.8 test case still approved after the stale cycle-1 verdict', c?.status === 'approved', `status=${c?.status}`)
  beginStep('1 review', '1.8 approved case page', 'qa_engineer')
  st = await visit('qa_engineer', `/test-cases/${F.c1}`, { markerText: T('case review') })
  uiExpect('qa_engineer', `/test-cases/${F.c1}`, st, { buttons: { 'Submit for Review': c?.status !== 'approved' } })
  check('UI', `${where('qa_engineer', `/test-cases/${F.c1}`)}: status badge matches the DB status (${c?.status})`, st.ready && (await (await pageFor('qa_engineer')).evaluate((s) => document.body.innerText.toLowerCase().includes(s), String(c?.status).replace('_', ' '))))
}

async function flowModuleReview() {
  await watchLock('flow 1 module')
  beginStep('1 review', '1.9 module + 2 cases for module review', 'product, qa_engineer')
  let res = await api('product', 'POST', '/api/modules', { name: T('module bulk'), description: 'roleflow bulk' })
  check('API', '1.9 product POST /api/modules (bulk module) -> 200', res.status === 200, short(res))
  F.m2 = res.json?.moduleId
  if (F.m2) ctx.known.modules.push(F.m2)
  F.mc = []
  for (const n of [1, 2]) {
    res = await api('qa_engineer', 'POST', '/api/test-cases', { title: T(`bulk case ${n}`), moduleId: F.m2, description: 'roleflow bulk case', priority: 'P2' })
    check('API', `1.9 qa POST bulk case ${n} -> 200`, res.status === 200, short(res))
    if (res.json?.testCaseId) { F.mc.push(res.json.testCaseId); ctx.known.cases.push(res.json.testCaseId) }
  }
  beginStep('1 review', '1.9 module submit UI', 'qa_engineer, developer')
  for (const [role, want] of [['qa_engineer', true], ['developer', false]]) {
    const page = await pageFor(role)
    await page.goto('/modules')
    await page.waitFor(hasText, ['span.flex-1.truncate', T('module bulk')], 30_000)
    await page.clickAt(locateByText, 'span.flex-1.truncate', T('module bulk'))
    await page.waitFor(cardTitleHas, [T('module bulk')], 20_000)
    const st = await settle(role, { markerText: T('module bulk') })
    const hasCard = await page.evaluate((n) => [...document.querySelectorAll('[data-slot=card-title]')].some((e) => e.textContent.includes(n)), T('module bulk'))
    check('UI', `UI ${role} /modules (select bulk module): detail panel open`, hasCard)
    check('UI', `UI ${role} /modules: button "Submit for Review" ${want ? 'visible' : 'hidden'}`, hasCard && hasButton(st, 'Submit for Review') === want, `buttons=${JSON.stringify(st.buttons.slice(0, 30))}`)
  }
  beginStep('1 review', '1.10 module submit denied / bad reviewer', 'developer, qa_engineer')
  await denied('1.10 developer PUT /api/modules submit-review (no submit_review)', 'developer', () => api('developer', 'PUT', `/api/modules?id=${F.m2}&action=submit-review`, { reviewerId: uid('manager') }),
    sigOf(() => q`SELECT COUNT(*) AS n FROM module_review_requests WHERE module_id = ${F.m2}`))
  await denied('1.10 qa module submit with an unknown reviewerId -> 400/404 (same contract as case submit, test-cases.service.ts:255-257)', 'qa_engineer',
    () => api('qa_engineer', 'PUT', `/api/modules?id=${F.m2}&action=submit-review`, { reviewerId: MISSING_ID }),
    sigOf(() => q`SELECT (SELECT COUNT(*) FROM module_review_requests WHERE module_id = ${F.m2}) AS mr, (SELECT COUNT(*) FROM review_requests WHERE ${sqlIn('test_case_id', F.mc)}) AS rr`), [400, 404])
  beginStep('1 review', '1.10 module submit for review', 'qa_engineer')
  let t0, t1
  ;({ res, t0, t1 } = await timed(() => api('qa_engineer', 'PUT', `/api/modules?id=${F.m2}&action=submit-review`, { reviewerId: uid('manager') })))
  check('API', '1.10 qa PUT /api/modules submit-review {reviewerId: manager} -> 200, 2 case reviews', res.status === 200 && res.json?.caseReviewCount === 2, short(res))
  F.mr = res.json?.moduleReview?.moduleReviewRequestId
  if (F.mr) ctx.known.moduleReviews.push(F.mr)
  const [mrRow] = await q`SELECT module_id, requester_id, reviewer_id, status, cycle, created_at, updated_at FROM module_review_requests WHERE module_review_request_id = ${F.mr ?? ''}`
  check('DB', '1.10 module_review_requests: requester qa, reviewer manager, pending, cycle 1, fresh', !!mrRow && mrRow.module_id === F.m2 && mrRow.requester_id === uid('qa_engineer') && mrRow.reviewer_id === uid('manager') && mrRow.status === 'pending' && Number(mrRow.cycle) === 1 && isFresh(mrRow.created_at, t0, t1) && isFresh(mrRow.updated_at, t0, t1), JSON.stringify(mrRow ?? null))
  const crs = await q`SELECT review_request_id, test_case_id, reviewer_id, requester_id, status, created_at FROM review_requests WHERE module_review_id = ${F.mr ?? ''}`
  for (const x of crs) ctx.known.reviews.push(x.review_request_id)
  check('DB', '1.10 2 case reviews linked, reviewer manager, requester qa, pending, fresh', crs.length === 2 && crs.every((x) => x.reviewer_id === uid('manager') && x.requester_id === uid('qa_engineer') && x.status === 'pending' && isFresh(x.created_at, t0, t1)), JSON.stringify(crs.map((x) => x.status)))
  const cs = await q`SELECT status FROM test_cases WHERE ${sqlIn('test_case_id', F.mc)}`
  check('DB', '1.10 both cases in_review', cs.length === 2 && cs.every((x) => x.status === 'in_review'), JSON.stringify(cs))
  await checkActivity('1.10', 'qa_engineer', 'REVIEW_SUBMITTED', 'module', F.m2, t0, t1)
  await checkNotifs('1.10', 'module_review', F.mr, t0, t1, [{ userId: uid('manager'), type: 'review_assigned' }])
  for (const x of crs) await checkNotifs('1.10 (case review)', 'review', x.review_request_id, t0, t1, [])

  beginStep('1 review', '1.11 module review isolation (API + UI)', 'all')
  for (const role of ROLES) {
    const want = ['vp', 'manager', 'product'].includes(role) ? 200 : 403 // module-reviews.service.ts:58-60
    const g = await api(role, 'GET', `/api/module-reviews?id=${F.mr}`)
    check('API', `1.11 ${role} GET /api/module-reviews?id -> ${want}`, g.status === want, short(g))
  }
  const all = await api('qa_engineer', 'GET', '/api/module-reviews?action=all')
  check('API', '1.11 qa GET /api/module-reviews?action=all -> 403', all.status === 403, short(all))
  const mq = await api('manager', 'GET', '/api/module-reviews?action=queue')
  check('API', '1.11 manager module queue contains the module review', mq.status === 200 && (mq.json ?? []).some((x) => x.moduleReviewRequestId === F.mr), short(mq))
  let st = await visit('manager', `/module-reviews/${F.mr}`, { markerText: T('module bulk'), deniedText: D.moduleReview })
  uiExpect('manager', `/module-reviews/${F.mr}`, st, { deniedShown: false, buttons: { 'Approve All (2)': true, 'Change Reviewer': true } })
  st = await visit('product', `/module-reviews/${F.mr}`, { markerText: T('module bulk'), deniedText: D.moduleReview })
  uiExpect('product', `/module-reviews/${F.mr}`, st, { deniedShown: false, buttons: { 'Approve All (2)': false, 'Change Reviewer': true } })
  st = await visit('qa_engineer', `/module-reviews/${F.mr}`, { markerText: T('module bulk'), deniedText: D.moduleReview })
  uiExpect('qa_engineer', `/module-reviews/${F.mr}`, st, { deniedShown: true, buttons: { 'Approve All (2)': false } })

  beginStep('1 review', '1.12 bulk verdict denied', 'product, manager')
  const mrd = (await api('manager', 'GET', `/api/module-reviews?id=${F.mr}`)).json
  await denied('1.12 product bulk-verdict (not the assigned reviewer)', 'product', () => api('product', 'POST', `/api/module-reviews?id=${F.mr}&action=bulk-verdict`, { verdict: 'approved', expectedUpdatedAt: mrd?.updatedAt }),
    sigOf(() => q`SELECT status, updated_at FROM module_review_requests WHERE module_review_request_id = ${F.mr}`))
  await denied('1.12 manager bulk needs_revision without a comment -> 400', 'manager', () => api('manager', 'POST', `/api/module-reviews?id=${F.mr}&action=bulk-verdict`, { verdict: 'needs_revision', expectedUpdatedAt: mrd?.updatedAt }),
    sigOf(() => q`SELECT status, updated_at FROM module_review_requests WHERE module_review_request_id = ${F.mr}`), 400)
  beginStep('1 review', '1.12 bulk verdict approved', 'manager')
  ;({ res, t0, t1 } = await timed(() => api('manager', 'POST', `/api/module-reviews?id=${F.mr}&action=bulk-verdict`, { verdict: 'approved', comment: 'bulk ok', expectedUpdatedAt: mrd?.updatedAt })))
  check('API', '1.12 manager bulk-verdict approved -> 200, affected 2, completed', res.status === 200 && res.json?.affectedCount === 2 && res.json?.moduleReviewStatus === 'completed', short(res))
  const [mr2] = await q`SELECT status, updated_at FROM module_review_requests WHERE module_review_request_id = ${F.mr}`
  check('DB', '1.12 module review completed, updated_at fresh', mr2?.status === 'completed' && isFresh(mr2?.updated_at, t0, t1), JSON.stringify(mr2 ?? null))
  const evs = await q`SELECT e.reviewer_id, e.verdict, e.created_at, r.status FROM review_events e JOIN review_requests r ON r.review_request_id = e.review_request_id WHERE r.module_review_id = ${F.mr}`
  check('DB', '1.12 2 review_events approved by manager (fresh), case reviews completed', evs.length === 2 && evs.every((e) => e.reviewer_id === uid('manager') && e.verdict === 'approved' && e.status === 'completed' && isFresh(e.created_at, t0, t1)), JSON.stringify(evs.map((e) => `${e.verdict}/${e.status}`)))
  const cs2 = await q`SELECT status FROM test_cases WHERE ${sqlIn('test_case_id', F.mc)}`
  check('DB', '1.12 both cases approved', cs2.every((x) => x.status === 'approved') && cs2.length === 2, JSON.stringify(cs2))
  await checkActivity('1.12', 'manager', 'REVIEW_VERDICT', 'module', F.m2, t0, t1)
  // author == requester == qa: one notification, same dedupe rule as reviews.service.ts:286-289
  await checkNotifs('1.12', 'module_review', F.mr, t0, t1, [{ userId: uid('qa_engineer'), type: 'review_approved' }])

  beginStep('1 review', '1.13 resubmit of an approved case rejected (state machine)', 'qa_engineer')
  await denied('1.13 qa PUT submit-review on an approved case -> 400', 'qa_engineer', () => api('qa_engineer', 'PUT', `/api/test-cases?id=${F.mc[0]}&action=submit-review`, { reviewerId: uid('manager') }),
    sigOf(() => q`SELECT (SELECT COUNT(*) FROM review_requests WHERE test_case_id = ${F.mc[0]}) AS n, (SELECT status FROM test_cases WHERE test_case_id = ${F.mc[0]}) AS s`), 400)
}

// =====================================================================================
// FLOW 2 — bugs (rules: bugs.service.ts:76-80 read open, 95 create, 134-143 create notify,
// 160-170 update/reassign, 215-226 assign notify, 258 delete)
// =====================================================================================

async function bugRow(id) {
  const [b] = await q`SELECT reported_by_id, assigned_to_id, severity, status, module_id, resolved_at, created_at, updated_at FROM bugs WHERE bug_id = ${id ?? ''}`
  return b
}
async function bugUpdatedAt(role, id) {
  return (await api(role, 'GET', `/api/bugs?id=${id}`)).json?.updatedAt
}

async function openBugDialog(role, title, edit) {
  const page = await pageFor(role)
  await page.goto('/bugs')
  await page.waitFor(probe, [{ markerText: 'Export CSV' }])
  await page.clickAt(locateByText, '[role=tab]', 'Table')
  await page.waitFor(hasText, ['tbody td', title], 20_000)
  await page.clickAt(locateByText, 'tbody td', title)
  let st = await settle(role, { markerText: title, scopeSelector: '[role=dialog]', selectors: ['[role=dialog]'] })
  if (edit && hasButton(st, 'Edit')) {
    await page.clickAt(locateByText, 'button', 'Edit', '[role=dialog]')
    await sleep(800)
  }
  return page.evaluate(() => {
    const dialog = document.querySelector('[role=dialog]')
    const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim()
    let assignee = 'absent'
    if (dialog) {
      const label = [...dialog.querySelectorAll('label')].find((l) => text(l) === 'Assignee')
      const trigger = label?.parentElement?.querySelector('button[role=combobox]')
      if (trigger) assignee = trigger.disabled || trigger.hasAttribute('data-disabled') ? 'disabled' : 'enabled'
    }
    return { open: !!dialog, text: dialog ? dialog.innerText.toLowerCase() : '', buttons: dialog ? [...dialog.querySelectorAll('button')].map(text).filter(Boolean) : [], assignee }
  })
}

async function flowBugs() {
  await watchLock('flow 2')
  beginStep('2 bugs', '2.1 /bugs per role', 'qa, developer, manager, viewer')
  for (const [role, want] of [['qa_engineer', true], ['developer', true], ['manager', true], ['viewer', false]]) {
    const st = await visit(role, '/bugs', { markerText: 'Export CSV' })
    uiExpect(role, '/bugs', st, { buttons: { 'Report Bug': want } })
  }
  beginStep('2 bugs', '2.1 QA reports a bug', 'qa_engineer')
  let { res, t0, t1 } = await timed(() => api('qa_engineer', 'POST', '/api/bugs', { title: T('bug qa'), moduleId: F.m1, description: 'roleflow qa bug', severity: 'high' }))
  check('API', '2.1 qa POST /api/bugs -> 200', res.status === 200, short(res))
  F.b1 = res.json?.bugId
  if (F.b1) ctx.known.bugs.push(F.b1)
  let b = await bugRow(F.b1)
  check('DB', '2.1 bugs row: reported_by qa, high, open, module, unassigned, fresh UTC', !!b && b.reported_by_id === uid('qa_engineer') && b.severity === 'high' && b.status === 'open' && b.module_id === F.m1 && b.assigned_to_id === null && isFresh(b.created_at, t0, t1) && isFresh(b.updated_at, t0, t1), JSON.stringify(b ?? null))
  await checkActivity('2.1', 'qa_engineer', 'CREATE', 'bug', F.b1, t0, t1)
  await checkNotifs('2.1', 'bug', F.b1, t0, t1, [])
  beginStep('2 bugs', '2.2 developer reports a bug', 'developer')
  ;({ res, t0, t1 } = await timed(() => api('developer', 'POST', '/api/bugs', { title: T('bug dev'), moduleId: F.m1, description: 'roleflow dev bug', severity: 'critical' })))
  check('API', '2.2 developer POST /api/bugs -> 200', res.status === 200, short(res))
  F.b2 = res.json?.bugId
  if (F.b2) ctx.known.bugs.push(F.b2)
  b = await bugRow(F.b2)
  check('DB', '2.2 bugs row: reported_by developer, critical, open, fresh UTC', !!b && b.reported_by_id === uid('developer') && b.severity === 'critical' && b.status === 'open' && isFresh(b.created_at, t0, t1), JSON.stringify(b ?? null))
  await checkActivity('2.2', 'developer', 'CREATE', 'bug', F.b2, t0, t1)
  await checkNotifs('2.2', 'bug', F.b2, t0, t1, [])
  beginStep('2 bugs', '2.2 create denied', 'viewer')
  await denied('2.2 viewer POST /api/bugs (no create_bug)', 'viewer', () => api('viewer', 'POST', '/api/bugs', { title: T('bug viewer'), moduleId: F.m1, description: 'x' }),
    sigOf(() => q`SELECT COUNT(*) AS n FROM bugs WHERE module_id = ${F.m1}`))
  beginStep('2 bugs', '2.3 assign on create needs assign_bug', 'qa_engineer')
  const before = Number((await q`SELECT COUNT(*) AS n FROM bugs WHERE module_id = ${F.m1}`)[0].n)
  ;({ res, t0, t1 } = await timed(() => api('qa_engineer', 'POST', '/api/bugs', { title: T('bug qa preassigned'), moduleId: F.m1, description: 'roleflow assign on create', severity: 'low', assignedToId: uid('developer') })))
  if (res.json?.bugId) ctx.known.bugs.push(res.json.bugId)
  check('API', '2.3 qa (no assign_bug) POST /api/bugs {assignedToId: developer} -> 403', res.status === 403, short(res))
  const after = Number((await q`SELECT COUNT(*) AS n FROM bugs WHERE module_id = ${F.m1}`)[0].n)
  check('DB', '2.3 no bug row written with an assignee chosen by a role without assign_bug', before === after, `before=${before} after=${after} assigned_to=${res.json?.assignedToId ? who(res.json.assignedToId) : null}`)
  if (res.json?.bugId) await checkNotifs('2.3', 'bug', res.json.bugId, t0, t1, [])
  // UI: the create dialog picker for a role without assign_bug
  {
    const page = await pageFor('qa_engineer')
    await page.goto('/bugs')
    await page.waitFor(probe, [{ markerText: 'Export CSV' }])
    await page.clickAt(locateByText, 'button', 'Report Bug')
    const st = await settle('qa_engineer', { markerSelector: '#b-assigned', selectors: ['#b-assigned'] })
    check('UI', 'UI qa_engineer /bugs Report Bug dialog: "Assign To" picker disabled without assign_bug', st.selectors['#b-assigned'] === 'disabled', `state=${st.selectors['#b-assigned']}`)
    await page.evaluate(pressEscape)
  }

  beginStep('2 bugs', '2.4 manager assigns the QA bug to the developer', 'manager')
  let exp = await bugUpdatedAt('manager', F.b1)
  ;({ res, t0, t1 } = await timed(() => api('manager', 'PUT', `/api/bugs?id=${F.b1}`, { assignedToId: uid('developer'), expectedUpdatedAt: exp })))
  check('API', '2.4 manager PUT {assignedToId: developer, expectedUpdatedAt} -> 200', res.status === 200, short(res))
  b = await bugRow(F.b1)
  check('DB', '2.4 bugs.assigned_to_id = developer, reporter unchanged, updated_at fresh', b?.assigned_to_id === uid('developer') && b?.reported_by_id === uid('qa_engineer') && isFresh(b?.updated_at, t0, t1), JSON.stringify(b ?? null))
  await checkActivity('2.4', 'manager', 'UPDATE', 'bug', F.b1, t0, t1)
  await checkNotifs('2.4', 'bug', F.b1, t0, t1, [{ userId: uid('developer'), type: 'bug_assigned' }])
  {
    const d = await openBugDialog('manager', T('bug qa'), true)
    check('UI', 'UI manager /bugs dialog (qa bug) > Edit: assignee picker enabled', d.open && d.assignee === 'enabled', JSON.stringify({ open: d.open, assignee: d.assignee }))
    await (await pageFor('manager')).evaluate(pressEscape)
  }
  beginStep('2 bugs', '2.5 developer may not reassign', 'developer')
  const sigB1 = sigOf(() => q`SELECT assigned_to_id, status, updated_at FROM bugs WHERE bug_id = ${F.b1}`)
  const sigB2 = sigOf(() => q`SELECT assigned_to_id, status, updated_at FROM bugs WHERE bug_id = ${F.b2}`)
  await denied('2.5 developer PUT own bug {assignedToId: qa} (no assign_bug)', 'developer', async () => api('developer', 'PUT', `/api/bugs?id=${F.b2}`, { assignedToId: uid('qa_engineer'), expectedUpdatedAt: await bugUpdatedAt('developer', F.b2) }), sigB2)
  await denied('2.5 developer PUT assigned bug {assignedToId: null} (unassign = reassign)', 'developer', async () => api('developer', 'PUT', `/api/bugs?id=${F.b1}`, { assignedToId: null, expectedUpdatedAt: await bugUpdatedAt('developer', F.b1) }), sigB1)
  {
    const d = await openBugDialog('developer', T('bug qa'), true)
    check('UI', 'UI developer /bugs dialog (assigned bug) > Edit: assignee picker disabled', d.open && d.assignee === 'disabled', JSON.stringify({ open: d.open, assignee: d.assignee }))
    await (await pageFor('developer')).evaluate(pressEscape)
  }

  beginStep('2 bugs', '2.6 developer -> in_progress (kanban drag payload)', 'developer')
  exp = await bugUpdatedAt('developer', F.b1)
  ;({ res, t0, t1 } = await timed(() => api('developer', 'PUT', `/api/bugs?id=${F.b1}`, { status: 'in_progress', expectedUpdatedAt: exp })))
  check('API', '2.6 developer PUT {status: in_progress, expectedUpdatedAt} -> 200', res.status === 200, short(res))
  b = await bugRow(F.b1)
  check('DB', '2.6 status in_progress, assignee still developer, updated_at fresh', b?.status === 'in_progress' && b?.assigned_to_id === uid('developer') && isFresh(b?.updated_at, t0, t1), JSON.stringify(b ?? null))
  check('DB', '2.6 severity stays high after the drag payload (known BUG-T1-1, not re-filed)', b?.severity === 'high', `severity=${b?.severity}`)
  await checkActivity('2.6', 'developer', 'UPDATE', 'bug', F.b1, t0, t1)
  await checkNotifs('2.6', 'bug', F.b1, t0, t1, [])
  beginStep('2 bugs', '2.7 developer -> resolved', 'developer')
  const expBeforeResolve = await bugUpdatedAt('developer', F.b1)
  ;({ res, t0, t1 } = await timed(() => api('developer', 'PUT', `/api/bugs?id=${F.b1}`, { status: 'resolved', severity: 'high', expectedUpdatedAt: expBeforeResolve })))
  check('API', '2.7 developer PUT {status: resolved, severity, expectedUpdatedAt} -> 200', res.status === 200, short(res))
  b = await bugRow(F.b1)
  check('DB', '2.7 status resolved, resolved_at + updated_at fresh UTC', b?.status === 'resolved' && isFresh(b?.resolved_at, t0, t1) && isFresh(b?.updated_at, t0, t1), JSON.stringify(b ?? null))
  await checkActivity('2.7', 'developer', 'UPDATE', 'bug', F.b1, t0, t1)
  await checkNotifs('2.7', 'bug', F.b1, t0, t1, [])
  await denied('2.7 developer PUT with the pre-resolve expectedUpdatedAt (double submit) -> 409', 'developer', () => api('developer', 'PUT', `/api/bugs?id=${F.b1}`, { status: 'open', severity: 'high', expectedUpdatedAt: expBeforeResolve }), sigB1, 409)
  {
    const d = await openBugDialog('developer', T('bug qa'), false)
    check('UI', 'UI developer /bugs dialog shows status "resolved"', d.open && d.text.includes('resolved'), d.text.slice(0, 160))
    await (await pageFor('developer')).evaluate(pressEscape)
  }
  beginStep('2 bugs', '2.8 status change denied', 'viewer')
  await denied('2.8 viewer PUT {status: closed} (no create_bug/assign_bug)', 'viewer', async () => api('viewer', 'PUT', `/api/bugs?id=${F.b1}`, { status: 'closed', expectedUpdatedAt: await bugUpdatedAt('viewer', F.b1) }), sigB1)
  beginStep('2 bugs', '2.9 manager closes', 'manager')
  exp = await bugUpdatedAt('manager', F.b1)
  ;({ res, t0, t1 } = await timed(() => api('manager', 'PUT', `/api/bugs?id=${F.b1}`, { status: 'closed', severity: 'high', expectedUpdatedAt: exp })))
  check('API', '2.9 manager PUT {status: closed} -> 200', res.status === 200, short(res))
  b = await bugRow(F.b1)
  check('DB', '2.9 status closed, resolved_at + updated_at fresh', b?.status === 'closed' && isFresh(b?.resolved_at, t0, t1) && isFresh(b?.updated_at, t0, t1), JSON.stringify(b ?? null))
  await checkActivity('2.9', 'manager', 'UPDATE', 'bug', F.b1, t0, t1)
  await checkNotifs('2.9', 'bug', F.b1, t0, t1, [])
  beginStep('2 bugs', '2.10 bug isolation', 'viewer, developer')
  const g = await api('viewer', 'GET', `/api/bugs?id=${F.b1}`)
  check('API', '2.10 viewer GET /api/bugs?id -> 200 (bugs are readable by every role, bugs.service.ts:76)', g.status === 200 && g.json?.bugId === F.b1, short(g))
  await denied('2.10 developer DELETE /api/bugs (no delete_bug)', 'developer', () => api('developer', 'DELETE', `/api/bugs?id=${F.b2}`), sigOf(() => q`SELECT COUNT(*) AS n FROM bugs WHERE bug_id = ${F.b2}`))
  info('bugs.service.ts:160 lets every create_bug holder (QA/developer) change the status of ANY bug, including closing a bug of someone else; not a FAIL under the code rules')
}

// =====================================================================================
// FLOW 3 — work logs (rules: task-reports.service.ts:56,79-86,95-99,127-128,160-186,224,280-285;
// stats.service.ts reports gate)
// =====================================================================================

async function flowWorkLogs() {
  await watchLock('flow 3')
  F.tr = {}
  for (const role of ROLES) {
    beginStep('3 work logs', `3.1 save work log ${LOG_DATE[role]}`, role)
    const desc = T(`${KEY[role]} task`)
    const body = { reportDate: LOG_DATE[role], tasks: [{ description: desc, timeSpentMinutes: 30 + ROLES.indexOf(role), status: 'done' }], notes: T('notes') }
    if (role === 'viewer') {
      await denied('3.1 viewer POST /api/task-reports (no create_task_report)', 'viewer', () => api('viewer', 'POST', '/api/task-reports', body),
        sigOf(() => q`SELECT COUNT(*) AS n FROM task_reports WHERE reported_by_id = ${uid('viewer')}`))
      continue
    }
    const holders = (await q`SELECT user_id FROM users WHERE is_active = 1 AND notify_inapp = 1 AND role IN ('vp', 'manager', 'product') AND user_id <> ${uid(role)}`).map((x) => x.user_id)
    const { res, t0, t1 } = await timed(() => api(role, 'POST', '/api/task-reports', body))
    check('API', `3.1 ${role} POST /api/task-reports -> 200`, res.status === 200, short(res))
    const id = res.json?.taskReportId
    F.tr[role] = id
    if (id) ctx.known.taskReports.push(id)
    const [t] = await q`SELECT reported_by_id, report_date, total_minutes, tasks, created_at, updated_at FROM task_reports WHERE task_report_id = ${id ?? ''}`
    check('DB', `3.1 task_reports row: reported_by ${role}, date ${LOG_DATE[role]}, ${30 + ROLES.indexOf(role)} min, fresh UTC`, !!t && t.reported_by_id === uid(role) && iso(t.report_date).slice(0, 10) === LOG_DATE[role] && Number(t.total_minutes) === 30 + ROLES.indexOf(role) && parseJ(t.tasks)?.[0]?.description === desc && isFresh(t.created_at, t0, t1) && isFresh(t.updated_at, t0, t1), JSON.stringify(t ? { date: iso(t.report_date), min: Number(t.total_minutes) } : null))
    await checkActivity('3.1', role, 'CREATE', 'task_report', id, t0, t1)
    await checkNotifs(`3.1 (${role})`, 'task_report', id, t0, t1, holders.map((h) => ({ userId: h, type: 'daily_report_submitted' })))
    const fixtureGot = (await q`SELECT user_id FROM notifications WHERE entity_type = 'task_report' AND entity_id = ${id ?? ''}`).map((x) => who(x.user_id)).filter((x) => !x.startsWith('demo:')).sort()
    const fixtureWant = ['manager', 'product', 'vp'].filter((x) => x !== role)
    check('NOTIF', `3.1 (${role}) fixture recipients = [${fixtureWant.join(', ')}] (developer/qa/viewer never)`, JSON.stringify(fixtureGot) === JSON.stringify(fixtureWant), JSON.stringify(fixtureGot))
  }

  beginStep('3 work logs', '3.2 read other users\' logs by id', 'all')
  const pairs = [['vp', 'developer', 200], ['manager', 'qa_engineer', 200], ['product', 'developer', 200], ['developer', 'qa_engineer', 403], ['qa_engineer', 'manager', 403], ['viewer', 'qa_engineer', 403], ['developer', 'developer', 200]]
  for (const [role, owner, want] of pairs) {
    const g = await api(role, 'GET', `/api/task-reports?id=${F.tr[owner]}`)
    check('API', `3.2 ${role} GET /api/task-reports?id=<${owner} log> -> ${want}`, g.status === want, short(g))
  }
  const range = 'dateFrom=2001-03-01&dateTo=2001-03-31'
  for (const [role, target] of [['developer', 'qa_engineer'], ['qa_engineer', 'manager'], ['viewer', 'qa_engineer']]) {
    const l = await api(role, 'GET', `/api/task-reports?userId=${uid(target)}&${range}`)
    const data = l.json?.data ?? []
    const ownOk = role === 'viewer' ? data.length === 0 : data.length === 1 && data[0].taskReportId === F.tr[role]
    check('API', `3.2 ${role} list ?userId=<${target}> -> own rows only`, l.status === 200 && data.every((x) => x.reportedById === uid(role)) && ownOk, `status=${l.status} rows=${data.map((x) => who(x.reportedById)).join(',')}`)
    const ex = await api(role, 'GET', `/api/task-reports?action=export&userId=${uid(target)}&month=2001-03`)
    const exRows = ex.json?.reports ?? []
    check('API', `3.2 ${role} export ?userId=<${target}>&month=2001-03 -> locked to own data`, ex.status === 200 && ex.json?.user?.userId === uid(role) && exRows.every((x) => x.reportedById === uid(role)), `status=${ex.status} user=${who(ex.json?.user?.userId)} rows=${exRows.length}`)
  }
  for (const role of ['vp', 'manager']) {
    const l = await api(role, 'GET', `/api/task-reports?userId=${uid('developer')}&${range}`)
    check('API', `3.2 ${role} list ?userId=<developer> -> the developer's log`, l.status === 200 && (l.json?.data ?? []).some((x) => x.taskReportId === F.tr.developer), short(l))
  }
  for (const role of ROLES) {
    const want = ['vp', 'manager', 'product'].includes(role) ? 200 : 403
    const s = await api(role, 'GET', `/api/task-reports?action=summary&${range}`)
    const ids = (s.json?.users ?? []).map((u) => u.userId)
    const teamOk = want !== 200 || ['vp', 'manager', 'product', 'developer', 'qa_engineer'].every((r) => ids.includes(uid(r)))
    check('API', `3.2 ${role} GET ?action=summary (March 2001) -> ${want}${want === 200 ? ' with all 5 fixture logs' : ''}`, s.status === want && teamOk, `status=${s.status} users=${ids.length}`)
    const st = await api(role, 'GET', '/api/stats?action=reports')
    check('API', `3.2 ${role} GET /api/stats?action=reports -> ${want}`, st.status === want, String(st.status))
  }
  beginStep('3 work logs', '3.3 edit someone else\'s log denied', 'developer, manager')
  const sigQa = sigOf(() => q`SELECT tasks, notes, total_minutes, updated_at FROM task_reports WHERE task_report_id = ${F.tr.qa_engineer}`)
  await denied('3.3 developer PUT /api/task-reports?id=<qa log>', 'developer', () => api('developer', 'PUT', `/api/task-reports?id=${F.tr.qa_engineer}`, { notes: 'hijack' }), sigQa)
  await denied('3.3 manager PUT /api/task-reports?id=<qa log> (owner only, task-reports.service.ts:283)', 'manager', () => api('manager', 'PUT', `/api/task-reports?id=${F.tr.qa_engineer}`, { notes: 'hijack' }), sigQa)

  beginStep('3 work logs', '3.4 /tasks per role (own log for the 2001 date)', 'all')
  for (const role of ROLES) {
    const page = await pageFor(role)
    await page.goto('/tasks')
    await page.waitFor(probe, [{ markerSelector: '#report-date' }])
    await page.evaluate(setInputValue, '#report-date', LOG_DATE[role])
    const desc = T(`${KEY[role]} task`)
    const spec = role === 'viewer' ? { markerSelector: '#report-date', deniedText: D.tasksN1, selectors: ['#user-select'] } : { markerValue: desc, selectors: ['#user-select'] }
    const st = await settle(role, spec, 25_000)
    const W = where(role, `/tasks (date ${LOG_DATE[role]})`)
    if (role === 'viewer') {
      check('UI', `${W}: read-only notice shown`, st.deniedShown, `alerts=${JSON.stringify(st.alerts)}`)
      check('UI', `${W}: button "Save report" hidden`, st.ready && !hasButton(st, 'Save report'))
    } else {
      check('UI', `${W}: own task "${desc}" shown`, st.ready && st.values.some((v) => v.includes(desc)), `values=${JSON.stringify(st.values.slice(0, 8))}`)
      check('UI', `${W}: button "Save report" visible`, st.ready && hasButton(st, 'Save report'))
    }
    const team = ['vp', 'manager', 'product'].includes(role)
    check('UI', `${W}: team user picker #user-select ${team ? 'present' : 'absent'}`, (st.selectors['#user-select'] !== 'absent') === team, `state=${st.selectors['#user-select']}`)
    const others = ROLES.filter((r) => r !== role && r !== 'viewer').map((r) => T(`${KEY[r]} task`))
    check('UI', `${W}: no other user's task text in the form`, !st.values.some((v) => others.some((o) => v.includes(o))))
  }
  beginStep('3 work logs', '3.5 manager team view of the developer log', 'manager')
  {
    const page = await pageFor('manager')
    await page.goto('/tasks')
    await page.waitFor(probe, [{ markerSelector: '#report-date' }])
    await sleep(800)
    await page.evaluate(setInputValue, '#report-date', LOG_DATE.developer)
    await sleep(800)
    await page.clickAt(locateSelector, '#user-select')
    const opened = await page.waitFor(hasText, ['[role=option]', `Roleflow developer`, true], 10_000)
    await page.clickAt(locateByText, '[role=option]', 'Roleflow developer', null, true)
    const st = await settle('manager', { markerValue: T('dev task') }, 20_000)
    check('UI', 'UI manager /tasks: user picker lists the developer', opened.ready)
    check('UI', 'UI manager /tasks (user developer, 2001-03-04): developer task shown read-only for the manager', st.ready && st.values.some((v) => v.includes(T('dev task'))), `values=${JSON.stringify(st.values.slice(0, 6))}`)
  }
  beginStep('3 work logs', '3.6 /reports per role', 'all')
  for (const role of ROLES) {
    const allowed = ['vp', 'manager', 'product'].includes(role)
    const st = await visit(role, '/reports', { markerSelector: 'h1', deniedText: D.reports })
    uiExpect(role, '/reports', st, { link: 'Reports', linkShown: allowed, deniedShown: !allowed })
  }
}

// =====================================================================================
// FLOW 4 — wiki (rules: wiki.service.ts:114-123 edit, 144 read open, 174 create, 316-319 delete)
// =====================================================================================

async function wikiRow(id) {
  const [w] = await q`SELECT title, author_id, last_edited_by_id, kind, content, created_at, updated_at FROM wiki_documents WHERE wiki_document_id = ${id ?? ''}`
  return w
}

async function flowWiki() {
  await watchLock('flow 4')
  for (const role of ['qa_engineer', 'product']) {
    beginStep('4 wiki', '4.1 create written doc', role)
    const { res, t0, t1 } = await timed(() => api(role, 'POST', '/api/wiki', { title: T(`wiki ${KEY[role]}`), content: `<p>${T('wiki body')}</p><script>x()</script>`, tags: ['roleflow'] }))
    check('API', `4.1 ${role} POST /api/wiki -> 200`, res.status === 200, short(res))
    const id = res.json?.wikiDocumentId
    F[`w_${role}`] = id
    if (id) ctx.known.wikiDocs.push(id)
    const w = await wikiRow(id)
    check('DB', `4.1 wiki_documents row: author ${role}, written, sanitized content, fresh UTC`, !!w && w.author_id === uid(role) && w.kind === 'written' && String(w.content).includes(T('wiki body')) && !String(w.content).includes('<script') && isFresh(w.created_at, t0, t1) && isFresh(w.updated_at, t0, t1), JSON.stringify(w ? { kind: w.kind, content: String(w.content).slice(0, 80) } : null))
    await checkActivity('4.1', role, 'CREATE', 'wiki_document', id, t0, t1)
    await checkNotifs('4.1', 'wiki_document', id, t0, t1, [])
  }
  for (const role of ['developer', 'viewer']) {
    beginStep('4 wiki', '4.1 create denied', role)
    await denied(`4.1 ${role} POST /api/wiki (no create_wiki_doc)`, role, () => api(role, 'POST', '/api/wiki', { title: T(`wiki denied ${role}`), content: '<p>x</p>' }),
      sigOf(() => q`SELECT COUNT(*) AS n FROM wiki_documents WHERE author_id = ${uid(role)}`))
  }
  beginStep('4 wiki', '4.2 view by every role', 'all')
  for (const role of ROLES) {
    const g = await api(role, 'GET', `/api/wiki?id=${F.w_qa_engineer}`)
    check('API', `4.2 ${role} GET /api/wiki?id=<qa doc> -> 200`, g.status === 200 && g.json?.title === T('wiki qa'), short(g))
  }
  for (const role of ROLES) {
    const create = ['vp', 'manager', 'product', 'qa_engineer'].includes(role)
    let st = await visit(role, '/wiki', { markerSelector: 'h1', markerText: T('wiki qa') })
    uiExpect(role, '/wiki', st, { buttons: { 'New Document': create, 'Upload File': create } })
    const author = role === 'qa_engineer'
    const edit = author || ['vp', 'manager'].includes(role)
    st = await visit(role, `/wiki/${F.w_qa_engineer}`, { markerText: T('wiki body') })
    uiExpect(role, `/wiki/${F.w_qa_engineer}`, st, { buttons: { Edit: edit, Delete: edit } })
  }
  beginStep('4 wiki', '4.3 edit own doc', 'qa_engineer')
  let { res, t0, t1 } = await timed(() => api('qa_engineer', 'PUT', `/api/wiki?id=${F.w_qa_engineer}`, { title: T('wiki qa'), content: `<p>${T('wiki body')} v2</p>` }))
  check('API', '4.3 qa PUT /api/wiki (own) -> 200', res.status === 200, short(res))
  let w = await wikiRow(F.w_qa_engineer)
  check('DB', '4.3 wiki row: content v2, last_edited_by qa, author unchanged, updated_at fresh', !!w && String(w.content).includes('v2') && w.last_edited_by_id === uid('qa_engineer') && w.author_id === uid('qa_engineer') && isFresh(w.updated_at, t0, t1), JSON.stringify(w ? { by: who(w.last_edited_by_id) } : null))
  await checkActivity('4.3', 'qa_engineer', 'UPDATE', 'wiki_document', F.w_qa_engineer, t0, t1)
  beginStep('4 wiki', '4.4 edit someone else\'s doc denied', 'product, developer, viewer')
  const sigW = sigOf(() => q`SELECT title, content, last_edited_by_id, updated_at FROM wiki_documents WHERE wiki_document_id = ${F.w_qa_engineer}`)
  for (const role of ['product', 'developer', 'viewer']) {
    await denied(`4.4 ${role} PUT /api/wiki?id=<qa doc> (no edit_any_wiki_doc)`, role, () => api(role, 'PUT', `/api/wiki?id=${F.w_qa_engineer}`, { title: T('wiki hijack') }), sigW)
  }
  beginStep('4 wiki', '4.5 edit any doc', 'manager')
  ;({ res, t0, t1 } = await timed(() => api('manager', 'PUT', `/api/wiki?id=${F.w_qa_engineer}`, { title: T('wiki qa edited by manager') })))
  check('API', '4.5 manager PUT /api/wiki?id=<qa doc> (edit_any_wiki_doc) -> 200', res.status === 200, short(res))
  w = await wikiRow(F.w_qa_engineer)
  check('DB', '4.5 wiki row: title changed, last_edited_by manager, author still qa, fresh', !!w && w.title === T('wiki qa edited by manager') && w.last_edited_by_id === uid('manager') && w.author_id === uid('qa_engineer') && isFresh(w.updated_at, t0, t1), JSON.stringify(w ? { title: w.title, by: who(w.last_edited_by_id) } : null))
  await checkActivity('4.5', 'manager', 'UPDATE', 'wiki_document', F.w_qa_engineer, t0, t1)
  beginStep('4 wiki', '4.6 delete denied', 'qa_engineer, product, developer')
  const sigP = sigOf(() => q`SELECT COUNT(*) AS n FROM wiki_documents WHERE wiki_document_id = ${F.w_product}`)
  await denied('4.6 qa DELETE product doc (not author, no delete_wiki_doc)', 'qa_engineer', () => api('qa_engineer', 'DELETE', `/api/wiki?id=${F.w_product}`), sigP)
  await denied('4.6 developer DELETE product doc', 'developer', () => api('developer', 'DELETE', `/api/wiki?id=${F.w_product}`), sigP)
  await denied('4.6 product DELETE qa doc', 'product', () => api('product', 'DELETE', `/api/wiki?id=${F.w_qa_engineer}`), sigOf(() => q`SELECT COUNT(*) AS n FROM wiki_documents WHERE wiki_document_id = ${F.w_qa_engineer}`))
  beginStep('4 wiki', '4.7 delete any doc', 'manager')
  ;({ res, t0, t1 } = await timed(() => api('manager', 'DELETE', `/api/wiki?id=${F.w_product}`)))
  check('API', '4.7 manager DELETE product doc (delete_wiki_doc) -> 200', res.status === 200, short(res))
  check('DB', '4.7 wiki row gone', !(await wikiRow(F.w_product)))
  await checkActivity('4.7', 'manager', 'DELETE', 'wiki_document', F.w_product, t0, t1)
  beginStep('4 wiki', '4.8 author deletes own doc', 'qa_engineer')
  ;({ res, t0, t1 } = await timed(() => api('qa_engineer', 'DELETE', `/api/wiki?id=${F.w_qa_engineer}`)))
  check('API', '4.8 qa DELETE own doc (author rule wiki.service.ts:316) -> 200', res.status === 200, short(res))
  check('DB', '4.8 wiki row gone', !(await wikiRow(F.w_qa_engineer)))
  await checkActivity('4.8', 'qa_engineer', 'DELETE', 'wiki_document', F.w_qa_engineer, t0, t1)
  const st = await visit('viewer', `/wiki/${F.w_qa_engineer}`, { markerText: 'not', texts: [T('wiki body')] })
  check('UI', `${where('viewer', `/wiki/${F.w_qa_engineer}`)} after delete: the doc content is not rendered`, !st.has[T('wiki body')])
}

// =====================================================================================
// FLOW 5 — users page (rules: users.service.ts:35,86,118,150; users/route.ts options open)
// =====================================================================================

async function flowUsers() {
  await watchLock('flow 5')
  beginStep('5 users', '5.1 /settings/users per role', 'all')
  for (const role of ROLES) {
    const allowed = ['vp', 'manager'].includes(role)
    const st = await visit(role, '/settings/users', { markerText: allowed ? 'Invite user' : '__never__', deniedText: D.users })
    uiExpect(role, '/settings/users', st, { link: 'Users', linkShown: allowed, deniedShown: !allowed, buttons: { 'Invite user': allowed } })
    const g = await api(role, 'GET', '/api/users?pageSize=5')
    check('API', `5.1 ${role} GET /api/users -> ${allowed ? 200 : 403}`, g.status === (allowed ? 200 : 403), String(g.status))
    const o = await api(role, 'GET', '/api/users?action=options')
    check('API', `5.1 ${role} GET /api/users?action=options -> 200 (picker rows, any user)`, o.status === 200 && Array.isArray(o.json) && !JSON.stringify(o.json).includes('@'), `status=${o.status}`)
  }
  beginStep('5 users', '5.2 invite user', 'manager')
  const email = fixtureEmail(PREFIX, 'invmgr', STAMP)
  ctx.invitedEmails.push(email)
  const pw = `Iv${randomBytes(12).toString('base64url')}7`
  let { res, t0, t1 } = await timed(() => api('manager', 'POST', '/api/users', { email, fullName: 'Roleflow invited', password: pw, role: 'viewer' }))
  check('API', '5.2 manager POST /api/users (viewer) -> 200', res.status === 200 && !JSON.stringify(res.json).includes('passwordHash'), short(res))
  F.inv = res.json?.userId
  const [u] = await q`SELECT user_id, role, is_active, created_at, updated_at FROM users WHERE email = ${email}`
  check('DB', '5.2 users row: viewer, active, fresh UTC', !!u && u.user_id === F.inv && u.role === 'viewer' && Number(u.is_active) === 1 && isFresh(u.created_at, t0, t1) && isFresh(u.updated_at, t0, t1), JSON.stringify(u ? { role: u.role } : null))
  await checkActivity('5.2', 'manager', 'CREATE', 'user', F.inv, t0, t1)
  beginStep('5 users', '5.2 invite / edit denied', 'qa_engineer, developer, product')
  const email2 = fixtureEmail(PREFIX, 'invqa', STAMP)
  ctx.invitedEmails.push(email2)
  await denied('5.2 qa POST /api/users (no manage_users)', 'qa_engineer', () => api('qa_engineer', 'POST', '/api/users', { email: email2, fullName: 'Roleflow denied', password: pw, role: 'viewer' }), sigOf(() => q`SELECT COUNT(*) AS n FROM users WHERE email = ${email2}`))
  const sigU = sigOf(() => q`SELECT full_name, role, is_active, updated_at FROM users WHERE user_id = ${F.inv ?? ''}`)
  await denied('5.2 developer PUT /api/users?id=<invited>', 'developer', () => api('developer', 'PUT', `/api/users?id=${F.inv}`, { fullName: 'Hijack' }), sigU)
  await denied('5.2 product DELETE /api/users?id=<invited>', 'product', () => api('product', 'DELETE', `/api/users?id=${F.inv}`), sigU)
  beginStep('5 users', '5.3 edit user', 'manager')
  ;({ res, t0, t1 } = await timed(() => api('manager', 'PUT', `/api/users?id=${F.inv}`, { fullName: 'Roleflow invited renamed' })))
  check('API', '5.3 manager PUT /api/users?id -> 200', res.status === 200, short(res))
  const [u2] = await q`SELECT full_name, updated_at FROM users WHERE user_id = ${F.inv ?? ''}`
  check('DB', '5.3 users.full_name changed, updated_at fresh', u2?.full_name === 'Roleflow invited renamed' && isFresh(u2?.updated_at, t0, t1), JSON.stringify(u2 ?? null))
  await checkActivity('5.3', 'manager', 'UPDATE', 'user', F.inv, t0, t1)
}

// =====================================================================================
// ISOLATION — notifications + activity (rules: notifications.service.ts:33,54-87; activity-logs.service.ts:31,43,57)
// =====================================================================================

async function flowIsolation() {
  await watchLock('isolation')
  beginStep('6 isolation', '6.1 notifications of someone else', 'qa, developer, viewer')
  const [mn] = await q`SELECT notification_id FROM notifications WHERE user_id = ${uid('manager')} AND entity_type = 'review' AND entity_id = ${F.r1 ?? ''} LIMIT 1`
  const nid = mn?.notification_id
  check('H', 'setup: the manager has a review_assigned notification', !!nid)
  const sigN = sigOf(() => q`SELECT is_read, (SELECT COUNT(*) FROM notifications WHERE notification_id = ${nid ?? ''}) AS n FROM notifications WHERE notification_id = ${nid ?? ''}`)
  await denied('6.1 qa PATCH /api/notifications?id=<manager notification>', 'qa_engineer', () => api('qa_engineer', 'PATCH', `/api/notifications?id=${nid}`), sigN)
  await denied('6.1 qa DELETE /api/notifications?id=<manager notification>', 'qa_engineer', () => api('qa_engineer', 'DELETE', `/api/notifications?id=${nid}`), sigN)
  await denied('6.1 developer PATCH /api/notifications?id=<manager notification>', 'developer', () => api('developer', 'PATCH', `/api/notifications?id=${nid}`), sigN)
  const nf = await api('qa_engineer', 'PATCH', `/api/notifications?id=${MISSING_ID}`)
  check('API', '6.1 qa PATCH unknown notification id -> 404', nf.status === 404, short(nf))
  for (const role of ['viewer', 'qa_engineer', 'developer']) {
    const l = await api(role, 'GET', '/api/notifications?pageSize=100')
    const data = l.json?.data ?? []
    check('API', `6.1 ${role} GET /api/notifications -> own rows only`, l.status === 200 && data.every((x) => x.userId === uid(role)) && !data.some((x) => x.notificationId === nid), `status=${l.status} foreign=${data.filter((x) => x.userId !== uid(role)).length}`)
  }
  const anon = await requestJson('PATCH', `/api/notifications?id=${nid}`, {})
  check('API', '6.1 no session PATCH /api/notifications -> 401', anon.status === 401, short(anon))
  beginStep('6 isolation', '6.2 own notification', 'manager')
  const mine = await api('manager', 'PATCH', `/api/notifications?id=${nid}`)
  const [nr] = await q`SELECT is_read FROM notifications WHERE notification_id = ${nid ?? ''}`
  check('API', '6.2 manager PATCH own notification -> 200', mine.status === 200 && mine.json?.isRead === true, short(mine))
  check('DB', '6.2 notifications.is_read = 1', Number(nr?.is_read) === 1)
  const st = await visit('viewer', '/notifications', { markerSelector: 'h1' })
  check('UI', 'UI viewer /notifications: no review / bug / work-log notification of other users shown', st.ready && !(await (await pageFor('viewer')).evaluate(() => /review needs revision|new review assigned|bug assigned to you|daily work log/i.test(document.body.innerText))))
  beginStep('6 isolation', '6.3 activity of an entity', 'qa_engineer, manager')
  const a1 = await api('qa_engineer', 'GET', `/api/activity-logs?action=entity&type=test_case&id=${F.c1}`)
  check('API', '6.3 qa GET activity ?action=entity of own case -> 403 (view_activity_logs)', a1.status === 403, short(a1))
  const a2 = await api('manager', 'GET', `/api/activity-logs?action=entity&type=test_case&id=${F.c1}`)
  check('API', '6.3 manager GET activity ?action=entity -> 200 with the qa rows', a2.status === 200 && (a2.json ?? []).some((x) => x.userId === uid('qa_engineer')), short(a2))
  const a3 = await api('developer', 'GET', `/api/activity-logs?action=user&id=${uid('qa_engineer')}`)
  check('API', '6.3 developer GET activity ?action=user&id=<qa> -> 403', a3.status === 403, short(a3))
}

/** Last: a role without manage_permissions must not be able to raise itself to VP. */
async function flowSelfPromotion() {
  beginStep('5 users', '5.4 manager raises own role to vp', 'manager')
  const { res } = await timed(() => api('manager', 'PUT', `/api/users?id=${uid('manager')}`, { role: 'vp' }))
  const [u] = await q`SELECT role FROM users WHERE user_id = ${uid('manager')}`
  check('API', '5.4 manager PUT /api/users?id=<self> {role: vp} -> 403 (manager lacks manage_permissions; self deactivation is already blocked, users.service.ts:151)', res.status === 403, short(res))
  check('DB', '5.4 manager row still role manager', u?.role === 'manager', `role=${u?.role}`)
  if (u?.role !== 'manager') {
    const back = await api('vp', 'PUT', `/api/users?id=${uid('manager')}`, { role: 'manager' })
    info(`self-promotion reverted by the fixture VP: status=${back.status}`)
  }
}

/** Every notification the run caused must have been matched by a step check. */
async function auditNotifications(entities) {
  beginStep('7 audit', '7.1 no unexpected notification anywhere', 'all')
  const fixtureIds = ctx.fixtures.map((f) => f.userId)
  const toFixtures = await q`SELECT notification_id, user_id, type, entity_type FROM notifications WHERE ${sqlIn('user_id', fixtureIds)}`
  const extra = toFixtures.filter((n) => !ctx.accounted.has(n.notification_id))
  check('NOTIF', '7.1 every notification of a fixture user was expected by a step', extra.length === 0, JSON.stringify(extra.map((n) => `${who(n.user_id)}:${n.type}:${n.entity_type}`)))
  const e = entities
  const toDemo = await q`SELECT notification_id, user_id, type, entity_type FROM notifications WHERE NOT (${sqlIn('user_id', fixtureIds)}) AND (
      (entity_type = 'test_case' AND ${sqlIn('entity_id', e.cases)}) OR (entity_type = 'review' AND ${sqlIn('entity_id', e.reviews)})
      OR (entity_type = 'module_review' AND ${sqlIn('entity_id', e.moduleReviews)}) OR (entity_type = 'bug' AND ${sqlIn('entity_id', e.bugs)})
      OR (entity_type = 'task_report' AND ${sqlIn('entity_id', e.taskReports)}) OR (entity_type = 'wiki_document' AND ${sqlIn('entity_id', e.wikiDocs)}))`
  const demoBad = toDemo.filter((n) => n.type !== 'daily_report_submitted' || !ctx.accounted.has(n.notification_id))
  check('NOTIF', '7.1 demo accounts received only the by-design work-log notifications (task-reports.service.ts:160-186)', demoBad.length === 0, JSON.stringify(demoBad.map((n) => `${n.type}:${n.entity_type}`)))
  info(`demo work-log notifications caused (deleted in cleanup): ${toDemo.length}`)
}

// ---------- warm-up ----------

async function warmUp() {
  const page = await pageFor('vp')
  for (const p of ['/dashboard', '/modules', '/test-cases', `/test-cases/${MISSING_ID}`, `/reviews/${MISSING_ID}`, `/module-reviews/${MISSING_ID}`, '/reviews', '/bugs', '/tasks', '/reports',
    '/wiki', `/wiki/${MISSING_ID}`, '/notifications', '/settings/users']) {
    await page.goto(p)
    await page.waitFor(probe, [{ markerSelector: 'h1, [data-slot=card]' }], 90_000)
    await sleep(400)
  }
  console.log('      warm-up done')
}

// ---------- cleanup ----------

async function cleanup() {
  console.log('\n=== CLEANUP (SQL by fixture ids and collected ids) ===')
  cur = null
  const db = ctx.db
  for (const p of [...ctx.openPages]) await p.close().catch(() => {})
  if (ctx.chrome) {
    const chromeEnd = await shutdownChrome(ctx.cdp, ctx.chrome, PROFILE_DIR)
    check('H', 'harness: spawned Chrome pid tree gone', chromeEnd.processGone, `left=${chromeEnd.leftovers}`)
    check('H', 'harness: Chrome profile dir removed', chromeEnd.profileRemoved, PROFILE_DIR)
  }
  const emails = [...ctx.fixtures.map((u) => u.email), ...ctx.invitedEmails]
  const found = await findUsersByEmails(db, emails)
  const fixtureIds = [...new Set([...ctx.fixtures.map((u) => u.userId), ...found.map((r) => r.user_id)])]
  const entities = await collectEntities(db, fixtureIds, ctx.known)
  console.log(`      users=${fixtureIds.length} ${Object.entries(entities).map(([k, v]) => `${k}=${v.length}`).join(' ')}`)
  await watchLock('cleanup')
  if (ctx.fixtures.length && ctx.sess.vp) await auditNotifications(entities).catch((err) => check('H', 'audit notifications', false, err.message))
  cur = null
  const counter = { check: (n, c, d) => check('H', n, c, d) }
  await runCleanupStep(counter, 'notifications by entity', async () => ({ ok: true, detail: `${await deleteNotificationsByEntity(db, entities)} deleted` }))
  await runCleanupStep(counter, 'notifications by wiki entity', async () => ({ ok: true, detail: `${await db.$executeRaw`DELETE FROM notifications WHERE entity_type = 'wiki_document' AND ${sqlIn('entity_id', entities.wikiDocs)}`} deleted` }))
  await runCleanupStep(counter, 'bugs', async () => ({ ok: true, detail: `${await deleteBugsByIds(db, entities.bugs)} deleted` }))
  await runCleanupStep(counter, 'test_cases', async () => {
    let n = 0
    for (const id of entities.cases) n += await deleteTestCaseById(db, id)
    return { ok: true, detail: `${n} deleted of ${entities.cases.length}` }
  })
  await runCleanupStep(counter, 'review_requests/module_review_requests by fixture participants', async () => ({ ok: true, detail: `${await deleteReviewsByParticipants(db, fixtureIds)} deleted` }))
  await runCleanupStep(counter, 'wiki_documents', async () => {
    let n = 0
    for (const id of entities.wikiDocs) n += await deleteWikiDocById(db, id)
    return { ok: true, detail: `${n} deleted of ${entities.wikiDocs.length}` }
  })
  await runCleanupStep(counter, 'task_reports', async () => ({ ok: true, detail: `${await db.$executeRaw`DELETE FROM task_reports WHERE ${sqlIn('task_report_id', entities.taskReports)}`} deleted` }))
  await runCleanupStep(counter, 'modules', async () => {
    const dependents = await countModuleDependents(db, entities.modules)
    if (dependents > 0) return { ok: false, detail: `${dependents} case(s)/bug(s) still point at the run modules` }
    return { ok: true, detail: `${await deleteModulesByIds(db, entities.modules)} deleted` }
  })
  // Matrix proof by the API while the fixture VP still exists (nothing was toggled).
  if (ctx.byRole.vp) {
    try {
      const vp = await login(ctx.byRole.vp)
      const res = await requestJson('GET', '/api/permissions', { jar: vp.jar })
      const cells = Array.isArray(res.json) ? res.json : []
      const nonDefault = cells.filter((c) => c.source !== 'default')
      check('H', 'matrix: GET /api/permissions as VP = 126 cells, all source default', cells.length === 126 && nonDefault.length === 0, `cells=${cells.length} nonDefault=${nonDefault.length}`)
      console.log(`MATRIX cells=${cells.length} nonDefault=${nonDefault.length}`)
    } catch (err) {
      check('H', 'matrix: GET /api/permissions as VP = 126 cells, all source default', false, err.message)
    }
  }
  const rp = Number((await q`SELECT COUNT(*) AS n FROM role_permissions`)[0].n)
  check('H', 'matrix: role_permissions table has 0 rows (SQL)', rp === 0, `rows=${rp}`)
  await runCleanupStep(counter, 'activity_logs by fixture user_id', async () => ({ ok: true, detail: `${await deleteActivityLogsByUsers(db, fixtureIds)} deleted` }))
  await runCleanupStep(counter, 'login_attempts by fixture email', async () => ({ ok: true, detail: `${await deleteLoginAttemptsByEmails(db, emails)} deleted` }))
  await runCleanupStep(counter, 'refresh_tokens by fixture user_id', async () => ({ ok: true, detail: `${await db.$executeRaw`DELETE FROM refresh_tokens WHERE ${sqlIn('user_id', fixtureIds)}`} deleted` }))
  await runCleanupStep(counter, 'users (fixtures + invited)', async () => {
    const { deleted, failed } = await deleteUsersByIds(db, fixtureIds)
    return { ok: failed.length === 0, detail: `${deleted} deleted${failed.length ? `; failed: ${failed.join(', ')}` : ''}` }
  })
  console.log('\n=== RESIDUE ===')
  const residue = await countResidue(db, { fixtureIds, emails, entities }, ALL_RESIDUE_TABLES)
  checkResidue(counter, residue)
  const wikiNotif = Number((await q`SELECT COUNT(*) AS n FROM notifications WHERE entity_type = 'wiki_document' AND ${sqlIn('entity_id', entities.wikiDocs)}`)[0].n)
  check('H', 'residue: notifications for the run wiki docs = 0', wikiNotif === 0)
  const tagged = await q`SELECT
      (SELECT COUNT(*) FROM modules WHERE name LIKE ${`${PREFIX} ${STAMP}%`}) AS m,
      (SELECT COUNT(*) FROM test_cases WHERE title LIKE ${`${PREFIX} ${STAMP}%`}) AS c,
      (SELECT COUNT(*) FROM bugs WHERE title LIKE ${`${PREFIX} ${STAMP}%`}) AS b,
      (SELECT COUNT(*) FROM wiki_documents WHERE title LIKE ${`${PREFIX} ${STAMP}%`}) AS w,
      (SELECT COUNT(*) FROM task_reports WHERE report_date >= '2001-03-01' AND report_date < '2001-04-01') AS t,
      (SELECT COUNT(*) FROM users WHERE email LIKE ${`${PREFIX}-%-${STAMP}@tcms.test`}) AS u`
  const t = Object.fromEntries(Object.entries(tagged[0]).map(([k, v]) => [k, Number(v)]))
  check('H', 'residue: 0 rows carry this run\'s stamp (modules, cases, bugs, wiki, March-2001 logs, users)', Object.values(t).every((n) => n === 0), JSON.stringify(t))
}

// ---------- main ----------

function printTable() {
  console.log('\n=== TABLE (flow | step | role | UI | API | DB | NOTIF | failing checks) ===')
  const m = (v) => (v === undefined ? '-' : v ? 'ok' : 'NO')
  for (const r of rows) console.log(`ROW | ${r.flow} | ${r.step} | ${r.role} | ${m(r.cats.UI)} | ${m(r.cats.API)} | ${m(r.cats.DB)} | ${m(r.cats.NOTIF)} | ${r.issues.join(' ; ') || '-'}`)
}

async function runFlow(name, fn) {
  if (state.interrupted || ctx.memAbort) return
  const gb = freeMemGB()
  console.log(`MEMORY before ${name}: free ${gb === null ? '?' : gb.toFixed(2)} GB`)
  if (gb !== null && gb < MIN_FREE_GB_RUN) {
    ctx.memAbort = true
    check('H', `memory: free ${gb.toFixed(2)} GB < ${MIN_FREE_GB_RUN} GB before ${name}: remaining flows skipped, cleanup runs`, false)
    return
  }
  try {
    await fn()
  } catch (err) {
    if (state.interrupted) throw err
    check('H', `${name} aborted: ${err.message}`, false, err.stack?.split('\n').slice(1, 3).join(' | '))
  }
}

async function main() {
  const started = Date.now()
  console.log(`STAMP=${STAMP}`)
  console.log(`PROFILE=${PROFILE_DIR}`)
  const gb0 = freeMemGB()
  console.log(`MEMORY at start: free ${gb0 === null ? '?' : gb0.toFixed(2)} GB (minimum ${MIN_FREE_GB_START} GB)`)
  if (!CLEANUP_STAMP && (gb0 === null || gb0 < MIN_FREE_GB_START)) {
    console.log('NOT RUN: not enough free physical memory (nothing created)')
    return 2
  }
  if (!existsSync(DEFAULT_CHROME)) {
    console.log(`NOT RUN: Chrome not found at ${DEFAULT_CHROME}`)
    return 2
  }
  try {
    ctx.guard = await openGuardedDb()
  } catch (err) {
    if (err instanceof GuardAbort) {
      console.log(`NOT RUN: ${err.message}`)
      return 2
    }
    throw err
  }
  ctx.db = ctx.guard.db
  state = createRunState({ failAt: null, pauseAt: null })
  if (CLEANUP_STAMP) {
    try {
      if (!/^\d{13}$/.test(CLEANUP_STAMP)) { console.log('NOT RUN: --cleanup-stamp must be the 13-digit STAMP'); return 2 }
      const found = await q`SELECT user_id, email, role FROM users WHERE email LIKE ${`${PREFIX}-%-${CLEANUP_STAMP}@tcms.test`}`
      ctx.fixtures = found.map((r) => ({ userId: r.user_id, email: r.email, role: r.role }))
      ctx.invitedEmails = ['invmgr', 'invqa'].map((k) => fixtureEmail(PREFIX, k, CLEANUP_STAMP))
      console.log(`RECOVERY cleanup for STAMP=${CLEANUP_STAMP}: ${found.length} fixture user(s) found`)
      state.cleaning = true
      await cleanup()
      const { rmSync } = await import('node:fs')
      rmSync(PROFILE_DIR, { recursive: true, force: true })
      check('H', 'recovery: Chrome profile dir of the killed run removed', !existsSync(PROFILE_DIR), PROFILE_DIR)
      console.log(`PASS=${totals.pass} FAIL=${totals.fail}`)
      return totals.fail > 0 ? 1 : 0
    } finally {
      process.removeListener('SIGINT', state.onSigint)
      await ctx.guard.release()
    }
  }
  const closeBrowserOnSigint = () => ctx.cdp?.close()
  process.on('SIGINT', closeBrowserOnSigint)
  let exit = null
  try {
    const overrides = await q`SELECT role, action FROM role_permissions`
    if (overrides.length > 0) {
      console.log(`PRECONDITION: ${overrides.length} override row(s)`)
      console.log('NOT RUN: nothing created')
      return 2
    }
    const specs = ROLES.map((role) => ({ key: KEY[role], role, name: `Roleflow ${role}`, email: fixtureEmail(PREFIX, KEY[role], STAMP) }))
    ctx.fixtures = await createFixtureUsers(ctx.db, specs)
    for (const f of ctx.fixtures) ctx.byRole[f.role] = f
    try {
      for (const role of ROLES) ctx.sess[role] = await login(ctx.byRole[role])
      const res = await api('vp', 'GET', '/api/permissions')
      const cells = Array.isArray(res.json) ? res.json : []
      if (cells.length !== 126 || cells.some((c) => c.source !== 'default')) {
        console.log(`PRECONDITION: GET /api/permissions cells=${cells.length} nonDefault=${cells.filter((c) => c.source !== 'default').length}`)
        exit = 2
      } else {
        check('H', 'precondition: GET /api/permissions as fixture VP = 126 cells, all default', true)
        const launched = await launchChrome(PROFILE_DIR, DEFAULT_CHROME, CHROME_LOW_MEMORY_ARGS)
        ctx.chrome = launched.child
        if (!launched.wsUrl) throw new Error('Chrome did not publish DevToolsActivePort')
        ctx.cdp = await Cdp.connect(launched.wsUrl)
        await warmUp()
        await runFlow('flow 1 review', flowReview)
        await runFlow('flow 1 module review', flowModuleReview)
        await runFlow('flow 2 bugs', flowBugs)
        await runFlow('flow 3 work logs', flowWorkLogs)
        await runFlow('flow 4 wiki', flowWiki)
        await runFlow('flow 5 users', flowUsers)
        await runFlow('isolation', flowIsolation)
        await runFlow('self promotion', flowSelfPromotion)
      }
    } catch (err) {
      check('H', state.interrupted ? 'INTERRUPTED (SIGINT)' : `run aborted: ${err.message}`, false)
    } finally {
      state.cleaning = true
      try {
        await cleanup()
      } catch (err) {
        check('H', 'cleanup completed', false, err.message)
      }
    }
    printTable()
    const secs = Math.round((Date.now() - started) / 1000)
    console.log(`\nRUNTIME ${Math.floor(secs / 60)} min ${secs % 60} s`)
    console.log(`PASS=${totals.pass} FAIL=${totals.fail}`)
    if (exit !== null) return exit
    if (state.interrupted) return 130
    if (ctx.memAbort) return 2
    return totals.fail > 0 ? 1 : 0
  } finally {
    process.removeListener('SIGINT', state.onSigint)
    process.removeListener('SIGINT', closeBrowserOnSigint)
    await ctx.guard.release()
  }
}

main().then(
  (code) => { console.log(`EXIT=${code}`); process.exitCode = code },
  (err) => { console.error(`SUITE ERROR: ${err.message}`); process.exitCode = 1 }
)
