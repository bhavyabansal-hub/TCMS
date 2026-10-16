/**
 * PERMISSION TOGGLE END-TO-END SUITE (deep test, tester 1, 2026-10-16).
 *
 * For EVERY action of the matrix (21, src/types/index.ts PERMISSION_ACTIONS) x roles
 * developer, qa_engineer, product (63 cells):
 *   ON   fixture VP PUT /api/permissions {role, action, enabled:true}, wait 3.5 s (cache TTL),
 *        fresh login of the role fixture: session carries the action, sidebar link shown (when
 *        the action gates one), gated page opens (no PermissionDenied), the action's buttons are
 *        visible, the API call answers 200 and REALLY wrote the right row (actor = fixture,
 *        fields, created_at/updated_at between UTC_TIMESTAMP(3) before and after the call)
 *        plus the activity_logs row (user_id, action, entity_type, entity_id).
 *   OFF  VP sets it OFF; the browser context from the ON phase is reloaded (session refresh:
 *        UI must follow the new matrix), then a fresh login: link + buttons hidden, gated page
 *        shows PermissionDenied, API 403, nothing written (row signature + activity count).
 *   Restore the cell to its default; GET shows source 'default'.
 * Read-only actions (view_all_task_reports, view_activity_logs, manage_integrations) check
 * reads (200 vs 403, team data vs own only). EXTRA section: side findings found while mapping.
 *
 * Safety: DB guard + GET_LOCK for the whole run (scripts/lib/db-guard.mjs); precondition
 * role_permissions = 0 rows AND GET /api/permissions = 126 cells all 'default' (else exit 2).
 * Fixture users only (VP + developer + qa_engineer + product, created by SQL, passwords in memory).
 * Every target row is created by this run (VP API or SQL with a fixture author), never demo rows.
 * Crew Desk: GET only. manage_users: creates temp viewer users (deleted at the end).
 * manage_permissions: the role flips viewer/create_bug and back. Cleanup in finally + Ctrl+C:
 * touched cells restored, run rows deleted by id, residue 0 proven, matrix 126 default proven.
 *
 * Usage: node scripts/verify-permission-toggle-e2e.mjs
 *   (debug only: PERMTOGGLE_ACTIONS=a,b PERMTOGGLE_ROLES=developer limit the cells)
 * Exit: 0 all pass, 1 any FAIL, 2 NOT RUN, 130 Ctrl+C.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { GuardAbort, openGuardedDb, sqlIn } from './lib/db-guard.mjs'
import { createFixtureUsers, findUsersByEmails, fixtureEmail } from './lib/fixture-users.mjs'
import {
  BASE,
  PERMISSION_CACHE_WAIT_MS,
  checkResidue,
  createRunState,
  requestJson,
  runCleanupStep,
  sleep,
} from './lib/suite-harness.mjs'
import {
  ALL_RESIDUE_TABLES,
  collectEntities,
  countModuleDependents,
  countResidue,
  deleteActivityLogsByUsers,
  deleteBugsByIds,
  deleteLoginAttemptsByEmails,
  deleteModulesByIds,
  deleteNotificationsByEntity,
  deleteReviewsByParticipants,
  deleteTestCaseById,
  deleteUsersByIds,
  deleteWikiDocById,
  emptyEntities,
  restoreTouchedCells,
} from './lib/suite-data.mjs'
import { DEFAULT_CHROME, Cdp, RolePage, launchChrome, parseSetCookie, shutdownChrome } from './lib/cdp-browser.mjs'

const PREFIX = 'permtoggle'
const STAMP = String(Date.now())
const PROFILE_DIR = path.join(tmpdir(), `tcms-permtoggle-${STAMP}`)
const ROLES = (process.env.PERMTOGGLE_ROLES || 'developer,qa_engineer,product').split(',')
const ROLE_KEY = { vp: 'vp', developer: 'dev', qa_engineer: 'qa', product: 'prod' }
const TODAY = new Date().toISOString().slice(0, 10)
const READY_MS = 40_000

const D = {
  reviews: 'The reviews workspace is only available to roles with perform-review rights. You are assigned as reviewer only when a review is sent to you — ask a manager if you should be able to review.',
  reviewDetail: 'Review details are only available to roles with perform-review rights.',
  integrations: 'Integrations are only available to roles with the manage-integrations permission. A VP can enable it for your role under Permissions.',
  activity: 'The activity log is only available to roles with view-activity-log rights.',
  reports: 'The reports view is only available to roles with view-all-reports rights.',
  users: 'You need administrator privileges to manage users.',
  permissions: 'Only roles with manage-permissions rights can open this panel.',
  tasksN1: 'Your role can view work logs but cannot log work. A VP can enable "Create task reports" for your role under Permissions.',
}

// ---------- run state ----------

const totals = { pass: 0, fail: 0 }
let cellFails = null // array collecting failing check names of the current cell phase
function check(name, cond, detail = '') {
  if (cond) {
    totals.pass++
    console.log(`  ok  ${name}`)
  } else {
    totals.fail++
    console.log(`FAIL  ${name}${detail ? `  (${String(detail).slice(0, 400)})` : ''}`)
    if (cellFails) cellFails.push(name)
  }
  return !!cond
}

const ctx = {
  db: null,
  guard: null,
  fixtures: [],
  byRole: {},
  vp: null,
  matrixDefaults: new Map(), // role:action -> enabled (from the precondition GET)
  touched: new Map(), // role:action -> {role, action}
  known: emptyEntities(),
  invitedEmails: [],
  base: {},
  rows: [],
  cdp: null,
  chrome: null,
  openPages: new Set(),
}
let state = null

// ---------- HTTP ----------

async function login(user, signal) {
  const res = await fetch(`${BASE}/api/auth?path=login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms', Origin: BASE },
    body: JSON.stringify({ email: user.email, password: user.password }),
    signal,
  })
  if (res.status !== 200) throw new Error(`login failed for fixture role ${user.role} (${res.status})`)
  const cookies = (res.headers.getSetCookie?.() ?? []).map(parseSetCookie)
  if (!cookies.some((c) => c.name === 'tcms-access')) throw new Error(`login for fixture role ${user.role} set no tcms-access cookie`)
  const json = await res.json()
  return { jar: cookies.map((c) => `${c.name}=${c.value}`).join('; '), cookies, user: json.user, permissions: json.permissions ?? [] }
}

const req = (method, urlPath, opts = {}) => requestJson(method, urlPath, { ...opts, signal: opts.noSignal ? undefined : state?.signal })

/** VP request; re-login once on 401 (the run outlives the 15 min access token). */
async function vpReq(method, urlPath, body, { noSignal = false } = {}) {
  let res = await req(method, urlPath, { jar: ctx.vp.jar, body, noSignal })
  if (res.status === 401) {
    ctx.vp = await login(ctx.byRole.vp, noSignal ? undefined : state?.signal)
    res = await req(method, urlPath, { jar: ctx.vp.jar, body, noSignal })
  }
  return res
}

async function vpToggle(role, action, enabled) {
  ctx.touched.set(`${role}:${action}`, { role, action })
  return vpReq('PUT', '/api/permissions', { role, action, enabled })
}

async function readCell(role, action) {
  const res = await vpReq('GET', '/api/permissions')
  return Array.isArray(res.json) ? res.json.find((c) => c.role === role && c.action === action) : null
}

// ---------- SQL helpers ----------

const q = (strings, ...values) => ctx.db.$queryRaw(strings, ...values)
async function dbNow() {
  const rows = await q`SELECT UTC_TIMESTAMP(3) AS now`
  return new Date(rows[0].now)
}
const isFresh = (ts, t0, t1) => ts instanceof Date && ts.getTime() >= t0.getTime() - 1000 && ts.getTime() <= t1.getTime() + 1000
const iso = (d) => (d instanceof Date ? d.toISOString() : String(d))

async function activityCount(userId) {
  const rows = await q`SELECT COUNT(*) AS n FROM activity_logs WHERE user_id = ${userId} AND action <> 'LOGIN'`
  return Number(rows[0].n)
}

async function findActivity(userId, action, entityType, entityId, t0) {
  return q`SELECT activity_log_id, created_at FROM activity_logs
    WHERE user_id = ${userId} AND action = ${action} AND entity_type = ${entityType} AND entity_id = ${entityId}
      AND created_at >= ${new Date(t0.getTime() - 1000)}`
}

/** Adds the standard activity_logs check for a write. */
async function checkActivity(label, userId, action, entityType, entityId, t0, t1) {
  const rows = await findActivity(userId, action, entityType, entityId, t0)
  check(`${label} activity_logs ${action} ${entityType} by fixture, fresh`, rows.length >= 1 && isFresh(new Date(rows[0].created_at), t0, t1),
    `rows=${rows.length} entity=${entityId}`)
}

