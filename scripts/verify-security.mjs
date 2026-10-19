#!/usr/bin/env node
/**
 * Deep security suite (2026-10-17) — repeatable, self-cleaning, local app only.
 *
 * Sections (each check prints `ok` / FAIL, findings that need a decision print INFO):
 *   1 access control / IDOR: every role (+ no login) against every endpoint, record-level ownership
 *   2 sign-in + sessions: lockout, per-IP limit, no user enumeration, cookie flags, logout kills the
 *     session, refresh token is not an access token, forged / tampered / alg=none tokens, password
 *     change ends other sessions, deactivated user, bcrypt hashes
 *   3 open redirect (?next=) — the real safeNextPath() + the edge redirect
 *   4 SQL injection — static scan + payloads in every filter, search, id and body field
 *   5 XSS — script payloads in every text field, rendered in headless Chrome (no script may run)
 *   6 CSRF + CORS
 *   7 CSV import — size, type, row limits, formula injection (csv-export guard)
 *   8 security headers
 *   9 error leaks (no stack, SQL, file path in any response)
 *  10 secrets — no .env secret value in the client bundle or the log files (key NAMES printed only)
 *  11 mass assignment
 *  12 request limits (big / chunked / malformed / deep bodies, app stays up)
 *  13 Crew Desk — key never sent to the browser, outgoing host only from .env
 *
 * Writes only its own fixture users + their rows and removes them at the end
 * (scripts/lib/suite-cleanup.mjs). DB guard: 127.0.0.1:5500/tcms_test only.
 * Usage: node scripts/verify-security.mjs        TCMS_BASE_URL (default http://localhost:3000)
 *        SECURITY_BUILD_DIR=<folder with .next>   bundle scan target (default ./.next)
 *        SECURITY_LOG_DIR=<logs folder>           log scan target (default ./logs)
 *        SECURITY_SKIP_BROWSER=1                  skip section 5's browser part
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Prisma, insertReturningId, openGuardedDb } from './lib/db-guard.mjs'
import { createFixtureUsers, fixtureEmail } from './lib/fixture-users.mjs'
import { cleanupRunEntities } from './lib/suite-cleanup.mjs'
import { Cdp, RolePage, launchChrome, parseSetCookie, shutdownChrome } from './lib/cdp-browser.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.TCMS_BASE_URL || 'http://localhost:3000'
const BUILD_DIR = process.env.SECURITY_BUILD_DIR || path.join(ROOT, '.next')
const STAMP = Date.now()
const ROLES = ['vp', 'manager', 'product', 'developer', 'qa', 'viewer']
const XSS_IMG = '<img src=x onerror="window.__xss=(window.__xss||0)+1">'
const XSS_SCRIPT = '<script>window.__xss=(window.__xss||0)+1</script>'
const XSS_SVG = '"><svg onload="window.__xss=(window.__xss||0)+1">'
const XSS = `${XSS_IMG}${XSS_SCRIPT}${XSS_SVG}`
const LEAK_RE = /\bat [\w.<>]+ \(|\.tsx?:\d+|\.m?js:\d+|[A-Z]:\\\\|\/home\/|node_modules|PrismaClient|prisma\.|\bSELECT\b.+\bFROM\b|\bINSERT INTO\b|ER_[A-Z_]+|sqlMessage|\$2[aby]\$\d\d\$/

let pass = 0
let fail = 0
const findings = []
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`) }
  return cond
}
const info = (name, detail) => { findings.push(`${name}: ${detail}`); console.log(`INFO  ${name} — ${detail}`) }
const section = (title) => console.log(`\n=== ${title} ===`)

const created = { modules: [], cases: [], bugs: [], taskReports: [] }
const wikiIds = []
const tempUsers = { userIds: [], emails: [] }
const leakHits = []

// ---------- HTTP ----------

/** One request; every response body is scanned for leaks. */
async function http(method, urlPath, { token, cookie, body, raw, headers = {}, marker = true, origin = true } = {}) {
  const h = { ...headers }
  if (marker) h['X-Requested-With'] = 'tcms'
  if (origin && method !== 'GET') h.Origin = BASE
  if (token) h.Cookie = `tcms-access=${token}`
  if (cookie) h.Cookie = cookie
  let payload
  if (raw !== undefined) payload = raw
  else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json' }
  const started = Date.now()
  const res = await fetch(`${BASE}${urlPath}`, { method, headers: h, body: payload, redirect: 'manual', duplex: 'half' })
  const text = await res.text()
  const ms = Date.now() - started
  let json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  if (res.status >= 400 && /json/.test(res.headers.get('content-type') ?? '') && LEAK_RE.test(text)) leakHits.push(`${method} ${urlPath.slice(0, 80)} -> ${res.status}`)
  return { status: res.status, json, text, ms, headers: res.headers, setCookie: res.headers.getSetCookie?.() ?? [] }
}

function cookieValue(setCookie, name) {
  const line = setCookie.find((c) => c.startsWith(`${name}=`)) ?? ''
  return line.split(';')[0].slice(name.length + 1) || null
}

async function login(email, password, extraHeaders = {}) {
  const res = await http('POST', '/api/auth?path=login', { body: { email, password }, headers: extraHeaders })
  return { ...res, token: cookieValue(res.setCookie, 'tcms-access'), refresh: cookieValue(res.setCookie, 'tcms-refresh') }
}

// ---------- fixtures ----------

const FIXTURES = [
  ['vp', 'vp'], ['manager', 'manager'], ['product', 'product'], ['developer', 'developer'],
  ['qa', 'qa_engineer'], ['qa2', 'qa_engineer'], ['viewer', 'viewer'],
  ['victim', 'qa_engineer'], ['pwchange', 'qa_engineer'], ['deact', 'viewer'],
]

async function setupFixtures() {
  const guard = await openGuardedDb()
  try {
    const specs = FIXTURES.map(([key, role]) => ({ key, role, email: fixtureEmail('sec', key, STAMP), name: `Security ${key} ${STAMP}` }))
    const users = await createFixtureUsers(guard.db, specs)
    for (const u of users) { tempUsers.userIds.push(u.userId); tempUsers.emails.push(u.email) }
    return Object.fromEntries(users.map((u) => [u.key, u]))
  } finally {
    await guard.release()
  }
}

async function sqlOnce(fn) {
  const guard = await openGuardedDb({ lock: false, log: () => {} })
  try { return await fn(guard.db) } finally { await guard.release() }
}

// ---------- section 1: access control ----------

async function setupEntities(s, u) {
  const mod = await http('POST', '/api/modules', { token: s.manager, body: { name: `sec module ${STAMP}` } })
  const moduleId = mod.json?.moduleId
  if (moduleId) created.modules.push(moduleId)
  const tc = await http('POST', '/api/test-cases', { token: s.qa, body: { title: `sec case ${STAMP}`, moduleId, description: 'owned by qa' } })
  if (tc.json?.testCaseId) created.cases.push(tc.json.testCaseId)
  const bug = await http('POST', '/api/bugs', { token: s.qa, body: { title: `sec bug ${STAMP}`, description: 'owned by qa', severity: 'low', moduleId } })
  if (bug.json?.bugId) created.bugs.push(bug.json.bugId)
  const wiki = await http('POST', '/api/wiki', { token: s.qa, body: { title: `sec wiki ${STAMP}`, content: '<p>owned by qa</p>' } })
  if (wiki.json?.wikiDocumentId) wikiIds.push(wiki.json.wikiDocumentId)
  const tr = await http('POST', '/api/task-reports', { token: s.qa, body: { reportDate: '2001-03-01', tasks: [{ description: 'sec task', status: 'done', timeSpentMinutes: 30 }] } })
  const taskReportId = tr.json?.taskReportId
  if (taskReportId) created.taskReports.push(taskReportId)
  const notificationId = await sqlOnce((db) => insertReturningId(db, Prisma.sql`
    INSERT INTO notifications (user_id, type, title, body, entity_type, entity_id, is_read, created_at)
    VALUES (${u.qa.userId}, 'bug_assigned', ${`sec notification ${STAMP}`}, 'private to qa', 'bug', ${bug.json?.bugId ?? null}, 0, UTC_TIMESTAMP(3))`))
  const ok = check('setup: module, case, bug, wiki, work log, notification created',
    Boolean(moduleId && tc.json?.testCaseId && bug.json?.bugId && wiki.json?.wikiDocumentId && taskReportId && notificationId),
    `module=${mod.status} case=${tc.status} bug=${bug.status} wiki=${wiki.status} report=${tr.status}`)
  if (!ok) throw new Error('entity setup failed')
  return { moduleId, caseId: tc.json.testCaseId, bugId: bug.json.bugId, wikiId: wiki.json.wikiDocumentId, taskReportId, notificationId, caseUpdatedAt: tc.json.updatedAt }
}

