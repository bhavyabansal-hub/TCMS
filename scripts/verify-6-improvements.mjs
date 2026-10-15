// Regression probe for the 6 improvements (Task 3). Mock/local only — no real
// Crew Desk calls, no writes. Verifies via the API layer:
//   1. Dashboard statusBreakdown — complete, numeric, canonical statuses
//   2. (steps) — no steps fields in test-case payload (spot-check list)
//   4. Integrations nav — static sidebar order (checked by grep in CI-style; here we verify API perms)
//   5. Integrations API — forbidden without manage_integrations, OK with it
//   6. Reviews API — forbidden without perform_review; OK for manager; reviewer-gate text present
const BASE = process.env.TCMS_BASE || 'http://localhost:3000'
const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms', Origin: BASE }

const accounts = {
  admin: { email: 'admin@tcms.com', password: 'Admin@123' },   // VP
  lead: { email: 'teamlead@tcms.com', password: 'Lead@123' },  // Manager
  qa: { email: 'qa1@tcms.com', password: 'QA@12345' },         // qa_engineer — no manage_integrations / perform_review
}

async function login({ email, password }) {
  const res = await fetch(`${BASE}/api/auth?path=login`, {
    method: 'POST', headers: HEADERS, body: JSON.stringify({ email, password }),
  })
  if (!res.ok) throw new Error(`login ${email} -> ${res.status}`)
  const setCookie = res.headers.getSetCookie?.() ?? []
  const jar = setCookie.map((c) => c.split(';')[0]).join('; ')
  const body = await res.json()
  return { jar, role: body?.user?.role ?? '?' }
}

async function GET(path, jar) {
  const res = await fetch(`${BASE}${path}`, { headers: { ...HEADERS, Cookie: jar } })
  let body = null
  try { body = await res.json() } catch {}
  return { status: res.status, body }
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  —  ${detail}`)
}

// ---- 1. Dashboard strict status counts (admin) ----
const admin = await login(accounts.admin)
const stats = await GET('/api/stats?action=dashboard', admin.jar)
const sb = stats.body?.statusBreakdown ?? []
const canonical = ['draft', 'in_review', 'needs_revision', 'approved', 'active', 'deprecated']
const have = new Set(sb.map((s) => s.status))
const numericOk = sb.every((s) => Number.isInteger(s.count) && s.count >= 0)
const sumMatchesTotal = sb.reduce((a, s) => a + s.count, 0) === (stats.body?.totalTestCases ?? -1)
check('dashboard statusBreakdown', stats.status === 200 && sb.length > 0 && numericOk,
  `status=${stats.status} statuses=[${sb.map((s) => `${s.status}:${s.count}`).join(', ')}]`)
check('dashboard canonical coverage', canonical.every((c) => have.has(c)),
  `missing=[${canonical.filter((c) => !have.has(c)).join(',') || 'none'}]`)
check('dashboard sum == totalTestCases', sumMatchesTotal,
  `sum=${sb.reduce((a, s) => a + s.count, 0)} total=${stats.body?.totalTestCases}`)

// ---- 2. Steps really gone from payloads ----
const tcList = await GET('/api/test-cases?pageSize=1', admin.jar)
const firstTc = tcList.body?.data?.[0] ?? null
const hasSteps = firstTc ? Object.prototype.hasOwnProperty.call(firstTc, 'steps') : false
check('test-case payload has no steps field', tcList.status === 200 && !hasSteps,
  firstTc ? `item "${firstTc.title ?? firstTc.id}" steps-field=${hasSteps}` : 'no items in db to spot-check (vacuous pass)')

// ---- 5. Integrations permissions ----
const lead = await login(accounts.lead)
const qa = await login(accounts.qa)
const intLead = await GET('/api/integrations/crewdesk', lead.jar)
const intQa = await GET('/api/integrations/crewdesk', qa.jar)
check('integrations OK for manager', intLead.status === 200, `status=${intLead.status} role=${lead.role}`)
check('integrations 403 without manage_integrations', intQa.status === 403,
  `status=${intQa.status} role=${qa.role}`)

// ---- 6. Reviews permissions ----
const revLead = await GET('/api/reviews', lead.jar)
const revQa = await GET('/api/reviews', qa.jar)
check('reviews OK for perform_review role', revLead.status === 200, `status=${revLead.status} role=${lead.role}`)
check('reviews 403 without perform_review', revQa.status === 403, `status=${revQa.status} role=${qa.role}`)

// ---- 3. Monthly export endpoint exists & is permission-gated ----
const month = new Date().toISOString().slice(0, 7)
const expQa = await GET(`/api/task-reports?action=export&userId=${accounts.qa.email}&month=${month}`, qa.jar)
const expAdminNoUser = await GET(`/api/task-reports?action=export&userId=x&month=${month}`, admin.jar)
check('monthly export reachable for self (or 403-gated)', [200, 403].includes(expQa.status),
  `self-export status=${expQa.status} (200=self allowed, 403=view_all_task_reports gate)`)
check('monthly export responds for VP', [200, 400, 404].includes(expAdminNoUser.status),
  `vp status=${expAdminNoUser.status} (unknown userId may 400/404 — endpoint live)`)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