async function sqlOwnCase(authorId, title) {
  const id = randomUUID()
  await ctx.db.$executeRaw`INSERT INTO test_cases (test_case_id, module_id, title, description, steps, priority, status, tags,
      version, author_id, last_edited_by_id, attachments, created_at, updated_at)
    VALUES (${id}, ${ctx.base.moduleId}, ${title}, 'permtoggle own case', CAST('[]' AS JSON), 'P1', 'draft',
      CAST('["permtoggle"]' AS JSON), 1, ${authorId}, ${authorId}, CAST('[]' AS JSON), UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`
  ctx.known.cases.push(id)
  return { id, title }
}

async function sqlOwnWiki(authorId, title) {
  const id = randomUUID()
  await ctx.db.$executeRaw`INSERT INTO wiki_documents (wiki_document_id, title, kind, content, tags, author_id, created_at, updated_at)
    VALUES (${id}, ${title}, 'written', '<p>permtoggle own doc</p>', CAST('[]' AS JSON), ${authorId}, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`
  ctx.known.wikiDocs.push(id)
  return { id, title }
}

// ---------- VP setup helpers (API) ----------

const tag = (what, role, phase) => `${PREFIX} ${STAMP} ${what} ${role} ${phase}`

async function vpCreateModule(name) {
  const res = await vpReq('POST', '/api/modules', { name, description: 'permtoggle target' })
  if (!res.json?.moduleId) throw new Error(`setup: VP module create -> ${res.status}`)
  ctx.known.modules.push(res.json.moduleId)
  return { id: res.json.moduleId, name }
}
async function vpCreateCase(title) {
  const res = await vpReq('POST', '/api/test-cases', { title, moduleId: ctx.base.moduleId, description: 'permtoggle target', priority: 'P1', tags: ['permtoggle'] })
  if (!res.json?.testCaseId) throw new Error(`setup: VP case create -> ${res.status}`)
  ctx.known.cases.push(res.json.testCaseId)
  return { id: res.json.testCaseId, title, updatedAt: res.json.updatedAt }
}
async function vpCreateBug(title) {
  const res = await vpReq('POST', '/api/bugs', { title, moduleId: ctx.base.moduleId, description: 'permtoggle target', severity: 'low' })
  if (!res.json?.bugId) throw new Error(`setup: VP bug create -> ${res.status}`)
  ctx.known.bugs.push(res.json.bugId)
  return { id: res.json.bugId, title, updatedAt: res.json.updatedAt }
}
async function vpCreateWiki(title) {
  const res = await vpReq('POST', '/api/wiki', { title, content: '<p>permtoggle target</p>', tags: [] })
  if (!res.json?.wikiDocumentId) throw new Error(`setup: VP wiki create -> ${res.status}`)
  ctx.known.wikiDocs.push(res.json.wikiDocumentId)
  return { id: res.json.wikiDocumentId, title }
}
async function vpReviewFor(reviewerId, title) {
  const tc = await vpCreateCase(title)
  const res = await vpReq('PUT', `/api/test-cases?id=${tc.id}&action=submit-review`, { reviewerId })
  if (!res.json?.reviewRequestId) throw new Error(`setup: VP submit-review -> ${res.status}`)
  ctx.known.reviews.push(res.json.reviewRequestId)
  return { ...tc, reviewId: res.json.reviewRequestId }
}

// ---------- page-side probes (serialized; must be self-contained) ----------

function probeView(spec) {
  const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim()
  // label span only: the Reviews link appends a pending-count badge
  const nav = [...document.querySelectorAll('aside nav a')].map((a) => text(a.querySelector('span.flex-1') ?? a))
  const alerts = [...document.querySelectorAll('[data-slot=alert-description]')].map(text)
  const deniedShown = spec.deniedText ? alerts.includes(spec.deniedText) : false
  const body = document.body ? document.body.innerText : ''
  const cardTitles = [...document.querySelectorAll('[data-slot=card-title]')].map(text)
  const dialog = document.querySelector('[role=dialog]')
  let markerOk = true
  if (spec.markerText) markerOk = markerOk && body.includes(spec.markerText)
  if (spec.markerSelector) markerOk = markerOk && !!document.querySelector(spec.markerSelector)
  if (spec.markerCardTitle) markerOk = markerOk && cardTitles.includes(spec.markerCardTitle)
  if (spec.markerDialogText) markerOk = markerOk && !!dialog && text(dialog).includes(spec.markerDialogText)
  if (spec.markerDialogEdit) markerOk = markerOk && !!dialog && text(dialog).includes('Edit Bug')
  const scope = spec.scopeSelector ? document.querySelector(spec.scopeSelector) : document
  const buttons = scope ? [...scope.querySelectorAll('button')].map(text).filter(Boolean) : []
  const selectors = {}
  for (const s of spec.selectors || []) selectors[s] = !!document.querySelector(s)
  let assigneeDisabled = null
  if (dialog) {
    const label = [...dialog.querySelectorAll('label')].find((l) => text(l) === 'Assignee')
    const trigger = label?.parentElement?.querySelector('button[role=combobox]')
    if (trigger) assigneeDisabled = trigger.disabled || trigger.hasAttribute('data-disabled')
  }
  return {
    ready: nav.length > 0 && (deniedShown || markerOk),
    path: location.pathname,
    nav,
    alerts,
    deniedShown,
    buttons,
    selectors,
    cardTitles,
    assigneeDisabled,
  }
}

function probeShell() {
  const nav = [...document.querySelectorAll('aside nav a')].map((el) => ((el.querySelector('span.flex-1') ?? el).textContent || '').replace(/\s+/g, ' ').trim())
  return { ready: nav.length > 0, nav, path: location.pathname }
}