async function accessControl(s, u, e) {
  section('1 access control / IDOR (every role + no login)')
  const VIEW_ALL = ['vp', 'manager', 'product']
  const reads = [
    ['GET /api/users', '/api/users', ['vp', 'manager']],
    ['GET /api/users?action=options', '/api/users?action=options', ROLES],
    ['GET /api/permissions', '/api/permissions', ['vp']],
    ['GET /api/activity-logs', '/api/activity-logs', VIEW_ALL],
    ['GET /api/activity-logs?action=user', `/api/activity-logs?action=user&id=${u.qa.userId}`, VIEW_ALL],
    ['GET /api/activity-logs?action=entity', `/api/activity-logs?action=entity&type=bug&id=${e.bugId}`, VIEW_ALL],
    ['GET /api/task-reports?id (others + owner)', `/api/task-reports?id=${e.taskReportId}`, [...VIEW_ALL, 'qa']],
    ['GET /api/task-reports?action=summary', '/api/task-reports?action=summary', VIEW_ALL],
    ['GET /api/stats?action=reports', '/api/stats?action=reports', VIEW_ALL],
    ['GET /api/reviews (all)', '/api/reviews', VIEW_ALL],
    ['GET /api/module-reviews?action=all', '/api/module-reviews?action=all', VIEW_ALL],
    ['GET /api/integrations/crewdesk?path=config', '/api/integrations/crewdesk?path=config', ['vp', 'manager']],
    ['GET /api/integrations/crewdesk (links)', '/api/integrations/crewdesk', ['vp', 'manager']],
    ['GET /api/test-cases?id', `/api/test-cases?id=${e.caseId}`, ROLES],
    ['GET /api/bugs?id', `/api/bugs?id=${e.bugId}`, ROLES],
    ['GET /api/wiki?id', `/api/wiki?id=${e.wikiId}`, ROLES],
    ['GET /api/modules?id', `/api/modules?id=${e.moduleId}`, ROLES],
    ['GET /api/notifications (own)', '/api/notifications', ROLES],
    ['GET /api/stats?action=dashboard', '/api/stats?action=dashboard', ROLES],
    ['GET /api/search', '/api/search?q=sec', ROLES],
  ]
  for (const [name, url, allowed] of reads) {
    const got = []
    for (const role of ROLES) {
      const r = await http('GET', url, { token: s[role] })
      const want = allowed.includes(role) ? 200 : 403
      if (r.status !== want) got.push(`${role}=${r.status} (want ${want})`)
    }
    const anon = await http('GET', url)
    if (anon.status !== 401) got.push(`no-login=${anon.status} (want 401)`)
    check(`${name}: 6 roles + no login`, got.length === 0, got.join(' '))
  }
  check('GET /api/task-reports?id: another qa engineer cannot read it', (await http('GET', `/api/task-reports?id=${e.taskReportId}`, { token: s.qa2 })).status === 403)

  // Notifications are private: qa's notification never shows up for anybody else.
  const leaks = []
  for (const role of ['vp', 'manager', 'product', 'developer', 'viewer']) {
    const r = await http('GET', '/api/notifications', { token: s[role] })
    if (JSON.stringify(r.json ?? '').includes(`sec notification ${STAMP}`)) leaks.push(role)
  }
  check('notifications: another user\'s notification is never listed', leaks.length === 0, leaks.join(','))

  // Writes the role / owner does not hold: 403 (record-level: 403 or 404), never 2xx.
  const denies = [
    ['PUT test case of another user', 'PUT', `/api/test-cases?id=${e.caseId}`, { title: 'hijacked', expectedUpdatedAt: e.caseUpdatedAt }, ['product', 'developer', 'viewer', 'qa2']],
    ['DELETE test case of another user', 'DELETE', `/api/test-cases?id=${e.caseId}`, undefined, ['product', 'developer', 'viewer', 'qa2']],
    ['PUT bug (viewer)', 'PUT', `/api/bugs?id=${e.bugId}`, { title: 'hijacked' }, ['viewer']],
    ['DELETE bug without delete_bug', 'DELETE', `/api/bugs?id=${e.bugId}`, undefined, ['product', 'developer', 'qa', 'viewer']],
    ['PUT wiki doc of another user', 'PUT', `/api/wiki?id=${e.wikiId}`, { title: 'hijacked' }, ['product', 'developer', 'viewer', 'qa2']],
    ['DELETE wiki doc without delete_wiki_doc', 'DELETE', `/api/wiki?id=${e.wikiId}`, undefined, ['product', 'developer', 'viewer', 'qa2']],
    ['PUT work log of another user', 'PUT', `/api/task-reports?id=${e.taskReportId}`, { notes: 'hijacked' }, ['vp', 'manager', 'product', 'developer', 'viewer', 'qa2']],
    ['PATCH notification of another user', 'PATCH', `/api/notifications?id=${e.notificationId}`, {}, ['vp', 'manager', 'product', 'developer', 'viewer']],
    ['DELETE notification of another user', 'DELETE', `/api/notifications?id=${e.notificationId}`, undefined, ['vp', 'manager', 'product', 'developer', 'viewer']],
    ['POST module without create_module', 'POST', '/api/modules', { name: `sec denied ${STAMP}` }, ['developer', 'qa', 'viewer']],
    ['POST test case without create_test_case', 'POST', '/api/test-cases', { title: `sec denied ${STAMP}`, moduleId: e.moduleId, description: 'x' }, ['developer', 'viewer']],
    ['POST bug without create_bug', 'POST', '/api/bugs', { title: `sec denied ${STAMP}`, description: 'x', moduleId: e.moduleId }, ['viewer']],
    ['POST wiki without create_wiki_doc', 'POST', '/api/wiki', { title: `sec denied ${STAMP}` }, ['developer', 'viewer']],
    ['POST work log without create_task_report', 'POST', '/api/task-reports', { reportDate: '2001-03-02', tasks: [] }, ['viewer']],
    ['PUT permission toggle', 'PUT', '/api/permissions', { role: 'viewer', action: 'create_bug', enabled: false }, ['manager', 'product', 'developer', 'qa', 'viewer']],
    ['POST user without manage_users', 'POST', '/api/users', { email: `sec-denied-${STAMP}@tcms.test`, fullName: 'Denied', password: 'Denied123', role: 'viewer' }, ['product', 'developer', 'qa', 'viewer']],
    ['PUT a VP account (manager included)', 'PUT', `/api/users?id=${u.vp.userId}`, { fullName: 'hijacked' }, ['manager', 'product', 'developer', 'qa', 'viewer']],
    ['DELETE (deactivate) a VP account (manager included)', 'DELETE', `/api/users?id=${u.vp.userId}`, undefined, ['manager', 'product', 'developer', 'qa', 'viewer']],
    ['PUT another manager (manager)', 'PUT', `/api/users?id=${u.manager.userId}`, { isActive: false }, ['product', 'developer', 'qa', 'viewer']],
    ['Crew Desk lookup without manage_integrations', 'POST', '/api/integrations/crewdesk?path=lookup', { ticketId: '1355' }, ['product', 'developer', 'qa', 'viewer']],
  ]
  for (const [name, method, url, body, roles] of denies) {
    const got = []
    for (const role of roles) {
      const r = await http(method, url, { token: s[role], body })
      if (r.status !== 403 && r.status !== 404) got.push(`${role}=${r.status}`)
    }
    const anon = await http(method, url, { body })
    if (anon.status !== 401) got.push(`no-login=${anon.status}`)
    check(`${name}: refused for ${roles.length} role(s) + no login`, got.length === 0, got.join(' '))
  }
  // Nothing was changed by the refused writes.
  const tc = await http('GET', `/api/test-cases?id=${e.caseId}`, { token: s.qa })
  const wiki = await http('GET', `/api/wiki?id=${e.wikiId}`, { token: s.qa })
  const bug = await http('GET', `/api/bugs?id=${e.bugId}`, { token: s.qa })
  const notifs = await http('GET', '/api/notifications', { token: s.qa })
  const vpUser = await http('GET', '/api/users?action=options', { token: s.vp })
  check('refused writes changed nothing (case, wiki, bug, notification, VP account)',
    tc.json?.title === `sec case ${STAMP}` && wiki.json?.title === `sec wiki ${STAMP}` && bug.json?.title === `sec bug ${STAMP}` &&
    JSON.stringify(notifs.json).includes(`sec notification ${STAMP}`) && !JSON.stringify(vpUser.json).includes('hijacked'))
  const vpLogin = await login(u.vp.email, u.vp.password)
  check('VP account still active after the manager tried to deactivate it', vpLogin.status === 200, `login=${vpLogin.status}`)
  if (vpLogin.token) s.vp = vpLogin.token

  // Id guessing: ids are 1, 2, 3 … — a developer walks the work-log ids around the qa report.
  const n = Number(e.taskReportId)
  const opened = []
  for (let id = Math.max(1, n - 10); id <= n + 3; id++) {
    const r = await http('GET', `/api/task-reports?id=${id}`, { token: s.developer })
    if (r.status === 200) opened.push(id)
  }
  check('id guessing: developer opens none of 14 neighbouring work-log ids', opened.length === 0, opened.join(','))
  const guessNotif = []
  for (let id = Math.max(1, Number(e.notificationId) - 5); id <= Number(e.notificationId) + 2; id++) {
    const r = await http('PATCH', `/api/notifications?id=${id}`, { token: s.viewer, body: {} })
    if (r.status >= 200 && r.status < 300) guessNotif.push(id)
  }
  check('id guessing: viewer cannot mark any neighbouring notification id as read', guessNotif.length === 0, guessNotif.join(','))
}

