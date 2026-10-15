// E2E verification: routes + per-page permissions, review ownership, hard delete.
// Run: node scripts/e2e-verify-routes-reviews-delete.mjs
const BASE = 'http://localhost:3000'
const results = []
const log = (name, pass, detail = '') =>
  results.push({ name, pass, detail }) && console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)

// Cookie-session auth: login stores the httpOnly cookie pair from Set-Cookie
// and every later call replays them via the Cookie header. The CSRF guard
// requires the X-Requested-With marker on all mutating calls (the real SPA
// sends the same header).
async function api(path, { method = 'GET', cookies, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'tcms',
      ...(cookies ? { Cookie: cookies } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, json }
}

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth?path=login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms' },
    body: JSON.stringify({ email, password }),
  })
  if (res.status !== 200) {
    let j = null; try { j = await res.json() } catch {}
    throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(j)}`)
  }
  const setCookies = res.headers.getSetCookie?.() ?? []
  const jar = setCookies.map((c) => c.split(';')[0]).join('; ')
  if (!jar.includes('tcms-access=')) throw new Error(`no session cookie for ${email}`)
  return jar
}

// ---------- 1. All 15 page routes render ----------
const pages = ['/', '/dashboard', '/modules', '/test-cases', '/reviews', '/bugs', '/tasks',
  '/reports', '/activity-log', '/notifications', '/settings/users', '/settings/permissions',
  '/settings/profile', '/login']
const admin = await login('admin@tcms.com', 'Admin@123')
for (const p of pages) {
  const res = await fetch(BASE + p, { headers: { Cookie: admin }, redirect: 'manual' })
  log(`page ${p}`, res.status === 200 || res.status === 307, `status=${res.status}`)
}
// deep links
const tcs = await api('/api/test-cases', { cookies: admin })
const someId = tcs.json?.data?.[0]?.testCaseId
if (someId) {
  const res = await fetch(BASE + `/test-cases/${someId}`, { headers: { Cookie: admin } })
  log('deep link /test-cases/[id]', res.status === 200, `status=${res.status}`)
} else log('deep link /test-cases/[id]', false, 'no test case found')
// 404 route
const nf = await fetch(BASE + '/no-such-page')
log('unknown route -> 404 page', nf.status === 404, `status=${nf.status}`)

// ---------- 2. Review ownership: only ASSIGNED reviewer can verdict ----------
// Create a fresh test case, submit it for review assigned to qa1, then try the
// verdict from a DIFFERENT perform_review user (teamlead) -> expect 403.
const mods0 = await api('/api/modules', { cookies: admin })
const modId0 = mods0.json?.flat?.[0]?.moduleId ?? mods0.json?.data?.[0]?.moduleId
log('module list provides target for probes', !!modId0, `status=${mods0.status}`)
const tcForRev = await api('/api/test-cases', {
  method: 'POST', cookies: admin,
  body: { title: 'E2E-REVIEW-OWNERSHIP-PROBE', moduleId: modId0, description: 'Probe case for ownership check', priority: 'P2', steps: [{ stepNumber: 1, action: 'a', expected: 'b' }] },
})
const tcRevId = tcForRev.json?.data?.testCaseId ?? tcForRev.json?.testCaseId
log('create probe test case for review', !!tcRevId, `status=${tcForRev.status}`)
if (tcRevId) {
  const users = await api('/api/users', { cookies: admin })
  const usersArr = users.json?.data ?? users.json ?? []
  const product = (usersArr.find?.((u) => u.email === 'product@tcms.com')) // has perform_review
  const productToken = await login('product@tcms.com', 'Product@123')
  const sub = await api(`/api/test-cases?id=${tcRevId}&action=submit-review`, {
    method: 'PUT', cookies: admin, body: { reviewerId: product?.userId },
  })
  const revId = sub.json?.data?.reviewRequestId ?? sub.json?.reviewRequestId
  log('submit-review creates review request', !!revId, `status=${sub.status}`)
  if (revId) {
    const lead = await login('teamlead@tcms.com', 'Lead@123')
    const v = await api(`/api/reviews?id=${revId}`, {
      method: 'POST', cookies: lead, body: { verdict: 'approved', comment: 'x', flaggedFields: [] },
    })
    log('NON-assigned perform_review user CANNOT verdict (403)', v.status === 403, `status=${v.status} msg=${v.json?.error ?? ''}`)
    const d = await api(`/api/reviews?id=${revId}`, { cookies: lead })
    log('non-participant cannot open review detail (403)', d.status === 403, `status=${d.status}`)
    // ALSO: a user WITHOUT perform_review (qa1) can never verdict — even if assigned
    const qa1Token = await login('qa1@tcms.com', 'QA@12345')
    const vQa = await api(`/api/reviews?id=${revId}`, {
      method: 'POST', cookies: qa1Token, body: { verdict: 'approved', flaggedFields: [] },
    })
    log('user without perform_review CANNOT verdict (403)', vQa.status === 403, `status=${vQa.status} msg=${vQa.j?.error ?? vQa.json?.error ?? ''}`)
    // assigned reviewer CAN verdict
    const ok2 = await api(`/api/reviews?id=${revId}`, {
      method: 'POST', cookies: productToken, body: { verdict: 'approved', flaggedFields: [] },
    })
    log('ASSIGNED reviewer CAN verdict', ok2.status === 200, `status=${ok2.status}`)
  }
}

// ---------- 3. Hard delete test case ----------
// create a throwaway test case as admin, then delete it and confirm it is gone
const created = await api('/api/test-cases', {
  method: 'POST', cookies: admin,
  body: { title: 'E2E-HARDDELETE-PROBE', moduleId: modId0, description: 'Probe case for delete check', priority: 'P3', steps: [{ stepNumber: 1, action: 'a', expected: 'b' }] },
})
if (created.status === 200 || created.status === 201) {
  const delId = (created.json?.data?.testCaseId) || created.json?.testCaseId
  const del = await api(`/api/test-cases?id=${delId}`, { method: 'DELETE', cookies: admin })
  log('DELETE test case succeeds', del.status === 200, `status=${del.status}`)
  const after = await api(`/api/test-cases?id=${delId}`, { cookies: admin })
  log('deleted test case is gone (404)', after.status === 404, `status=${after.status}`)
  const listAgain = await api('/api/test-cases?pageSize=500', { cookies: admin })
  const still = (listAgain.json?.data ?? []).some((t) => t.testCaseId === delId)
  log('deleted test case absent from list', !still, still ? 'STILL PRESENT' : 'clean')
} else {
  log('hard delete setup', false, `create failed: ${created.status} ${JSON.stringify(created.json).slice(0, 150)}`)
}

// ---------- 4. New validation: title/module/description required ----------
const missingDesc = await api('/api/test-cases', {
  method: 'POST', cookies: admin,
  body: { title: 'E2E-NO-DESC', moduleId: modId0, priority: 'P2' },
})
log('create without description is rejected (400)', missingDesc.status === 400, `status=${missingDesc.status}`)
const missingModule = await api('/api/test-cases', {
  method: 'POST', cookies: admin,
  body: { title: 'E2E-NO-MODULE', description: 'x', priority: 'P2' },
})
log('create without module is rejected (400)', missingModule.status === 400, `status=${missingModule.status}`)

// ---------- 5. CSRF: mutating request without the marker is blocked ----------
const csrfProbe = await fetch(`${BASE}/api/test-cases`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' }, // NO X-Requested-With, NO Origin
  body: JSON.stringify({ title: 'CSRF', moduleId: modId0, description: 'x' }),
})
log('mutation without CSRF marker is blocked (403)', csrfProbe.status === 403, `status=${csrfProbe.status}`)

// ---------- 6. Session refresh: rotating cookie pair extends the session ----------
const refreshRes = await fetch(`${BASE}/api/auth?path=refresh`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms', Cookie: admin },
  body: '{}',
})
log('cookie refresh rotates session (200)', refreshRes.status === 200, `status=${refreshRes.status}`)
let refreshBody = null; try { refreshBody = await refreshRes.json() } catch {}
log('refresh response carries NO tokens', !JSON.stringify(refreshBody ?? {}).includes('accessToken'), 'body is cookie-only')

// ---------- 7. CSV import: new template without steps ----------
const tpl = await api('/api/test-cases?action=import-template', { cookies: admin })
const csvText = tpl.json?.data?.csv ?? tpl.json?.csv ?? ''
log('template has no steps column', !csvText.split('\n').some((l) => l.startsWith('title,') && l.includes('steps')), csvText.split('\n').slice(-4)[0] ?? '')
const csvPayload = [
  'title,description,priority,expected_result,tags',
  `CSV import smoke ${Date.now()},Imported without steps,P2,Works,smoke`,
  `Row without description ${Date.now()},,P1,,`,
].join('\n')
const imp = await api('/api/test-cases?action=import', {
  method: 'POST', cookies: admin,
  body: { moduleId: modId0, fileName: 'e2e-smoke.csv', csv: csvPayload },
})
const impRes = imp.json?.data ?? imp.json
log('import accepts steps-less CSV', imp.status === 200 && impRes?.imported === 1, `status=${imp.status} imported=${impRes?.imported} failed=${impRes?.failed}`)
log('import rejects row without description', impRes?.results?.some?.((r) => r.status === 'failed' && /description is required/.test(r.error ?? '')), JSON.stringify(impRes?.results?.filter?.((r) => r.failed || r.status === 'failed') ?? []).slice(0, 120))

// ---------- summary ----------
const failed = results.filter((r) => !r.pass)
console.log(`\n==== ${results.length - failed.length}/${results.length} passed, ${failed.length} failed ====`)
process.exit(failed.length ? 1 : 0)