function locateByText(selector, wanted, scopeSelector) {
  const scope = scopeSelector ? document.querySelector(scopeSelector) : document
  if (!scope) return null
  const el = [...scope.querySelectorAll(selector)].find((e) => (e.textContent || '').replace(/\s+/g, ' ').trim() === wanted)
  if (!el) return null
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

function hasText(selector, wanted) {
  const found = [...document.querySelectorAll(selector)].some((e) => (e.textContent || '').replace(/\s+/g, ' ').trim() === wanted)
  return { ready: found }
}

// ---------- UI runner ----------

async function openPage(session) {
  const page = await RolePage.open(ctx.cdp, session, BASE, { readyTimeoutMs: READY_MS })
  ctx.openPages.add(page)
  return page
}
async function closePage(page) {
  if (!page) return
  ctx.openPages.delete(page)
  await page.close()
}

/** Visits one view (with its interaction) and returns the final probe state. */
async function visitView(page, view, target) {
  const spec = { ...view.probe(target), deniedText: view.deniedText ?? null, selectors: view.selectors ?? [] }
  await page.goto(view.path(target))
  let st = await page.waitFor(probeView, [spec])
  if (st.ready && !st.deniedShown && view.interact) {
    if (view.interact === 'moduleSelect') {
      const name = target.name
      await page.waitFor(hasText, ['span.flex-1.truncate', name], 20_000)
      await page.clickAt(locateByText, 'span.flex-1.truncate', name)
      st = await page.waitFor(probeView, [{ ...spec, markerCardTitle: name }], 20_000)
    } else if (view.interact === 'bugDialog' || view.interact === 'bugEdit') {
      await page.clickAt(locateByText, '[role=tab]', 'Table')
      await page.waitFor(hasText, ['tbody td', target.title], 20_000)
      await page.clickAt(locateByText, 'tbody td', target.title)
      const dlg = { ...spec, markerDialogText: target.title, scopeSelector: '[role=dialog]' }
      st = await page.waitFor(probeView, [dlg], 20_000)
      if (view.interact === 'bugEdit' && st.ready && st.buttons.includes('Edit')) {
        await page.clickAt(locateByText, 'button', 'Edit', '[role=dialog]')
        st = await page.waitFor(probeView, [{ ...dlg, markerDialogEdit: true }], 20_000)
      }
      spec.scopeSelector = '[role=dialog]'
      spec.markerDialogText = target.title
    }
  }
  await sleep(700)
  const final = await page.evaluate(probeView, spec).catch(() => st)
  return { ...final, ready: st.ready && final.ready }
}

/** Evaluates the UI expectations of one action for the given phase. */
async function checkUi(page, def, target, expectOn, label) {
  let first = true
  for (const view of def.ui) {
    const st = await visitView(page, view, target)
    const where = `${label} UI ${view.path(target).replace(/[0-9a-f-]{36}/, '<id>')}`
    check(`${where}: page ready`, st.ready, `path=${st.path} alerts=${JSON.stringify(st.alerts)}`)
    if (first && def.link) {
      check(`${where}: sidebar "${def.link}" ${expectOn ? 'shown' : 'hidden'}`, st.nav.includes(def.link) === expectOn, `nav=${JSON.stringify(st.nav)}`)
    }
    first = false
    if (view.deniedText) {
      check(`${where}: ${view.deniedIsNotice ? 'read-only notice' : 'PermissionDenied'} ${expectOn ? 'absent' : 'shown'}`, st.deniedShown === !expectOn, `alerts=${JSON.stringify(st.alerts)}`)
    }
    for (const b of view.buttons ?? []) {
      check(`${where}: button "${b}" ${expectOn ? 'visible' : 'hidden'}`, st.ready && st.buttons.includes(b) === expectOn, `buttons=${JSON.stringify(st.buttons.slice(0, 30))}`)
    }
    for (const s of view.selectors ?? []) {
      check(`${where}: ${s} ${expectOn ? 'present' : 'absent'}`, st.ready && st.selectors[s] === expectOn)
    }
    for (const c of view.cardTitles ?? []) {
      check(`${where}: card "${c}" ${expectOn ? 'rendered' : 'not rendered'}`, st.ready && st.cardTitles.includes(c) === expectOn, `cards=${JSON.stringify(st.cardTitles)}`)
    }
    if (view.assignee) {
      check(`${where}: assignee picker ${expectOn ? 'enabled' : 'disabled'}`, st.assigneeDisabled === !expectOn, `assigneeDisabled=${st.assigneeDisabled}`)
    }
  }
}

// ---------- the 21 action definitions (mapping cited in docs/qa/DEEP-TEST-2026-10-16.md (Appendix A)) ----------

const ok200 = (res) => res.status === 200

function buildDefs() {
  const vpId = () => ctx.byRole.vp.userId
  return {
    create_module: {
      ui: [{ path: () => '/modules', probe: () => ({ markerText: 'Module Tree' }), buttons: ['New Root Module'] }],
      api: (s, t, role, phase) => req('POST', '/api/modules', { jar: s.jar, body: { name: tag('module', role, phase), description: 'permtoggle' } }),
      async verifyOn(res, t, uid, t0, t1, L) {
        const id = res.json?.moduleId
        if (id) ctx.known.modules.push(id)
        const [r] = await q`SELECT name, created_by_id, owner_id, created_at, updated_at FROM modules WHERE module_id = ${id ?? ''}`
        check(`${L} DB modules row: created_by_id = owner_id = fixture, name`, !!r && r.created_by_id === uid && r.owner_id === uid && r.name === res.json?.name, JSON.stringify(r ?? null))
        check(`${L} DB modules created_at/updated_at fresh UTC`, !!r && isFresh(r.created_at, t0, t1) && isFresh(r.updated_at, t0, t1), r ? `${iso(r.created_at)} t0=${iso(t0)}` : '')
        await checkActivity(L, uid, 'CREATE', 'module', id, t0, t1)
      },
      sig: async (t, uid) => JSON.stringify(await q`SELECT COUNT(*) AS n FROM modules WHERE created_by_id = ${uid}`, (k, v) => (typeof v === 'bigint' ? Number(v) : v)),
    },
    edit_module: {
      setup: (role, phase) => vpCreateModule(tag('edit-module target', role, phase)),
      ui: [{ path: () => '/modules', probe: () => ({ markerText: 'Module Tree' }), interact: 'moduleSelect', buttons: ['Edit'] }],
      api: (s, t, role) => req('PUT', `/api/modules?id=${t.id}`, { jar: s.jar, body: { description: `edited by ${role}` } }),
      async verifyOn(res, t, uid, t0, t1, L, role) {
        const [r] = await q`SELECT name, description, created_by_id, updated_by_id, updated_at FROM modules WHERE module_id = ${t.id}`
        check(`${L} DB modules row: description changed, updated_by_id = fixture, created_by_id = VP`, !!r && r.description === `edited by ${role}` && r.updated_by_id === uid && r.created_by_id === vpId(), JSON.stringify(r ?? null))
        check(`${L} DB modules updated_at fresh UTC`, !!r && isFresh(r.updated_at, t0, t1), r ? iso(r.updated_at) : '')
        await checkActivity(L, uid, 'UPDATE', 'module', t.id, t0, t1)
      },
      sig: async (t) => JSON.stringify(await q`SELECT description, updated_by_id, updated_at FROM modules WHERE module_id = ${t.id}`),
    },
    create_test_case: {
      ui: [{ path: () => '/test-cases', probe: () => ({ markerText: 'All Test Cases' }), buttons: ['New Test Case', 'Import CSV'] }],
      api: (s, t, role, phase) => req('POST', '/api/test-cases', { jar: s.jar, body: { title: tag('case', role, phase), moduleId: ctx.base.moduleId, description: 'permtoggle create', priority: 'P1', tags: ['permtoggle'] } }),
      async verifyOn(res, t, uid, t0, t1, L) {
        const id = res.json?.testCaseId
        if (id) ctx.known.cases.push(id)
        const [r] = await q`SELECT title, author_id, last_edited_by_id, module_id, priority, status, version, created_at, updated_at FROM test_cases WHERE test_case_id = ${id ?? ''}`
        check(`${L} DB test_cases row: author_id = last_edited_by_id = fixture, module, P1, draft, v1`,
          !!r && r.author_id === uid && r.last_edited_by_id === uid && r.module_id === ctx.base.moduleId && r.priority === 'P1' && r.status === 'draft' && Number(r.version) === 1, JSON.stringify(r ?? null))
        check(`${L} DB test_cases created_at/updated_at fresh UTC`, !!r && isFresh(r.created_at, t0, t1) && isFresh(r.updated_at, t0, t1), r ? iso(r.created_at) : '')
        await checkActivity(L, uid, 'CREATE', 'test_case', id, t0, t1)
      },
      sig: async (t, uid) => String(Number((await q`SELECT COUNT(*) AS n FROM test_cases WHERE author_id = ${uid}`)[0].n)),
    },
    edit_own_test_case: {
      setup: (role, phase) => sqlOwnCase(ctx.byRole[role].userId, tag('own case', role, phase)),
      ui: [{ path: (t) => `/test-cases/${t.id}`, probe: (t) => ({ markerText: t.title }), buttons: ['Edit'] }],
      api: (s, t) => req('PUT', `/api/test-cases?id=${t.id}`, { jar: s.jar, body: { title: `${t.title} edited` } }),
      verifyOn: (res, t, uid, t0, t1, L) => verifyCaseEdit(t, uid, t0, t1, L),
      sig: async (t) => JSON.stringify(await q`SELECT title, version, updated_at FROM test_cases WHERE test_case_id = ${t.id}`),
    },
    edit_any_test_case: {
      setup: (role, phase) => vpCreateCase(tag('any case', role, phase)),
      ui: [{ path: (t) => `/test-cases/${t.id}`, probe: (t) => ({ markerText: t.title }), buttons: ['Edit'] }],
      api: (s, t) => req('PUT', `/api/test-cases?id=${t.id}`, { jar: s.jar, body: { title: `${t.title} edited` } }),
      verifyOn: (res, t, uid, t0, t1, L) => verifyCaseEdit(t, uid, t0, t1, L),
      sig: async (t) => JSON.stringify(await q`SELECT title, version, updated_at FROM test_cases WHERE test_case_id = ${t.id}`),
    },
    delete_test_case: {
      setup: (role, phase) => vpCreateCase(tag('delete case', role, phase)),
      ui: [
        { path: (t) => `/test-cases/${t.id}`, probe: (t) => ({ markerText: t.title }), buttons: ['Delete'] },
        { path: () => '/test-cases', probe: () => ({ markerSelector: 'tbody tr' }), selectors: ['[aria-label="Select all on this page"]'] },
      ],
      api: (s, t) => req('DELETE', `/api/test-cases?id=${t.id}`, { jar: s.jar }),
      async verifyOn(res, t, uid, t0, t1, L) {
        const n = Number((await q`SELECT COUNT(*) AS n FROM test_cases WHERE test_case_id = ${t.id}`)[0].n)
        check(`${L} DB test_cases row removed`, n === 0, `rows=${n}`)
        await checkActivity(L, uid, 'DELETE', 'test_case', t.id, t0, t1)
      },
      sig: async (t) => String(Number((await q`SELECT COUNT(*) AS n FROM test_cases WHERE test_case_id = ${t.id}`)[0].n)),
    },
    submit_review: {
      setup: (role, phase) => vpCreateCase(tag('submit case', role, phase)),
      ui: [{ path: (t) => `/test-cases/${t.id}`, probe: (t) => ({ markerText: t.title }), buttons: ['Submit for Review'] }],
      api: (s, t) => req('PUT', `/api/test-cases?id=${t.id}&action=submit-review`, { jar: s.jar, body: { reviewerId: vpId() } }),
      async verifyOn(res, t, uid, t0, t1, L) {
        const id = res.json?.reviewRequestId
        if (id) ctx.known.reviews.push(id)
        const [r] = await q`SELECT test_case_id, requester_id, reviewer_id, status, cycle, created_at FROM review_requests WHERE review_request_id = ${id ?? ''}`
        check(`${L} DB review_requests row: requester_id = fixture, reviewer = VP, pending, cycle 1`,
          !!r && r.test_case_id === t.id && r.requester_id === uid && r.reviewer_id === vpId() && r.status === 'pending' && Number(r.cycle) === 1, JSON.stringify(r ?? null))
        check(`${L} DB review_requests created_at fresh UTC`, !!r && isFresh(r.created_at, t0, t1), r ? iso(r.created_at) : '')
        const [c] = await q`SELECT status FROM test_cases WHERE test_case_id = ${t.id}`
        check(`${L} DB test case status in_review`, c?.status === 'in_review', c?.status)
        await checkActivity(L, uid, 'REVIEW_SUBMITTED', 'test_case', t.id, t0, t1)
      },
      sig: async (t) => JSON.stringify([Number((await q`SELECT COUNT(*) AS n FROM review_requests WHERE test_case_id = ${t.id}`)[0].n), (await q`SELECT status FROM test_cases WHERE test_case_id = ${t.id}`)[0]?.status]),
    },
    perform_review: {
      link: 'Reviews',
      setup: (role, phase) => vpReviewFor(ctx.byRole[role].userId, tag('review case', role, phase)),
      ui: [
        { path: () => '/reviews', probe: () => ({ markerSelector: 'h1' }), deniedText: D.reviews },
        { path: (t) => `/reviews/${t.reviewId}`, probe: (t) => ({ markerText: t.title }), deniedText: D.reviewDetail, buttons: ['Approve'] },
      ],
      api: (s, t) => req('POST', `/api/reviews?id=${t.reviewId}`, { jar: s.jar, body: { verdict: 'approved', comment: 'permtoggle approve' } }),
      async verifyOn(res, t, uid, t0, t1, L) {
        const [e] = await q`SELECT reviewer_id, verdict, created_at FROM review_events WHERE review_request_id = ${t.reviewId}`
        check(`${L} DB review_events row: reviewer_id = fixture, verdict approved`, !!e && e.reviewer_id === uid && e.verdict === 'approved', JSON.stringify(e ?? null))
        check(`${L} DB review_events created_at fresh UTC`, !!e && isFresh(e.created_at, t0, t1), e ? iso(e.created_at) : '')
        const [r] = await q`SELECT status, updated_at FROM review_requests WHERE review_request_id = ${t.reviewId}`
        const [c] = await q`SELECT status FROM test_cases WHERE test_case_id = ${t.id}`
        check(`${L} DB review completed + case approved, review updated_at fresh`, r?.status === 'completed' && c?.status === 'approved' && isFresh(r?.updated_at, t0, t1), `${r?.status}/${c?.status} ${iso(r?.updated_at)}`)
        await checkActivity(L, uid, 'REVIEW_VERDICT', 'test_case', t.id, t0, t1)
      },
      sig: async (t) => JSON.stringify([Number((await q`SELECT COUNT(*) AS n FROM review_events WHERE review_request_id = ${t.reviewId}`)[0].n), (await q`SELECT status FROM review_requests WHERE review_request_id = ${t.reviewId}`)[0]?.status]),
    },
    create_bug: {
      ui: [{ path: () => '/bugs', probe: () => ({ markerText: 'Export CSV' }), buttons: ['Report Bug'] }],
      api: (s, t, role, phase) => req('POST', '/api/bugs', { jar: s.jar, body: { title: tag('bug', role, phase), moduleId: ctx.base.moduleId, description: 'permtoggle bug', severity: 'high' } }),
      async verifyOn(res, t, uid, t0, t1, L) {
        const id = res.json?.bugId
        if (id) ctx.known.bugs.push(id)
        const [r] = await q`SELECT reported_by_id, severity, status, module_id, created_at, updated_at FROM bugs WHERE bug_id = ${id ?? ''}`
        check(`${L} DB bugs row: reported_by_id = fixture, high, open, module`, !!r && r.reported_by_id === uid && r.severity === 'high' && r.status === 'open' && r.module_id === ctx.base.moduleId, JSON.stringify(r ?? null))
        check(`${L} DB bugs created_at/updated_at fresh UTC`, !!r && isFresh(r.created_at, t0, t1) && isFresh(r.updated_at, t0, t1), r ? iso(r.created_at) : '')
        await checkActivity(L, uid, 'CREATE', 'bug', id, t0, t1)
      },
      sig: async (t, uid) => String(Number((await q`SELECT COUNT(*) AS n FROM bugs WHERE reported_by_id = ${uid}`)[0].n)),
    },
    delete_bug: {
      setup: (role, phase) => vpCreateBug(tag('delete bug', role, phase)),
      ui: [{ path: () => '/bugs', probe: () => ({ markerText: 'Export CSV' }), interact: 'bugDialog', buttons: ['Delete'] }],
      api: (s, t) => req('DELETE', `/api/bugs?id=${t.id}`, { jar: s.jar }),
      async verifyOn(res, t, uid, t0, t1, L) {
        const n = Number((await q`SELECT COUNT(*) AS n FROM bugs WHERE bug_id = ${t.id}`)[0].n)
        check(`${L} DB bugs row removed`, n === 0, `rows=${n}`)
        await checkActivity(L, uid, 'DELETE', 'bug', t.id, t0, t1)
      },
      sig: async (t) => String(Number((await q`SELECT COUNT(*) AS n FROM bugs WHERE bug_id = ${t.id}`)[0].n)),
    },
    assign_bug: {
      setup: (role, phase) => vpCreateBug(tag('assign bug', role, phase)),
      ui: [{ path: () => '/bugs', probe: () => ({ markerText: 'Export CSV' }), interact: 'bugEdit', assignee: true }],
      api: (s, t) => req('PUT', `/api/bugs?id=${t.id}`, { jar: s.jar, body: { assignedToId: vpId() } }),
      async verifyOn(res, t, uid, t0, t1, L) {
        const [r] = await q`SELECT assigned_to_id, updated_at FROM bugs WHERE bug_id = ${t.id}`
        check(`${L} DB bugs.assigned_to_id = VP fixture`, r?.assigned_to_id === vpId(), JSON.stringify(r ?? null))
        check(`${L} DB bugs updated_at fresh UTC`, !!r && isFresh(r.updated_at, t0, t1), r ? iso(r.updated_at) : '')
        await checkActivity(L, uid, 'UPDATE', 'bug', t.id, t0, t1)
      },
      sig: async (t) => JSON.stringify(await q`SELECT assigned_to_id, updated_at FROM bugs WHERE bug_id = ${t.id}`),
    },
    create_task_report: {
      ui: [{ path: () => '/tasks', probe: () => ({ markerSelector: '#report-date', markerText: 'Export CSV' }), buttons: ['Save report', 'Add task'], deniedText: D.tasksN1, deniedIsNotice: true }],
      api: (s, t, role, phase) => req('POST', '/api/task-reports', { jar: s.jar, body: { reportDate: TODAY, tasks: [{ description: tag('task', role, phase), timeSpentMinutes: 30, status: 'done' }] } }),
      async verifyOn(res, t, uid, t0, t1, L) {
        const id = res.json?.taskReportId
        if (id) ctx.known.taskReports.push(id)
        const [r] = await q`SELECT reported_by_id, total_minutes, report_date, created_at, updated_at FROM task_reports WHERE task_report_id = ${id ?? ''}`
        check(`${L} DB task_reports row: reported_by_id = fixture, total 30, date ${TODAY}`, !!r && r.reported_by_id === uid && Number(r.total_minutes) === 30 && iso(r.report_date).slice(0, 10) === TODAY, JSON.stringify(r ?? null))
        check(`${L} DB task_reports created_at/updated_at fresh UTC`, !!r && isFresh(r.created_at, t0, t1) && isFresh(r.updated_at, t0, t1), r ? iso(r.created_at) : '')
        await checkActivity(L, uid, 'CREATE', 'task_report', id, t0, t1)
      },
      sig: async (t, uid) => String(Number((await q`SELECT COUNT(*) AS n FROM task_reports WHERE reported_by_id = ${uid}`)[0].n)),
    },
    view_all_task_reports: {
      link: 'Reports',
      readOnly: true,
      ui: [
        { path: () => '/reports', probe: () => ({ markerSelector: 'h1' }), deniedText: D.reports },
        { path: () => '/tasks', probe: () => ({ markerSelector: '#report-date' }), selectors: ['#user-select'] },
      ],
      api: (s) => req('GET', '/api/task-reports?action=summary', { jar: s.jar }),
      async verifyOn(res, t, uid, t0, t1, L, role, s) {
        const stats = await req('GET', '/api/stats?action=reports', { jar: s.jar })
        check(`${L} GET /api/stats?action=reports -> 200`, stats.status === 200, String(stats.status))
        const list = await req('GET', `/api/task-reports?userId=${vpId()}`, { jar: s.jar })
        const ids = (list.json?.data ?? []).map((r) => r.taskReportId)
        check(`${L} team data: list ?userId=<VP> returns the VP fixture report`, list.status === 200 && ids.includes(ctx.base.vpReportId), `status=${list.status} ids=${ids.length}`)
      },
      async verifyOff(res, t, uid, L, s) {
        const stats = await req('GET', '/api/stats?action=reports', { jar: s.jar })
        check(`${L} GET /api/stats?action=reports -> 403`, stats.status === 403, String(stats.status))
        const list = await req('GET', `/api/task-reports?userId=${vpId()}`, { jar: s.jar })
        const rows = list.json?.data ?? []
        check(`${L} own only: list ?userId=<VP> returns no foreign report`, list.status === 200 && rows.every((r) => r.reportedById === uid), `status=${list.status} foreign=${rows.filter((r) => r.reportedById !== uid).length}`)
      },
      sig: async () => 'read-only',
    },
    view_activity_logs: {
      link: 'Activity Log',
      readOnly: true,
      ui: [
        { path: () => '/activity-log', probe: () => ({ markerSelector: 'h1' }), deniedText: D.activity },
        { path: () => `/test-cases/${ctx.base.caseId}`, probe: () => ({ markerText: ctx.base.caseTitle }), cardTitles: ['Activity'] },
      ],
      api: (s) => req('GET', '/api/activity-logs?pageSize=5', { jar: s.jar }),
      async verifyOn(res, t, uid, t0, t1, L, role, s) {
        const others = await req('GET', `/api/activity-logs?action=user&id=${vpId()}`, { jar: s.jar })
        check(`${L} team data: ?action=user&id=<VP> -> 200 with VP rows`, others.status === 200 && JSON.stringify(others.json).includes(vpId()), String(others.status))
        const ent = await req('GET', `/api/activity-logs?action=entity&type=test_case&id=${ctx.base.caseId}`, { jar: s.jar })
        check(`${L} ?action=entity -> 200`, ent.status === 200, String(ent.status))
      },
      async verifyOff(res, t, uid, L, s) {
        const others = await req('GET', `/api/activity-logs?action=user&id=${vpId()}`, { jar: s.jar })
        check(`${L} ?action=user&id=<VP> -> 403`, others.status === 403, String(others.status))
        const ent = await req('GET', `/api/activity-logs?action=entity&type=test_case&id=${ctx.base.caseId}`, { jar: s.jar })
        check(`${L} ?action=entity -> 403`, ent.status === 403, String(ent.status))
      },
      sig: async () => 'read-only',
    },
    manage_integrations: {
      link: 'Integrations',
      readOnly: true,
      ui: [{ path: () => '/integrations', probe: () => ({ markerSelector: 'h1' }), deniedText: D.integrations }],
      // GET ONLY — never POST to the Crew Desk integration.
      api: (s) => req('GET', '/api/integrations/crewdesk?path=config', { jar: s.jar }),
      async verifyOn(res, t, uid, t0, t1, L, role, s) {
        const list = await req('GET', '/api/integrations/crewdesk?pageSize=5', { jar: s.jar })
        check(`${L} GET crewdesk link list -> 200`, list.status === 200, String(list.status))
      },
      async verifyOff(res, t, uid, L, s) {
        const list = await req('GET', '/api/integrations/crewdesk?pageSize=5', { jar: s.jar })
        check(`${L} GET crewdesk link list -> 403`, list.status === 403, String(list.status))
      },
      sig: async () => 'read-only',
    },
    manage_users: {
      link: 'Users',
      setup: (role, phase) => {
        const email = fixtureEmail(PREFIX, `inv${ROLE_KEY[role]}${phase}`, STAMP)
        ctx.invitedEmails.push(email)
        return { email }
      },
      ui: [{ path: () => '/settings/users', probe: () => ({ markerSelector: 'h1' }), deniedText: D.users, buttons: ['Invite user'] }],
      api: (s, t, role) => req('POST', '/api/users', { jar: s.jar, body: { email: t.email, fullName: `Permtoggle invited by ${role}`, password: `Iv${randomBytes(12).toString('base64url')}7`, role: 'viewer' } }),
      async verifyOn(res, t, uid, t0, t1, L, role, s) {
        const [r] = await q`SELECT user_id, role, is_active, created_at, updated_at FROM users WHERE email = ${t.email}`
        check(`${L} DB users row: temp user, role viewer, active`, !!r && r.role === 'viewer' && Number(r.is_active) === 1 && r.user_id === res.json?.userId, JSON.stringify(r ? { role: r.role, active: Number(r.is_active) } : null))
        check(`${L} DB users created_at/updated_at fresh UTC`, !!r && isFresh(r.created_at, t0, t1) && isFresh(r.updated_at, t0, t1), r ? iso(r.created_at) : '')
        if (r) await checkActivity(L, uid, 'CREATE', 'user', r.user_id, t0, t1)
        const list = await req('GET', '/api/users?pageSize=1', { jar: s.jar })
        check(`${L} GET /api/users -> 200`, list.status === 200, String(list.status))
      },
      async verifyOff(res, t, uid, L, s) {
        const list = await req('GET', '/api/users?pageSize=1', { jar: s.jar })
        check(`${L} GET /api/users -> 403`, list.status === 403, String(list.status))
      },
      sig: async (t) => String(Number((await q`SELECT COUNT(*) AS n FROM users WHERE email = ${t.email}`)[0].n)),
    },
    manage_permissions: {
      link: 'Permissions',
      ui: [{ path: () => '/settings/permissions', probe: () => ({ markerSelector: '[role=switch]' }), deniedText: D.permissions }],
      api: (s) => {
        ctx.touched.set('viewer:create_bug', { role: 'viewer', action: 'create_bug' })
        return req('PUT', '/api/permissions', { jar: s.jar, body: { role: 'viewer', action: 'create_bug', enabled: true } })
      },
      async verifyOn(res, t, uid, t0, t1, L, role, s) {
        const [r] = await q`SELECT enabled, updated_by_id, updated_at FROM role_permissions WHERE role = 'viewer' AND action = 'create_bug'`
        check(`${L} DB role_permissions viewer/create_bug: enabled 1, updated_by_id = fixture`, !!r && Number(r.enabled) === 1 && r.updated_by_id === uid, JSON.stringify(r ? { enabled: Number(r.enabled), by: r.updated_by_id === uid } : null))
        check(`${L} DB role_permissions updated_at fresh UTC`, !!r && isFresh(r.updated_at, t0, t1), r ? iso(r.updated_at) : '')
        await checkActivity(L, uid, 'UPDATE', 'role_permission', 'viewer:create_bug', t0, t1)
        const back = await req('PUT', '/api/permissions', { jar: s.jar, body: { role: 'viewer', action: 'create_bug', enabled: false } })
        const left = Number((await q`SELECT COUNT(*) AS n FROM role_permissions WHERE role = 'viewer' AND action = 'create_bug'`)[0].n)
        check(`${L} role toggles viewer/create_bug back -> 200, override row gone`, back.status === 200 && left === 0, `status=${back.status} rows=${left}`)
        const get = await req('GET', '/api/permissions', { jar: s.jar })
        check(`${L} GET /api/permissions as role -> 200, 126 cells`, get.status === 200 && Array.isArray(get.json) && get.json.length === 126, String(get.status))
      },
      async verifyOff(res, t, uid, L, s) {
        const get = await req('GET', '/api/permissions', { jar: s.jar })
        check(`${L} GET /api/permissions as role -> 403`, get.status === 403, String(get.status))
      },
      sig: async () => String(Number((await q`SELECT COUNT(*) AS n FROM role_permissions WHERE role = 'viewer' AND action = 'create_bug'`)[0].n)),
    },
    create_wiki_doc: {
      ui: [{ path: () => '/wiki', probe: () => ({ markerSelector: 'h1' }), buttons: ['New Document', 'Upload File'] }],
      api: (s, t, role, phase) => req('POST', '/api/wiki', { jar: s.jar, body: { title: tag('wiki', role, phase), content: '<p>permtoggle wiki</p>', tags: ['permtoggle'] } }),
      async verifyOn(res, t, uid, t0, t1, L) {
        const id = res.json?.wikiDocumentId
        if (id) ctx.known.wikiDocs.push(id)
        const [r] = await q`SELECT author_id, kind, content, created_at, updated_at FROM wiki_documents WHERE wiki_document_id = ${id ?? ''}`
        check(`${L} DB wiki_documents row: author_id = fixture, written, content stored`, !!r && r.author_id === uid && r.kind === 'written' && String(r.content).includes('permtoggle wiki'), JSON.stringify(r ? { kind: r.kind } : null))
        check(`${L} DB wiki_documents created_at/updated_at fresh UTC`, !!r && isFresh(r.created_at, t0, t1) && isFresh(r.updated_at, t0, t1), r ? iso(r.created_at) : '')
        await checkActivity(L, uid, 'CREATE', 'wiki_document', id, t0, t1)
      },
      sig: async (t, uid) => String(Number((await q`SELECT COUNT(*) AS n FROM wiki_documents WHERE author_id = ${uid}`)[0].n)),
    },
    edit_own_wiki_doc: {
      setup: (role, phase) => sqlOwnWiki(ctx.byRole[role].userId, tag('own wiki', role, phase)),
      ui: [{ path: (t) => `/wiki/${t.id}`, probe: (t) => ({ markerText: t.title }), buttons: ['Edit'] }],
      api: (s, t) => req('PUT', `/api/wiki?id=${t.id}`, { jar: s.jar, body: { title: `${t.title} edited` } }),
      verifyOn: (res, t, uid, t0, t1, L) => verifyWikiEdit(t, uid, t0, t1, L),
      sig: async (t) => JSON.stringify(await q`SELECT title, updated_at FROM wiki_documents WHERE wiki_document_id = ${t.id}`),
    },
    edit_any_wiki_doc: {
      setup: (role, phase) => vpCreateWiki(tag('any wiki', role, phase)),
      ui: [{ path: (t) => `/wiki/${t.id}`, probe: (t) => ({ markerText: t.title }), buttons: ['Edit'] }],
      api: (s, t) => req('PUT', `/api/wiki?id=${t.id}`, { jar: s.jar, body: { title: `${t.title} edited` } }),
      verifyOn: (res, t, uid, t0, t1, L) => verifyWikiEdit(t, uid, t0, t1, L),
      sig: async (t) => JSON.stringify(await q`SELECT title, updated_at FROM wiki_documents WHERE wiki_document_id = ${t.id}`),
    },
    delete_wiki_doc: {
      setup: (role, phase) => vpCreateWiki(tag('delete wiki', role, phase)),
      ui: [{ path: (t) => `/wiki/${t.id}`, probe: (t) => ({ markerText: t.title }), buttons: ['Delete'] }],
      api: (s, t) => req('DELETE', `/api/wiki?id=${t.id}`, { jar: s.jar }),
      async verifyOn(res, t, uid, t0, t1, L) {
        const n = Number((await q`SELECT COUNT(*) AS n FROM wiki_documents WHERE wiki_document_id = ${t.id}`)[0].n)
        check(`${L} DB wiki_documents row removed`, n === 0, `rows=${n}`)
        await checkActivity(L, uid, 'DELETE', 'wiki_document', t.id, t0, t1)
      },
      sig: async (t) => String(Number((await q`SELECT COUNT(*) AS n FROM wiki_documents WHERE wiki_document_id = ${t.id}`)[0].n)),
    },
  }
}

async function verifyCaseEdit(t, uid, t0, t1, L) {
  const [r] = await q`SELECT title, version, last_edited_by_id, updated_at FROM test_cases WHERE test_case_id = ${t.id}`
  check(`${L} DB test_cases row: title changed, version 2, last_edited_by_id = fixture`, !!r && r.title === `${t.title} edited` && Number(r.version) === 2 && r.last_edited_by_id === uid, JSON.stringify(r ? { v: Number(r.version), byFixture: r.last_edited_by_id === uid } : null))
  check(`${L} DB test_cases updated_at fresh UTC`, !!r && isFresh(r.updated_at, t0, t1), r ? iso(r.updated_at) : '')
  const [h] = await q`SELECT version, changed_by_id, created_at FROM test_case_history WHERE test_case_id = ${t.id} ORDER BY created_at DESC LIMIT 1`
  check(`${L} DB test_case_history snapshot v1 by fixture, fresh`, !!h && Number(h.version) === 1 && h.changed_by_id === uid && isFresh(h.created_at, t0, t1), JSON.stringify(h ? { v: Number(h.version) } : null))
  await checkActivity(L, uid, 'UPDATE', 'test_case', t.id, t0, t1)
}

async function verifyWikiEdit(t, uid, t0, t1, L) {
  const [r] = await q`SELECT title, last_edited_by_id, updated_at FROM wiki_documents WHERE wiki_document_id = ${t.id}`
  check(`${L} DB wiki_documents row: title changed, last_edited_by_id = fixture`, !!r && r.title === `${t.title} edited` && r.last_edited_by_id === uid, JSON.stringify(r ? { byFixture: r.last_edited_by_id === uid } : null))
  check(`${L} DB wiki_documents updated_at fresh UTC`, !!r && isFresh(r.updated_at, t0, t1), r ? iso(r.updated_at) : '')
  await checkActivity(L, uid, 'UPDATE', 'wiki_document', t.id, t0, t1)
}

// ---------- one cell ----------

async function runPhaseApiOn(def, s, target, role, phase, L) {
  const uid = ctx.byRole[role].userId
  const t0 = await dbNow()
  const res = await def.api(s, target, role, phase)
  const t1 = await dbNow()
  check(`${L} API -> 200`, ok200(res), `status=${res.status} ${JSON.stringify(res.json).slice(0, 160)}`)
  if (ok200(res)) await def.verifyOn(res, target, uid, t0, t1, L, role, s)
  if (def.readOnly) {
    // reads never log: nothing may be written by the read probes
    check(`${L} read-only: no activity_logs row written in the phase`, (await findActivitySince(uid, t0)).length === 0)
  }
}

async function findActivitySince(uid, t0) {
  return q`SELECT activity_log_id FROM activity_logs WHERE user_id = ${uid} AND action <> 'LOGIN' AND created_at >= ${new Date(t0.getTime() - 500)}`
}

async function runPhaseApiOff(def, s, target, role, phase, L) {
  const uid = ctx.byRole[role].userId
  const sigBefore = await def.sig(target, uid)
  const actBefore = await activityCount(uid)
  const res = await def.api(s, target, role, phase)
  check(`${L} API -> 403`, res.status === 403, `status=${res.status} ${JSON.stringify(res.json).slice(0, 160)}`)
  if (def.verifyOff) await def.verifyOff(res, target, uid, L, s)
  const sigAfter = await def.sig(target, uid)
  const actAfter = await activityCount(uid)
  check(`${L} nothing written (target signature unchanged)`, sigBefore === sigAfter, `before=${sigBefore} after=${sigAfter}`)
  check(`${L} nothing written (activity_logs count for the fixture unchanged)`, actBefore === actAfter, `before=${actBefore} after=${actAfter}`)
}

/** Serial-rule watchdog: the GET_LOCK session lock lives on ONE MySQL connection. If the
 *  Prisma engine replaced that connection, the lock is gone: report it (harness FAIL) and
 *  take it again with timeout 0 (fails when anyone else grabbed it meanwhile). */
async function watchLock(where) {
  const [r] = await q`SELECT CONNECTION_ID() AS cid, IS_USED_LOCK('tcms_verify') AS holder`
  const cid = Number(r.cid)
  const holder = r.holder === null ? null : Number(r.holder)
  if (ctx.lockConn !== undefined && cid !== ctx.lockConn) console.log(`      LOCK-WATCH connection changed ${ctx.lockConn} -> ${cid} (${where})`)
  if (holder !== null && holder !== cid) {
    // The engine opened a new connection while the old one (still holding the lock) lingers.
    // Accept only when the holder's client port is one of THIS node process's own sockets.
    const [p] = await q`SELECT HOST AS host FROM information_schema.PROCESSLIST WHERE ID = ${holder}`
    const port = String(p?.host ?? '').split(':')[1]
    const mine = ownMysqlClientPorts()
    const isOwn = !!port && mine.includes(port)
    console.log(`      LOCK-WATCH lock on connection ${holder} (client port ${port ?? '?'}), this process' ports to :5500 = ${mine.join(',')}`)
    check(`harness: lock tcms_verify still held by this process (stale own connection ${holder}) (${where})`, isOwn, `holder=${holder} port=${port}`)
    if (!isOwn) throw new Error('lock tcms_verify held by another session')
  } else if (holder === null) {
    const [g] = await q`SELECT GET_LOCK('tcms_verify', 0) AS got`
    console.log(`      LOCK-WATCH lock was released with a replaced connection; re-acquired on ${cid}: got=${Number(g.got)} (${where})`)
    check(`harness: lock tcms_verify re-acquired on the current connection (${where})`, Number(g.got) === 1, `got=${g.got}`)
    if (Number(g.got) !== 1) throw new Error('lock tcms_verify taken by another session')
  }
  ctx.lockConn = cid
}

/** Local ports of this process's ESTABLISHED TCP connections to 127.0.0.1:5500 (Windows netstat). */
function ownMysqlClientPorts() {
  const out = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true }).stdout || ''
  const ports = []
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length >= 5 && cols[2] === '127.0.0.1:5500' && cols[3] === 'ESTABLISHED' && cols[4] === String(process.pid)) {
      ports.push(cols[1].split(':').pop())
    }
  }
  return ports
}