// ---------- section 2: sign-in + sessions ----------

function b64url(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url') }

async function sessions(s, u) {
  section('2 sign-in + sessions')
  // Cookie flags
  const l = await login(u.qa2.email, u.qa2.password)
  const access = l.setCookie.find((c) => c.startsWith('tcms-access=')) ?? ''
  const refresh = l.setCookie.find((c) => c.startsWith('tcms-refresh=')) ?? ''
  check('access cookie: HttpOnly + SameSite=Lax + Path=/', /HttpOnly/i.test(access) && /SameSite=lax/i.test(access) && /Path=\//i.test(access), access.replace(/=[^;]+/, '=<hidden>'))
  check('refresh cookie: HttpOnly + SameSite=Lax + Path=/api/auth only', /HttpOnly/i.test(refresh) && /SameSite=lax/i.test(refresh) && /Path=\/api\/auth/i.test(refresh))
  check('login response body carries no token', !/eyJ[A-Za-z0-9_-]{10,}\./.test(l.text))
  const viaHttps = await login(u.qa2.email, u.qa2.password, { 'x-forwarded-proto': 'https' })
  check('cookies are Secure behind HTTPS (x-forwarded-proto: https)', viaHttps.setCookie.every((c) => /;\s*Secure/i.test(c)))
  if (!/;\s*Secure/i.test(access)) info('cookie Secure flag', 'not set over plain http on this run; set always when TCMS_DEPLOY_ENV=production (auth-cookies.ts isSecureRequest)')

  // No user enumeration
  const wrongKnown = await http('POST', '/api/auth?path=login', { body: { email: u.qa2.email, password: 'Wrong-pass-1' } })
  const unknownEmail = `sec-nobody-${STAMP}@tcms.test`
  tempUsers.emails.push(unknownEmail)
  const wrongUnknown = await http('POST', '/api/auth?path=login', { body: { email: unknownEmail, password: 'Wrong-pass-1' } })
  check('no user enumeration: known vs unknown email give the same status + message',
    wrongKnown.status === wrongUnknown.status && wrongKnown.json?.error === wrongUnknown.json?.error, `${wrongKnown.status}/${wrongUnknown.status}`)
  const t0 = Date.now(); await http('POST', '/api/auth?path=login', { body: { email: unknownEmail, password: 'Wrong-pass-1' } }); const tUnknown = Date.now() - t0
  const t1 = Date.now(); await http('POST', '/api/auth?path=login', { body: { email: u.qa2.email, password: 'Wrong-pass-1' } }); const tKnown = Date.now() - t1
  check('no timing oracle: unknown-email login also runs bcrypt (both > 20 ms)', tUnknown > 20 && tKnown > 20, `unknown=${tUnknown}ms known=${tKnown}ms`)
  await sqlOnce((db) => db.$executeRaw`DELETE FROM login_attempts WHERE email = ${u.qa2.email}`)

  // Brute force: per-email lock
  const statuses = []
  for (let i = 0; i < 6; i++) statuses.push((await http('POST', '/api/auth?path=login', { body: { email: u.victim.email, password: `Wrong-${i}-x1` } })).status)
  const locked = await http('POST', '/api/auth?path=login', { body: { email: u.victim.email, password: u.victim.password } })
  check('brute force: 5 failures lock the email (6th = 429)', statuses.slice(0, 4).every((x) => x === 401) && statuses[5] === 429, statuses.join(','))
  check('brute force: even the right password is refused while locked (429)', locked.status === 429, String(locked.status))

  // Per-IP limit (spoofed client IP so this machine's own sign-ins stay unaffected)
  const fakeIp = `203.0.113.${STAMP % 250}`
  let ipStatus = 0
  for (let i = 0; i < 31; i++) {
    const email = `sec-ip-${STAMP}-${i}@tcms.test`
    tempUsers.emails.push(email)
    ipStatus = (await http('POST', '/api/auth?path=login', { body: { email, password: 'Wrong-pass-1' }, headers: { 'X-Forwarded-For': fakeIp } })).status
  }
  check('per-IP limit: the 31st failed sign-in from one IP answers 429', ipStatus === 429, String(ipStatus))

  // Logout kills the session
  const a = await login(u.qa2.email, u.qa2.password)
  check('session works before logout', (await http('GET', '/api/auth', { token: a.token })).status === 200)
  await http('POST', '/api/auth?path=logout', { cookie: `tcms-access=${a.token}; tcms-refresh=${a.refresh}`, body: {} })
  check('logout: the old access token is refused at once (401)', (await http('GET', '/api/auth', { token: a.token })).status === 401)
  check('logout: the old refresh token is refused (401)', (await http('POST', '/api/auth?path=refresh', { cookie: `tcms-refresh=${a.refresh}`, body: {} })).status === 401)

  // Refresh token is not an access token
  const b = await login(u.qa2.email, u.qa2.password)
  check('refresh token used as access cookie is refused (401)', (await http('GET', '/api/auth', { token: b.refresh })).status === 401)
  check('refresh token used as Bearer header is refused (401)', (await http('GET', '/api/auth', { headers: { Authorization: `Bearer ${b.refresh}` } })).status === 401)
  check('access token is refused as a refresh token (401)', (await http('POST', '/api/auth?path=refresh', { body: { refreshToken: b.token } })).status === 401)

  // Forged / tampered / alg=none
  const [h, p, sig] = b.token.split('.')
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString())
  const tampered = `${h}.${b64url({ ...claims, role: 'vp', sub: u.vp.userId })}.${sig}`
  const longer = `${h}.${b64url({ ...claims, exp: claims.exp + 86400 * 365 })}.${sig}`
  const none = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ ...claims, sub: u.vp.userId, role: 'vp' })}.`
  const hs512 = `${b64url({ alg: 'HS512', typ: 'JWT' })}.${p}.${sig}`
  for (const [name, tok] of [['role/sub changed, old signature', tampered], ['exp extended, old signature', longer], ['alg=none', none], ['alg switched to HS512', hs512], ['random string', 'not-a-jwt'], ['empty', '']]) {
    check(`forged token refused: ${name}`, (await http('GET', '/api/auth', { headers: { Authorization: `Bearer ${tok}` }, marker: true })).status === 401)
  }
  info('expired token', 'not forged here (would need the JWT secret); expiry is enforced by jsonwebtoken verify() — TCMS_ACCESS_TOKEN_MINUTES')

  // Password change ends every other session
  const s1 = await login(u.pwchange.email, u.pwchange.password)
  const s2 = await login(u.pwchange.email, u.pwchange.password)
  await new Promise((r) => setTimeout(r, 1100)) // the "not before" check has 1 s resolution
  const newPassword = `Np${STAMP}x9`
  const pw = await http('PUT', '/api/auth?path=password', { token: s1.token, body: { currentPassword: u.pwchange.password, newPassword } })
  const s1New = cookieValue(pw.setCookie, 'tcms-access')
  check('password change: 200 and a fresh session cookie for this browser', pw.status === 200 && Boolean(s1New), String(pw.status))
  check('password change: the other session\'s access token is refused (401)', (await http('GET', '/api/auth', { token: s2.token })).status === 401)
  check('password change: the other session\'s refresh token is refused (401)', (await http('POST', '/api/auth?path=refresh', { cookie: `tcms-refresh=${s2.refresh}`, body: {} })).status === 401)
  check('password change: this browser keeps working with the new cookie', (await http('GET', '/api/auth', { token: s1New })).status === 200)
  check('password change: the old password no longer signs in', (await login(u.pwchange.email, u.pwchange.password)).status === 401)

  // Deactivated user
  const d = await login(u.deact.email, u.deact.password)
  const off = await http('DELETE', `/api/users?id=${u.deact.userId}`, { token: s.vp })
  check('VP deactivates a user (200)', off.status === 200, String(off.status))
  console.log('      waiting 31 s (session re-check cache is 30 s)')
  await new Promise((r) => setTimeout(r, 31_000))
  check('deactivated user: the existing session is refused (401)', (await http('GET', '/api/auth', { token: d.token })).status === 401)
  check('deactivated user: cannot sign in (401)', (await login(u.deact.email, u.deact.password)).status === 401)

  // Password storage
  const rows = await sqlOnce((db) => db.$queryRaw`SELECT COUNT(*) AS n,
      SUM(password_hash REGEXP '^[$]2[aby][$](1[0-9]|0[89])[$]') AS bcrypt FROM users`)
  check('password hashing: every user has a bcrypt hash (cost >= 8)', Number(rows[0].n) === Number(rows[0].bcrypt), `users=${rows[0].n} bcrypt=${rows[0].bcrypt}`)
}

// ---------- section 3: open redirect ----------

async function openRedirect() {
  section('3 open redirect (?next=)')
  const { safeNextPath } = await import(pathToFileURL(path.join(ROOT, 'src/lib/routes.ts')).href)
  const bad = ['//evil.example', '/\\evil.example', '/\\/evil.example', '\\\\evil.example', 'https://evil.example', 'javascript:alert(1)',
    '/\t/evil.example', '/\n/evil.example', ' /evil', 'evil.example', '/login?next=//evil']
  const escaped = bad.filter((v) => { const out = safeNextPath(v); return new URL(out, 'http://tcms.invalid').origin !== 'http://tcms.invalid' || out !== '/dashboard' && !out.startsWith('/') })
  check(`safeNextPath: ${bad.length} hostile values all stay on the site`, escaped.length === 0, escaped.join(' | '))
  const rewritten = bad.filter((v) => safeNextPath(v) !== '/dashboard')
  check('safeNextPath: hostile values fall back to /dashboard', rewritten.length === 0, rewritten.map((v) => JSON.stringify(v)).join(' '))
  check('safeNextPath: an encoded CR/LF path stays a same-site path', new URL(safeNextPath('/%0d%0aLocation:evil'), 'http://tcms.invalid').origin === 'http://tcms.invalid')
  check('safeNextPath: a normal path is kept', safeNextPath('/test-cases/42?status=draft') === '/test-cases/42?status=draft')
  const r = await http('GET', '/dashboard?x=1')
  const loc = r.headers.get('location') ?? ''
  check('edge redirect for a signed-out page goes to this site\'s /login', r.status >= 300 && r.status < 400 && new URL(loc, BASE).host === new URL(BASE).host && loc.includes('/login'), `${r.status} ${loc}`)
  const evil = await http('GET', '/login?next=//evil.example')
  check('/login?next=//evil.example renders (no server-side redirect off-site)', evil.status === 200 && !evil.headers.get('location'))
}

// ---------- section 4: SQL injection ----------

function walkFiles(dir, re, out = []) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name)
    if (item.isDirectory()) walkFiles(full, re, out)
    else if (re.test(item.name)) out.push(full)
  }
  return out
}

async function sqlInjection(s, e) {
  section('4 SQL injection')
  const files = walkFiles(path.join(ROOT, 'src'), /\.tsx?$/)
  const unsafe = files.filter((f) => /\$(query|execute)RawUnsafe|Prisma\.raw\(/.test(readFileSync(f, 'utf8')))
  check(`static: no $queryRawUnsafe / $executeRawUnsafe / Prisma.raw in ${files.length} src files`, unsafe.length === 0, unsafe.map((f) => path.relative(ROOT, f)).join(','))
  const concat = files.filter((f) => /\$(queryRaw|executeRaw)\s*\(\s*['"`]/.test(readFileSync(f, 'utf8')))
  check('static: every $queryRaw / $executeRaw is a tagged template (no string argument)', concat.length === 0, concat.map((f) => path.relative(ROOT, f)).join(','))

  const payloads = ["' OR '1'='1", '1 OR 1=1', "1'; DROP TABLE users; --", "x' AND SLEEP(3) AND '1'='1", "%' UNION SELECT password_hash FROM users -- ", '\\', '0x31', "1) OR (1=1"]
  const targets = [
    '/api/test-cases?q=P', '/api/test-cases?status=P', '/api/test-cases?priority=P', '/api/test-cases?moduleId=P', '/api/test-cases?page=P&pageSize=P',
    '/api/test-cases?id=P', '/api/bugs?q=P', '/api/bugs?status=P', '/api/bugs?severity=P', '/api/bugs?assignedTo=P', '/api/bugs?id=P',
    '/api/search?q=P', '/api/wiki?q=P', '/api/wiki?tag=P', '/api/wiki?id=P', '/api/modules?id=P', '/api/activity-logs?userId=P',
    '/api/activity-logs?entityType=P&action=P', '/api/activity-logs?dateFrom=P', '/api/task-reports?userId=P', '/api/task-reports?moduleId=P',
    '/api/task-reports?id=P', '/api/users?q=P&role=P', '/api/reviews?action=queue&status=P', '/api/notifications?unread=P',
  ]
  const bad = []
  let slow = 0
  let probes = 0
  for (const t of targets) {
    for (const p of payloads) {
      const r = await http('GET', t.replaceAll('P', encodeURIComponent(p)), { token: s.vp })
      probes++
      if (r.status >= 500) bad.push(`${t}<-${p} ${r.status}`)
      if (r.ms > 2500) slow++
      if (/password_hash|\$2[aby]\$/.test(r.text)) bad.push(`${t}<-${p} leaked hash`)
    }
  }
  check(`payloads: ${probes} filter/search/id probes, no 500, no hash leak`, bad.length === 0, bad.slice(0, 5).join(' | '))
  check('payloads: no SLEEP() took effect (every probe < 2.5 s)', slow === 0, `${slow} slow`)
  const tauto = await http('GET', `/api/search?q=${encodeURIComponent("' OR '1'='1")}`, { token: s.vp })
  const hits = JSON.stringify(tauto.json ?? {}).match(/"title"/g)?.length ?? 0
  check('tautology in search matches nothing (treated as text)', tauto.status === 200 && hits === 0, `${tauto.status} hits=${hits}`)
  // Body fields
  const bodyBad = []
  for (const p of payloads) {
    const bug = await http('POST', '/api/bugs', { token: s.qa, body: { title: `sec sqli ${p}`, description: p, severity: 'low', moduleId: e.moduleId } })
    if (bug.json?.bugId) created.bugs.push(bug.json.bugId)
    if (bug.status !== 200 && bug.status !== 201) bodyBad.push(`bug ${bug.status}`)
    else {
      const back = await http('GET', `/api/bugs?id=${bug.json.bugId}`, { token: s.qa })
      if (back.json?.description !== p) bodyBad.push('stored value differs')
    }
    const mod = await http('POST', '/api/modules', { token: s.manager, body: { name: `sec ${p}`.slice(0, 120), parentId: p } })
    if (mod.json?.moduleId) created.modules.push(mod.json.moduleId)
    if (mod.status >= 500) bodyBad.push(`module ${mod.status}`)
  }
  const users = await sqlOnce((db) => db.$queryRaw`SELECT COUNT(*) AS n FROM users`)
  check('body payloads: stored verbatim as text, no 500', bodyBad.length === 0, bodyBad.join(','))
  check('the users table is still there and readable', Number(users[0].n) > 0)
}