async function runCell(def, action, role) {
  await watchLock(`${action}/${role}`)
  const user = ctx.byRole[role]
  const defaultOn = ctx.matrixDefaults.get(`${role}:${action}`)
  const row = { action, role, defaultOn, on: false, off: false, issues: [] }
  ctx.rows.push(row)
  console.log(`\n=== ${action} x ${role} (default ${defaultOn ? 'ON' : 'OFF'}) ===`)
  let keep = null
  // ----- ON -----
  cellFails = []
  try {
    const L = `[${action}/${role}] ON`
    const put = await vpToggle(role, action, true)
    check(`${L} VP PUT enabled:true -> 200`, put.status === 200, String(put.status))
    await sleep(PERMISSION_CACHE_WAIT_MS, state.signal)
    const target = def.setup ? await def.setup(role, 'on') : {}
    const s = await login(user, state.signal)
    check(`${L} fresh session carries ${action}`, s.permissions.includes(action), JSON.stringify(s.permissions))
    keep = await openPage(s)
    await checkUi(keep, def, target, true, L)
    await runPhaseApiOn(def, s, target, role, 'on', L)
  } catch (err) {
    if (state.interrupted) throw err
    check(`[${action}/${role}] ON phase aborted: ${err.message}`, false)
  }
  row.on = cellFails.length === 0
  row.issues.push(...cellFails)
  // ----- OFF (+ session refresh on the kept ON context) -----
  cellFails = []
  try {
    const L = `[${action}/${role}] OFF`
    const put = await vpToggle(role, action, false)
    check(`${L} VP PUT enabled:false -> 200`, put.status === 200, String(put.status))
    await sleep(PERMISSION_CACHE_WAIT_MS, state.signal)
    const target = def.setup ? await def.setup(role, 'off') : {}
    if (keep) {
      const R = `[${action}/${role}] REFRESH`
      await keep.reload()
      const shell = await keep.waitFor(probeShell, [], READY_MS)
      if (def.link) check(`${R} kept ON session, reload: sidebar "${def.link}" hidden`, shell.ready && !shell.nav.includes(def.link), `nav=${JSON.stringify(shell.nav)}`)
      else check(`${R} kept ON session, reload: app shell still signed in`, shell.ready, `path=${shell.path}`)
      await checkUi(keep, def, target, false, R)
      await closePage(keep)
      keep = null
    }
    const s = await login(user, state.signal)
    check(`${L} fresh session lacks ${action}`, !s.permissions.includes(action), JSON.stringify(s.permissions))
    const page = await openPage(s)
    try {
      await checkUi(page, def, target, false, L)
    } finally {
      await closePage(page)
    }
    await runPhaseApiOff(def, s, target, role, 'off', L)
  } catch (err) {
    if (state.interrupted) throw err
    check(`[${action}/${role}] OFF phase aborted: ${err.message}`, false)
  } finally {
    if (keep) await closePage(keep).catch(() => {})
  }
  row.off = cellFails.length === 0
  row.issues.push(...cellFails)
  cellFails = null
  // ----- restore default -----
  const back = await vpToggle(role, action, defaultOn)
  const cell = await readCell(role, action)
  check(`[${action}/${role}] restore default (${defaultOn}) -> 200, GET source default`, back.status === 200 && cell?.source === 'default' && cell?.enabled === defaultOn, `${back.status} ${JSON.stringify(cell)}`)
}

// ---------- extra checks (side findings while mapping the code) ----------

async function runExtras() {
  console.log('\n=== EXTRA (side findings, not part of the 63-row table) ===')
  cellFails = null
  // E1: partial PUT of a test case must not reset untouched fields (test-cases.validation.ts:22-27).
  const tc = await vpCreateCase(`${PREFIX} ${STAMP} extra partial case`)
  const e1 = await vpReq('PUT', `/api/test-cases?id=${tc.id}`, { title: `${tc.title} renamed` })
  const [r1] = await q`SELECT priority, tags FROM test_cases WHERE test_case_id = ${tc.id}`
  if (r1 && typeof r1.tags === 'string') r1.tags = JSON.parse(r1.tags)
  check('E1 PUT /api/test-cases {title} keeps priority P1 and tags ["permtoggle"]', e1.status === 200 && r1?.priority === 'P1' && JSON.stringify(r1?.tags) === '["permtoggle"]',
    `status=${e1.status} priority=${r1?.priority} tags=${JSON.stringify(r1?.tags)}`)
  // E2: kanban drag payload (bugs.tsx:130) must not reset severity (bugs.validation.ts:16,26).
  const bug = await vpCreateBug(`${PREFIX} ${STAMP} extra kanban bug`)
  const e2 = await vpReq('PUT', `/api/bugs?id=${bug.id}`, { status: 'in_progress', expectedUpdatedAt: bug.updatedAt })
  const [r2] = await q`SELECT status, severity FROM bugs WHERE bug_id = ${bug.id}`
  check('E2 PUT /api/bugs {status} (kanban drag payload) keeps severity low', e2.status === 200 && r2?.status === 'in_progress' && r2?.severity === 'low',
    `status=${e2.status} row=${JSON.stringify(r2 ?? null)}`)
  // E3: a create_bug holder without assign_bug saves the bug edit dialog (bugs.tsx:799-804).
  const bug3 = await vpCreateBug(`${PREFIX} ${STAMP} extra dialog bug`)
  const dev = await login(ctx.byRole.developer, state.signal)
  const e3 = await req('PUT', `/api/bugs?id=${bug3.id}`, { jar: dev.jar, body: { status: 'in_progress', severity: 'low', assignedToId: null, expectedUpdatedAt: bug3.updatedAt } })
  check('E3 developer (create_bug, no assign_bug) saves the edit-dialog payload, assignee unchanged -> 200', e3.status === 200, `status=${e3.status} ${JSON.stringify(e3.json).slice(0, 160)}`)
  // E4: PUT /api/task-reports?id {notes} must keep the stored tasks (task-reports.validation.ts:38,42).
  const e4 = await vpReq('PUT', `/api/task-reports?id=${ctx.base.vpReportId}`, { notes: 'permtoggle notes only' })
  const [r4] = await q`SELECT tasks, total_minutes FROM task_reports WHERE task_report_id = ${ctx.base.vpReportId}`
  const tasks4 = typeof r4?.tasks === 'string' ? JSON.parse(r4.tasks) : r4?.tasks
  check('E4 PUT /api/task-reports?id {notes} keeps the 1 stored task and total 45', e4.status === 200 && Array.isArray(tasks4) && tasks4.length === 1 && Number(r4?.total_minutes) === 45,
    `status=${e4.status} tasks=${Array.isArray(tasks4) ? tasks4.length : 'n/a'} total=${r4?.total_minutes}`)
  // E5: toggling a cell to its default deletes the override; the PUT answer should say so (permissions.service.ts:88-93).
  const e5 = await vpToggle('developer', 'create_bug', true)
  const cell5 = await readCell('developer', 'create_bug')
  check('E5 PUT /api/permissions to the default value answers source "default" (GET says default)', e5.status === 200 && e5.json?.source === cell5?.source,
    `put.source=${e5.json?.source} get.source=${cell5?.source}`)
}