// ---------- section 5: XSS ----------

async function xss(s, u, e) {
  section('5 XSS (stored payloads must never run)')
  const bug = await http('POST', '/api/bugs', { token: s.qa, body: { title: `sec xss ${XSS}`.slice(0, 200), description: XSS, severity: 'low', moduleId: e.moduleId, stepsToReproduce: XSS } })
  if (bug.json?.bugId) created.bugs.push(bug.json.bugId)
  const tc = await http('POST', '/api/test-cases', { token: s.qa, body: { title: `sec xss ${XSS_IMG}`, moduleId: e.moduleId, description: XSS, steps: [{ action: XSS, expected: XSS }] } })
  if (tc.json?.testCaseId) created.cases.push(tc.json.testCaseId)
  const wikiHtml = `<p>hi</p>${XSS}<a href="javascript:window.__xss=1">x</a><iframe src="https://evil.example"></iframe><p style="background:url(https://evil.example)">s</p><form action="https://evil.example"><input></form>`
  const wiki = await http('POST', '/api/wiki', { token: s.qa, body: { title: `sec xss ${XSS_IMG}`, content: wikiHtml, tags: [XSS_IMG.slice(0, 40)] } })
  if (wiki.json?.wikiDocumentId) wikiIds.push(wiki.json.wikiDocumentId)
  const stored = wiki.json?.content ?? ''
  check('wiki: stored HTML has no script / event handler / javascript: / iframe / form / style',
    !/<script|onerror|onload|javascript:|<iframe|<form|style=/i.test(stored), stored.slice(0, 160))
  const tr = await http('POST', '/api/task-reports', { token: s.qa, body: { reportDate: '2001-03-03', notes: XSS, tasks: [{ description: XSS.slice(0, 500), status: 'done', timeSpentMinutes: 30, linkUrl: 'javascript:window.__xss=1' }] } })
  check('work log: a javascript: link is refused (400)', tr.status === 400, String(tr.status))
  const tr2 = await http('POST', '/api/task-reports', { token: s.qa, body: { reportDate: '2001-03-03', notes: XSS, tasks: [{ description: XSS.slice(0, 500), status: 'done', timeSpentMinutes: 30 }] } })
  if (tr2.json?.taskReportId) created.taskReports.push(tr2.json.taskReportId)
  const prof = await http('PUT', '/api/auth', { token: s.qa, body: { fullName: `Q ${XSS_IMG}`.slice(0, 80) } })
  check('profile: a script name is stored as text (200)', prof.status === 200, String(prof.status))
  const av = await http('PUT', '/api/auth', { token: s.qa, body: { avatarUrl: 'javascript:window.__xss=1' } })
  check('profile: a javascript: avatar URL is refused (400)', av.status === 400, String(av.status))
  const csv = `title,description\n"sec csv ${XSS_IMG.replaceAll('"', '""')}","${XSS.replaceAll('"', '""')}"\n`
  const imp = await http('POST', '/api/test-cases?action=import', { token: s.qa, body: { moduleId: e.moduleId, fileName: 'xss.csv', csv } })
  for (const r of imp.json?.results ?? []) if (r.testCaseId) created.cases.push(r.testCaseId)
  check('CSV import with script payload accepted as text (200)', imp.status === 200, String(imp.status))

  if (process.env.SECURITY_SKIP_BROWSER) { info('XSS browser render', 'skipped (SECURITY_SKIP_BROWSER)'); return }
  const profileDir = path.join(tmpdir(), `tcms-security-${STAMP}`)
  const launched = await launchChrome(profileDir)
  let cdp
  try {
    if (!launched.wsUrl) throw new Error('Chrome did not start')
    cdp = await Cdp.connect(launched.wsUrl)
    const session = await login(u.qa.email, u.qa.password)
    const cookies = session.setCookie.map(parseSetCookie)
    const page = await RolePage.open(cdp, { cookies, user: session.json.user }, BASE)
    let dialogs = 0
    cdp.on((msg) => { if (msg.method === 'Page.javascriptDialogOpening') { dialogs++; cdp.send('Page.handleJavaScriptDialog', { accept: true }, msg.sessionId).catch(() => {}) } })
    const pages = ['/dashboard', '/bugs', '/test-cases', `/test-cases/${tc.json?.testCaseId}`, `/wiki/${wiki.json?.wikiDocumentId}`, '/wiki', '/tasks', '/notifications', '/settings/profile', `/modules/${e.moduleId}`]
    const ran = []
    for (const p of pages) {
      await page.goto(p)
      const state = await page.waitFor(() => ({ ready: document.readyState === 'complete' && document.body.innerText.length > 50 }), [], 30_000)
      await new Promise((r) => setTimeout(r, 2500))
      const hit = await page.evaluate(() => window.__xss || 0)
      if (hit || !state.ready) ran.push(`${p}:${hit ? 'RAN' : 'not-ready'}`)
    }
    check(`browser: no payload ran on ${pages.length} pages (window.__xss unset, no dialog)`, ran.length === 0 && dialogs === 0, `${ran.join(' ')} dialogs=${dialogs}`)
    await page.close()
  } catch (err) {
    check('browser XSS pass ran', false, err.message)
  } finally {
    const shut = await shutdownChrome(cdp, launched.child, profileDir)
    check('browser: Chrome closed and its profile removed', shut.processGone && shut.profileRemoved)
  }
}