// ---------- setup / warm-up ----------

async function setupBase() {
  const mod = await vpCreateModule(`${PREFIX} ${STAMP} base module`)
  ctx.base.moduleId = mod.id
  const tc = await vpCreateCase(`${PREFIX} ${STAMP} base case`)
  ctx.base.caseId = tc.id
  ctx.base.caseTitle = tc.title
  const rep = await vpReq('POST', '/api/task-reports', { reportDate: TODAY, tasks: [{ description: `${PREFIX} ${STAMP} vp task`, timeSpentMinutes: 45, status: 'done' }] })
  if (!rep.json?.taskReportId) throw new Error(`setup: VP task report -> ${rep.status}`)
  ctx.base.vpReportId = rep.json.taskReportId
  ctx.known.taskReports.push(rep.json.taskReportId)
  check('setup: base module, case, VP task report created by the fixture VP', true)
}

async function warmUp() {
  // First compile of a route in next dev can take long; visit every page once as the VP (not counted).
  const page = await openPage(ctx.vp)
  try {
    for (const p of ['/dashboard', '/modules', '/test-cases', `/test-cases/${ctx.base.caseId}`, '/bugs', '/tasks', '/reports', '/activity-log',
      '/integrations', '/settings/users', '/settings/permissions', '/wiki', '/reviews']) {
      await page.goto(p)
      await page.waitFor(probeShell, [], 90_000)
      await sleep(500)
    }
  } finally {
    await closePage(page)
  }
  console.log('      warm-up done')
}

// ---------- cleanup ----------

async function cleanup() {
  console.log('\n=== CLEANUP (SQL by fixture ids and collected ids) ===')
  const db = ctx.db
  for (const p of [...ctx.openPages]) await closePage(p).catch(() => {})
  const chromeEnd = await shutdownChrome(ctx.cdp, ctx.chrome, PROFILE_DIR)
  check('harness: spawned Chrome pid tree gone', chromeEnd.processGone, `left=${chromeEnd.leftovers}`)
  check('harness: Chrome profile dir removed', chromeEnd.profileRemoved, PROFILE_DIR)

  const emails = [...ctx.fixtures.map((u) => u.email), ...ctx.invitedEmails]
  const found = await findUsersByEmails(db, emails)
  const fixtureIds = [...new Set([...ctx.fixtures.map((u) => u.userId), ...found.map((r) => r.user_id)])]
  const entities = await collectEntities(db, fixtureIds, ctx.known)
  console.log(`      users=${fixtureIds.length} ${Object.entries(entities).map(([k, v]) => `${k}=${v.length}`).join(' ')}`)
  await watchLock('cleanup')

  const counter = { check }
  await runCleanupStep(counter, 'notifications by entity', async () => ({ ok: true, detail: `${await deleteNotificationsByEntity(db, entities)} deleted` }))
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
  await runCleanupStep(counter, 'role_permissions touched cells (fixture rows only)', async () => {
    const { deleted, foreign } = await restoreTouchedCells(db, [...ctx.touched.values()], fixtureIds)
    if (foreign.length) return { ok: false, detail: `changed by another actor: ${foreign.join(', ')}` }
    return { ok: true, detail: `${deleted} fixture row(s) deleted, ${ctx.touched.size} cell(s) touched` }
  })
  await sleep(PERMISSION_CACHE_WAIT_MS)
  // Proof by the API, while the fixture VP still exists.
  try {
    const vp = await login(ctx.byRole.vp)
    const res = await requestJson('GET', '/api/permissions', { jar: vp.jar })
    const cells = Array.isArray(res.json) ? res.json : []
    const nonDefault = cells.filter((c) => c.source !== 'default')
    check('matrix: GET /api/permissions as VP = 126 cells, all source default', cells.length === 126 && nonDefault.length === 0,
      `cells=${cells.length} nonDefault=${nonDefault.map((c) => `${c.role}/${c.action}`).join(',')}`)
    console.log(`MATRIX cells=${cells.length} nonDefault=${nonDefault.length}`)
  } catch (err) {
    check('matrix: GET /api/permissions as VP = 126 cells, all source default', false, err.message)
  }
  const rp = Number((await q`SELECT COUNT(*) AS n FROM role_permissions`)[0].n)
  check('matrix: role_permissions table has 0 rows (SQL)', rp === 0, `rows=${rp}`)
  await runCleanupStep(counter, 'activity_logs by fixture user_id', async () => ({ ok: true, detail: `${await deleteActivityLogsByUsers(db, fixtureIds)} deleted` }))
  await runCleanupStep(counter, 'login_attempts by fixture email', async () => ({ ok: true, detail: `${await deleteLoginAttemptsByEmails(db, emails)} deleted` }))
  await runCleanupStep(counter, 'users (fixtures + temp invited users)', async () => {
    const { deleted, failed } = await deleteUsersByIds(db, fixtureIds)
    return { ok: failed.length === 0, detail: `${deleted} deleted${failed.length ? `; failed: ${failed.join(', ')}` : ''}` }
  })
  console.log('\n=== RESIDUE ===')
  const residue = await countResidue(db, { fixtureIds, emails, entities }, ALL_RESIDUE_TABLES)
  checkResidue(counter, residue)
  const tagged = await q`SELECT
      (SELECT COUNT(*) FROM modules WHERE name LIKE ${`${PREFIX} ${STAMP}%`}) AS m,
      (SELECT COUNT(*) FROM test_cases WHERE title LIKE ${`${PREFIX} ${STAMP}%`}) AS c,
      (SELECT COUNT(*) FROM bugs WHERE title LIKE ${`${PREFIX} ${STAMP}%`}) AS b,
      (SELECT COUNT(*) FROM wiki_documents WHERE title LIKE ${`${PREFIX} ${STAMP}%`}) AS w,
      (SELECT COUNT(*) FROM users WHERE email LIKE ${`${PREFIX}-%-${STAMP}@tcms.test`}) AS u`
  const t = Object.fromEntries(Object.entries(tagged[0]).map(([k, v]) => [k, Number(v)]))
  check('residue: 0 rows carry this run\'s stamp (modules, cases, bugs, wiki, users)', Object.values(t).every((n) => n === 0), JSON.stringify(t))
}