// ---------- section 6: CSRF + CORS ----------

async function csrf(s, e) {
  section('6 CSRF + CORS')
  const body = { title: `sec csrf ${STAMP}`, description: 'x', severity: 'low', moduleId: e.moduleId }
  const noMarker = await http('POST', '/api/bugs', { token: s.qa, body, marker: false, origin: false })
  check('state change without the CSRF header and without Origin: 403', noMarker.status === 403, String(noMarker.status))
  const evil = await http('POST', '/api/bugs', { token: s.qa, body, marker: false, origin: false, headers: { Origin: 'https://evil.example' } })
  check('state change from a foreign Origin (no header): 403', evil.status === 403, String(evil.status))
  const form = await http('POST', '/api/bugs', { token: s.qa, raw: 'title=x&description=y', marker: false, origin: false, headers: { Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' } })
  check('classic cross-site form post: 403', form.status === 403, String(form.status))
  for (const [m, url] of [['PUT', `/api/bugs?id=${e.bugId}`], ['DELETE', `/api/bugs?id=${e.bugId}`], ['POST', '/api/auth?path=logout'], ['PUT', '/api/auth?path=password'], ['PATCH', `/api/notifications?id=${e.notificationId}`]]) {
    const r = await http(m, url, { token: s.vp, body: {}, marker: false, origin: false, headers: { Origin: 'https://evil.example' } })
    check(`${m} ${url.split('?')[0]} from a foreign Origin: 403`, r.status === 403, String(r.status))
  }
  const pre = await fetch(`${BASE}/api/bugs`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-requested-with,content-type' } })
  check('CORS preflight from a foreign Origin is not approved (no Access-Control-Allow-Origin)', !pre.headers.get('access-control-allow-origin'), pre.headers.get('access-control-allow-origin') ?? '')
  const get = await fetch(`${BASE}/api/bugs`, { headers: { Origin: 'https://evil.example', Cookie: `tcms-access=${s.qa}` } })
  check('CORS: API answers carry no Access-Control-Allow-Origin', !get.headers.get('access-control-allow-origin') && !get.headers.get('access-control-allow-credentials'))
}

// ---------- section 7: CSV import ----------

async function csvImport(s, e) {
  section('7 CSV / file import')
  const post = (bodyObj) => http('POST', '/api/test-cases?action=import', { token: s.qa, body: { moduleId: e.moduleId, ...bodyObj } })
  const rows = Array.from({ length: 201 }, (_, i) => `sec many ${i}`).join('\n')
  check('more than 200 rows: 400', (await post({ fileName: 'many.csv', csv: `title\n${rows}\n` })).status === 400)
  check('wrong file type (.exe): 400', (await post({ fileName: 'tool.exe', csv: 'title\nx\n' })).status === 400)
  check('binary garbage: 400 (no title column)', (await post({ fileName: 'bin.csv', csv: Buffer.from(Array.from({ length: 2000 }, (_, i) => (i * 7) % 256)).toString('latin1') })).status === 400)
  const huge = await post({ fileName: 'huge.csv', csv: `title\n"${'A'.repeat(1_100_000)}"\n` })
  check('file over 1 MB: 400', huge.status === 400, String(huge.status))
  const bigCell = await post({ fileName: 'cell.csv', csv: `title\n"${'B'.repeat(900_000)}"\n` })
  check('one 900 KB cell: refused cleanly (400, or the row reported as failed — never 500)', bigCell.status === 400 || (bigCell.status === 200 && bigCell.json?.imported === 0 && bigCell.json?.failed === 1), `${bigCell.status} imported=${bigCell.json?.imported}`)
  const formula = await post({ fileName: 'formula.csv', csv: 'title,description\n"=HYPERLINK(""https://evil.example"",""x"")",+cmd\n' })
  for (const r of formula.json?.results ?? []) if (r.testCaseId) created.cases.push(r.testCaseId)
  check('formula-looking cell is imported as plain text', formula.status === 200, String(formula.status))
  const { toCsv } = await import(pathToFileURL(path.join(ROOT, 'src/lib/csv-export.ts')).href)
  const out = toCsv([['=1+1', '+cmd', '-2+3', '@SUM(A1)', '\tTAB', 'plain']])
  const cells = out.trim().split(',')
  check('CSV export neutralises = + - @ tab cells (formula injection)', cells.slice(0, 5).every((c) => /^"?'/.test(c)) && cells[5].replace(/"/g, '') === 'plain', out.trim())
  const up = new FormData()
  up.append('title', `sec upload ${STAMP}`)
  up.append('file', new Blob([new Uint8Array(12 * 1024 * 1024)]), 'big.bin')
  const res = await fetch(`${BASE}/api/wiki?action=upload`, { method: 'POST', headers: { 'X-Requested-With': 'tcms', Origin: BASE, Cookie: `tcms-access=${s.qa}` }, body: up })
  check('wiki upload over the limit (12 MB): 413/400', res.status === 413 || res.status === 400, String(res.status))
}

// ---------- section 8: headers ----------

async function headers() {
  section('8 security headers')
  // Dev mode is recognised by the Next.js dev tools in the page; a production build ships none.
  const isDevServer = (await (await fetch(`${BASE}/login`)).text()).includes('next-devtools')
  console.log(`      server mode: ${isDevServer ? 'development (next dev)' : 'production build'}`)
  for (const url of ['/login', '/api/ready']) {
    const evalCsp = (await fetch(`${BASE}${url}`)).headers.get('content-security-policy') ?? ''
    if (isDevServer) {
      if (/'unsafe-eval'/.test(evalCsp) && url === '/login') info('CSP unsafe-eval', "allowed on the dev server only (React needs eval() in development; next.config.ts DEV_SCRIPT_EVAL)")
    } else {
      check(`${url}: production CSP has no 'unsafe-eval'`, !/'unsafe-eval'/.test(evalCsp), evalCsp.match(/script-src[^;]*/)?.[0] ?? '')
    }
  }
  for (const url of ['/login', '/api/ready']) {
    const r = await fetch(`${BASE}${url}`)
    const csp = r.headers.get('content-security-policy') ?? ''
    check(`${url}: CSP with frame-ancestors 'none', object-src 'none', base-uri, form-action`, /frame-ancestors 'none'/.test(csp) && /object-src 'none'/.test(csp) && /base-uri 'self'/.test(csp) && /form-action 'self'/.test(csp))
    check(`${url}: X-Frame-Options DENY`, r.headers.get('x-frame-options') === 'DENY')
    check(`${url}: X-Content-Type-Options nosniff`, r.headers.get('x-content-type-options') === 'nosniff')
    check(`${url}: Referrer-Policy strict-origin-when-cross-origin`, r.headers.get('referrer-policy') === 'strict-origin-when-cross-origin')
    check(`${url}: Strict-Transport-Security (browsers apply it over HTTPS only)`, /max-age=\d{7,}/.test(r.headers.get('strict-transport-security') ?? ''))
    check(`${url}: Permissions-Policy set`, Boolean(r.headers.get('permissions-policy')))
    if (/'unsafe-inline'/.test(csp) && url === '/login') info('CSP script-src', "'unsafe-inline' is still allowed (Next.js inline bootstrap); a nonce-based CSP needs next.config.ts changes (backlog)")
    if (r.headers.get('x-powered-by') && url === '/login') info('X-Powered-By', `"${r.headers.get('x-powered-by')}" is sent; poweredByHeader: false needs a next.config.ts edit (backlog)`)
  }
  const api = await fetch(`${BASE}/api/ready`)
  check('API answers are no-store', /no-store/.test(api.headers.get('cache-control') ?? ''))
}

// ---------- section 9: error leaks ----------

async function errorLeaks(s, e) {
  section('9 error leaks')
  const probes = [
    ['malformed JSON body', () => http('POST', '/api/bugs', { token: s.qa, raw: '{"title": "x", bad json', headers: { 'Content-Type': 'application/json' } })],
    ['non-numeric id', () => http('GET', '/api/test-cases?id=abc', { token: s.qa })],
    ['20-digit id', () => http('GET', '/api/bugs?id=99999999999999999999', { token: s.qa })],
    ['missing foreign key', () => http('POST', '/api/bugs', { token: s.qa, body: { title: 'sec fk', description: 'x', moduleId: '999999999' } })],
    ['unknown action', () => http('GET', '/api/test-cases?id=1&action=%00%27', { token: s.qa })],
    ['unknown API route', () => http('GET', '/api/does-not-exist', { token: s.qa })],
    ['wrong method', () => http('PATCH', '/api/bugs', { token: s.qa, body: {} })],
    ['wrong type in body', () => http('POST', '/api/bugs', { token: s.qa, body: { title: { $gt: '' }, description: [1, 2], moduleId: { id: 1 } } })],
    ['stale update', () => http('PUT', `/api/test-cases?id=${e.caseId}`, { token: s.qa, body: { title: 'x', expectedUpdatedAt: '2000-01-01T00:00:00.000Z' } })],
  ]
  const bad = []
  for (const [name, fn] of probes) {
    const r = await fn()
    if (r.status >= 500) bad.push(`${name}=${r.status}`)
    if (/json/.test(r.headers.get('content-type') ?? '') && LEAK_RE.test(r.text)) bad.push(`${name} leaks`)
  }
  check(`${probes.length} error probes: no 500, no stack / SQL / file path`, bad.length === 0, bad.join(' '))
  check(`every error answer of the whole run is clean (${leakHits.length} leak hits)`, leakHits.length === 0, leakHits.slice(0, 5).join(' | '))
}

// ---------- section 10: secrets ----------

function secretValues() {
  const names = ['JWT_SECRET', 'WS_NOTIFY_SECRET', 'SMTP_PASS', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_LOG_BOT_TOKEN', 'CREWDESK_TOKEN', 'CREWDESK_LOGIN_PASSWORD']
  const out = names.map((n) => [n, process.env[n] ?? '']).filter(([, v]) => v.length >= 8)
  for (const n of ['DATABASE_URL', 'DIRECT_URL', 'BACKUP_DATABASE_URL']) {
    try {
      const pw = decodeURIComponent(new URL(process.env[n] ?? '').password)
      if (pw.length >= 8) out.push([`${n} (password)`, pw])
    } catch { /* not set */ }
  }
  return out
}

async function secrets(s, u) {
  section('10 secrets (key NAMES only are printed)')
  const values = secretValues()
  check(`secret values available to compare: ${values.map(([n]) => n).join(', ') || '-'}`, values.length > 0)
  const staticDir = path.join(BUILD_DIR, 'static')
  if (existsSync(staticDir)) {
    const files = walkFiles(staticDir, /\.(js|css|json|html|txt)$/)
    const found = new Set()
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      for (const [n, v] of values) if (text.includes(v)) found.add(n)
    }
    check(`client bundle: no secret value in ${files.length} files under ${path.relative(ROOT, staticDir) || staticDir}`, found.size === 0, [...found].join(','))
  } else {
    info('client bundle', `${staticDir} not found — run against a build (SECURITY_BUILD_DIR)`)
  }
  const publicKeys = Object.keys(process.env).filter((k) => k.startsWith('NEXT_PUBLIC_'))
  check(`NEXT_PUBLIC_ keys hold no secret (${publicKeys.join(', ') || 'none'})`, publicKeys.every((k) => !/SECRET|PASS|TOKEN|KEY|DATABASE/.test(k)))
  const pages = ['/login', '/dashboard']
  for (const p of pages) {
    const html = await (await fetch(`${BASE}${p}`, { headers: { Cookie: `tcms-access=${s.qa}` } })).text()
    check(`${p} HTML carries no secret value`, !values.some(([, v]) => html.includes(v)))
  }
  const me = await http('GET', '/api/auth', { token: s.qa })
  check('session API never returns a password hash', !/passwordHash|password_hash|\$2[aby]\$/.test(me.text))
  const usersList = await http('GET', '/api/users', { token: s.vp })
  check('users list never returns a password hash', !/passwordHash|password_hash|\$2[aby]\$/.test(usersList.text))
  const logDir = process.env.SECURITY_LOG_DIR || path.join(ROOT, process.env.LOG_DIR || 'logs')
  if (existsSync(logDir)) {
    const day = new Date().toISOString().slice(0, 10)
    const logs = readdirSync(logDir).filter((f) => f.includes(day)).map((f) => path.join(logDir, f))
    const found = new Set()
    const fixturePasswords = Object.values(u).map((x) => x.password)
    for (const f of logs) {
      if (statSync(f).size > 200 * 1024 * 1024) continue
      const text = readFileSync(f, 'utf8')
      for (const [n, v] of values) if (text.includes(v)) found.add(n)
      if (fixturePasswords.some((pw) => text.includes(pw))) found.add('a user password')
      if (/\$2[aby]\$\d\d\$/.test(text)) found.add('a bcrypt hash')
      if (/eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\./.test(text)) found.add('a JWT')
    }
    check(`log files of today (${logs.length}): no secret, password, hash or token`, found.size === 0, [...found].join(','))
  } else info('log files', `${logDir} not found`)
}

// ---------- section 11: mass assignment ----------

async function massAssignment(s, u, e) {
  section('11 mass assignment')
  const before = await http('GET', '/api/auth', { token: s.qa })
  await http('PUT', '/api/auth', { token: s.qa, body: { fullName: `Security qa ${STAMP}`, role: 'vp', userId: u.vp.userId, email: 'owned@evil.example', isActive: false, passwordHash: 'x', permissions: ['manage_permissions'] } })
  const after = await http('GET', '/api/auth', { token: s.qa })
  check('profile update ignores role / userId / email / isActive / passwordHash / permissions',
    after.json?.user?.role === 'qa_engineer' && after.json?.user?.email === before.json?.user?.email && after.json?.user?.userId === u.qa.userId &&
    !(after.json?.permissions ?? []).includes('manage_permissions'), JSON.stringify(after.json?.user ?? {}).slice(0, 120))
  const bug = await http('POST', '/api/bugs', { token: s.qa, body: { title: `sec mass ${STAMP}`, description: 'x', moduleId: e.moduleId, bugId: '1', reportedBy: u.vp.userId, reportedById: u.vp.userId, createdAt: '2000-01-01', status: 'closed', assignedToId: u.vp.userId } })
  if (bug.json?.bugId) created.bugs.push(bug.json.bugId)
  check('bug create: assigning someone without assign_bug is refused (403)', bug.status === 403, `${bug.status} ${JSON.stringify(bug.json).slice(0, 120)}`)
  const bug2 = await http('POST', '/api/bugs', { token: s.qa, body: { title: `sec mass2 ${STAMP}`, description: 'x', moduleId: e.moduleId, bugId: '1', reportedBy: u.vp.userId, createdAt: '2000-01-01' } })
  if (bug2.json?.bugId) created.bugs.push(bug2.json.bugId)
  check('bug create: extra bugId / reportedBy / createdAt are ignored', bug2.json?.bugId !== '1' && bug2.json?.reportedById === u.qa.userId && !String(bug2.json?.createdAt ?? '').startsWith('2000'), JSON.stringify(bug2.json).slice(0, 160))
  const tc = await http('POST', '/api/test-cases', { token: s.qa, body: { title: `sec mass ${STAMP}`, moduleId: e.moduleId, description: 'x', authorId: u.vp.userId, version: 99, status: 'approved', testCaseId: '1' } })
  if (tc.json?.testCaseId) created.cases.push(tc.json.testCaseId)
  check('test case create: author = caller, version 1, status draft, new id', tc.json?.authorId === u.qa.userId && Number(tc.json?.version) === 1 && tc.json?.status === 'draft' && tc.json?.testCaseId !== '1', JSON.stringify({ a: tc.json?.authorId, v: tc.json?.version, s: tc.json?.status }))
  const mod = await http('POST', '/api/modules', { token: s.manager, body: { name: `sec mass ${STAMP}`, ownerId: u.vp.userId } })
  if (mod.json?.moduleId) created.modules.push(mod.json.moduleId)
  check('module create: owner = caller (ownerId ignored)', (mod.json?.ownerId ?? mod.json?.owner?.userId) === u.manager.userId, JSON.stringify(mod.json ?? {}).slice(0, 120))
  const inv = await http('POST', '/api/users', { token: s.manager, body: { email: `sec-inv-${STAMP}@tcms.test`, fullName: 'Invited', password: 'Invite123', role: 'vp' } })
  check('manager cannot create a VP account (403)', inv.status === 403, String(inv.status))
  const promote = await http('PUT', `/api/users?id=${u.viewer.userId}`, { token: s.manager, body: { role: 'manager' } })
  check('manager cannot change roles (403)', promote.status === 403, String(promote.status))
  const self = await http('PUT', `/api/users?id=${u.vp.userId}`, { token: s.vp, body: { role: 'viewer' } })
  check('nobody changes their own role (403)', self.status === 403, String(self.status))
  const reg = await http('POST', '/api/auth?path=register', { body: { fullName: 'Sec Reg', email: `sec-reg-${STAMP}@tcms.test`, password: 'Register123', role: 'vp' } })
  tempUsers.emails.push(`sec-reg-${STAMP}@tcms.test`)
  if (reg.json?.user?.userId) tempUsers.userIds.push(reg.json.user.userId)
  check('register: role field ignored (viewer) or signup off (403)', reg.status === 403 || reg.json?.user?.role === 'viewer', `${reg.status} ${reg.json?.user?.role ?? ''}`)
}

// ---------- section 12: request limits ----------

async function limits(s) {
  section('12 request limits')
  const big = await http('POST', '/api/bugs', { token: s.qa, raw: JSON.stringify({ title: 'x', description: 'y'.repeat(3 * 1024 * 1024) }), headers: { 'Content-Type': 'application/json' } })
  check('3 MB JSON body: 413', big.status === 413, String(big.status))
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"title":"x"}')); c.close() } })
  const chunked = await http('POST', '/api/bugs', { token: s.qa, raw: stream, headers: { 'Content-Type': 'application/json' } })
  check('chunked body without length: 411', chunked.status === 411, String(chunked.status))
  const deep = await http('POST', '/api/bugs', { token: s.qa, raw: `${'['.repeat(50_000)}${']'.repeat(50_000)}`, headers: { 'Content-Type': 'application/json' } })
  check('50 000-level nested JSON: clean 400', deep.status === 400, String(deep.status))
  const wrongType = await http('POST', '/api/bugs', { token: s.qa, raw: '<xml/>', headers: { 'Content-Type': 'application/xml' } })
  check('XML body: clean 400', wrongType.status === 400, String(wrongType.status))
  const many = await Promise.all(Array.from({ length: 40 }, () => http('GET', '/api/test-cases?pageSize=100000', { token: s.qa })))
  check('40 parallel list requests with pageSize=100000: all 200, capped page size', many.every((r) => r.status === 200 && (r.json?.pageSize ?? 0) <= 100), many.map((r) => r.status).filter((x) => x !== 200).join(','))
  const ready = await http('GET', '/api/ready')
  check('the app is still up after the abuse (/api/ready 200)', ready.status === 200, String(ready.status))
}

// ---------- section 13: Crew Desk ----------

async function crewDesk(s) {
  section('13 Crew Desk (key never in the browser, host only from .env)')
  const values = secretValues()
  const cfg = await http('GET', '/api/integrations/crewdesk?path=config', { token: s.vp })
  check('config endpoint answers (200)', cfg.status === 200, String(cfg.status))
  check('config endpoint carries no secret value', !values.some(([, v]) => cfg.text.includes(v)))
  check('config endpoint has no token / password field', !/"(token|password|loginPassword|apiKey|secret)"\s*:\s*"[^"]+"/i.test(cfg.text))
  const client = readFileSync(path.join(ROOT, 'src/lib/server/crewdesk.client.ts'), 'utf8')
  const fetches = client.match(/fetch\(`[^`]*`/g) ?? []
  check(`client: every fetch() targets \${baseUrl} from .env (${fetches.length} calls)`, fetches.length > 0 && fetches.every((f) => f.startsWith('fetch(`${baseUrl}')), fetches.join(' '))
  const config = readFileSync(path.join(ROOT, 'src/lib/server/config.ts'), 'utf8')
  check('config: no built-in Crew Desk address', /CREWDESK_BASE_URL = str\('CREWDESK_BASE_URL'\)/.test(config))
  const bad = []
  for (const ticketId of ['../../admin', '1355/../../x', '1355@evil.example', 'http://evil.example', '1355%2F..']) {
    const r = await http('POST', '/api/integrations/crewdesk?path=lookup', { token: s.vp, body: { ticketId, baseUrl: 'http://evil.example', url: 'http://evil.example' } })
    if (r.status !== 400) bad.push(`${ticketId}=${r.status}`)
  }
  check('ticket ids with paths / hosts / URLs are refused (400)', bad.length === 0, bad.join(' '))
}

// ---------- run ----------

async function cleanup() {
  section('cleanup')
  try {
    await sqlOnce(async (db) => {
      if (wikiIds.length) await db.$executeRaw`DELETE FROM notifications WHERE entity_type = 'wiki_document' AND entity_id IN (${Prisma.join(wikiIds)})`
      if (wikiIds.length) await db.$executeRaw`DELETE FROM wiki_documents WHERE wiki_document_id IN (${Prisma.join(wikiIds)})`
      const extra = await db.$queryRaw`SELECT wiki_document_id FROM wiki_documents WHERE author_id IN (${Prisma.join(tempUsers.userIds.length ? tempUsers.userIds : ['0'])})`
      if (extra.length) await db.$executeRaw`DELETE FROM wiki_documents WHERE wiki_document_id IN (${Prisma.join(extra.map((r) => r.wiki_document_id))})`
      // Cases created by the fixtures (CSV imports) that the API answer did not list.
      const cases = await db.$queryRaw`SELECT test_case_id FROM test_cases WHERE author_id IN (${Prisma.join(tempUsers.userIds.length ? tempUsers.userIds : ['0'])})`
      for (const r of cases) if (!created.cases.includes(r.test_case_id)) created.cases.push(r.test_case_id)
      const bugs = await db.$queryRaw`SELECT bug_id FROM bugs WHERE reported_by_id IN (${Prisma.join(tempUsers.userIds.length ? tempUsers.userIds : ['0'])})`
      for (const r of bugs) if (!created.bugs.includes(r.bug_id)) created.bugs.push(r.bug_id)
      const mods = await db.$queryRaw`SELECT module_id FROM modules WHERE created_by_id IN (${Prisma.join(tempUsers.userIds.length ? tempUsers.userIds : ['0'])}) ORDER BY depth DESC`
      for (const r of mods) if (!created.modules.includes(r.module_id)) created.modules.push(r.module_id)
      const reports = await db.$queryRaw`SELECT task_report_id FROM task_reports WHERE reported_by_id IN (${Prisma.join(tempUsers.userIds.length ? tempUsers.userIds : ['0'])})`
      for (const r of reports) if (!created.taskReports.includes(r.task_report_id)) created.taskReports.push(r.task_report_id)
    })
  } catch (err) {
    check('cleanup: wiki documents + id collection', false, err.message)
  }
  await cleanupRunEntities(check, created, tempUsers)
  const left = await sqlOnce((db) => db.$queryRaw`SELECT
    (SELECT COUNT(*) FROM users WHERE email LIKE ${`sec-%-${STAMP}@tcms.test`}) AS users,
    (SELECT COUNT(*) FROM login_attempts WHERE email LIKE ${`sec-%${STAMP}%`}) AS attempts`)
  check('residue: no fixture user and no login_attempts row of this run left', Number(left[0].users) === 0 && Number(left[0].attempts) === 0, `users=${left[0].users} attempts=${left[0].attempts}`)
}

async function main() {
  console.log(`SECURITY SUITE against ${BASE} (stamp ${STAMP})`)
  const started = Date.now()
  try {
    const u = await setupFixtures()
    const s = {}
    for (const role of ['vp', 'manager', 'product', 'developer', 'qa', 'qa2', 'viewer']) {
      const r = await login(u[role].email, u[role].password)
      if (!r.token) throw new Error(`fixture login failed (${role}: ${r.status})`)
      s[role] = r.token
    }
    const e = await setupEntities(s, u)
    await accessControl(s, u, e)
    await sessions(s, u)
    await openRedirect()
    await sqlInjection(s, e)
    await xss(s, u, e)
    await csrf(s, e)
    await csvImport(s, e)
    await headers()
    await errorLeaks(s, e)
    await secrets(s, u)
    await massAssignment(s, u, e)
    await limits(s)
    await crewDesk(s)
  } catch (err) {
    check('run aborted', false, err.message)
  } finally {
    await cleanup()
  }
  console.log(`\nFINDINGS FOR REVIEW (${findings.length}):`)
  for (const f of findings) console.log(`  - ${f}`)
  console.log(`\nRUNTIME ${Math.round((Date.now() - started) / 1000)} s`)
  console.log(`SECURITY RESULT: ${pass} passed, ${fail} failed`)
  process.exitCode = fail ? 1 : 0
}

main()