// ---------- main ----------

function printTable() {
  console.log('\n=== TABLE (permission | role | default | ON ok? | OFF ok? | failing checks) ===')
  for (const r of ctx.rows) {
    console.log(`ROW | ${r.action} | ${r.role} | ${r.defaultOn ? 'ON' : 'OFF'} | ${r.on ? 'yes' : 'NO'} | ${r.off ? 'yes' : 'NO'} | ${r.issues.join(' ; ') || '-'}`)
  }
}

async function main() {
  const started = Date.now()
  console.log(`STAMP=${STAMP}`)
  console.log(`PROFILE=${PROFILE_DIR}`)
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
  const closeBrowserOnSigint = () => ctx.cdp?.close()
  process.on('SIGINT', closeBrowserOnSigint)
  try {
    const overrides = await q`SELECT role, action FROM role_permissions`
    if (overrides.length > 0) {
      console.log(`PRECONDITION: ${overrides.length} override row(s): ${overrides.map((r) => `${r.role}/${r.action}`).join(', ')}`)
      console.log('NOT RUN: nothing created')
      return 2
    }
    const specs = ['vp', ...ROLES].map((role) => ({ key: ROLE_KEY[role], role, name: `Permtoggle ${role}`, email: fixtureEmail(PREFIX, ROLE_KEY[role], STAMP) }))
    ctx.fixtures = await createFixtureUsers(ctx.db, specs)
    for (const f of ctx.fixtures) ctx.byRole[f.role] = f
    let exit = null
    try {
      await sleep(PERMISSION_CACHE_WAIT_MS, state.signal)
      ctx.vp = await login(ctx.byRole.vp, state.signal)
      const res = await vpReq('GET', '/api/permissions')
      const cells = Array.isArray(res.json) ? res.json : []
      if (cells.length !== 126 || cells.some((c) => c.source !== 'default')) {
        console.log(`PRECONDITION: GET /api/permissions cells=${cells.length} nonDefault=${cells.filter((c) => c.source !== 'default').length}`)
        exit = 2
      } else {
        for (const c of cells) ctx.matrixDefaults.set(`${c.role}:${c.action}`, c.enabled)
        check('precondition: GET /api/permissions as fixture VP = 126 cells, all default', true)
        const defs = buildDefs()
        const actions = [...new Set(cells.map((c) => c.action))]
        check('mapping: one definition for every one of the 21 actions', actions.length === 21 && actions.every((a) => defs[a]), `actions=${actions.length} missing=${actions.filter((a) => !defs[a]).join(',')}`)
        const only = process.env.PERMTOGGLE_ACTIONS ? process.env.PERMTOGGLE_ACTIONS.split(',') : null
        const launched = await launchChrome(PROFILE_DIR)
        ctx.chrome = launched.child
        if (!launched.wsUrl) throw new Error('Chrome did not publish DevToolsActivePort')
        ctx.cdp = await Cdp.connect(launched.wsUrl)
        await setupBase()
        await warmUp()
        for (const action of actions) {
          if (only && !only.includes(action)) continue
          for (const role of ROLES) {
            if (state.interrupted) break
            await runCell(defs[action], action, role)
          }
        }
        if (!only) await runExtras()
      }
    } catch (err) {
      cellFails = null
      check(state.interrupted ? 'INTERRUPTED (SIGINT)' : `run aborted: ${err.message}`, false)
    } finally {
      state.cleaning = true
      try {
        await cleanup()
      } catch (err) {
        check('cleanup completed', false, err.message)
      }
    }
    printTable()
    const secs = Math.round((Date.now() - started) / 1000)
    console.log(`\nRUNTIME ${Math.floor(secs / 60)} min ${secs % 60} s`)
    console.log(`PASS=${totals.pass} FAIL=${totals.fail}`)
    if (exit !== null) return exit
    if (state.interrupted) return 130
    return totals.fail > 0 ? 1 : 0
  } finally {
    process.removeListener('SIGINT', state.onSigint)
    process.removeListener('SIGINT', closeBrowserOnSigint)
    await ctx.guard.release()
  }
}

main().then(
  (code) => { process.exitCode = code },
  (err) => { console.error(`SUITE ERROR: ${err.message}`); process.exitCode = 1 }
)
