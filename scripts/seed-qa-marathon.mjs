/**
 * QA MARATHON SEED (2026-10-09) — owner asked for 200+ test cases imported
 * through the SHEET (CSV import) path and reviews performed by people of
 * every role (product, developer, QA engineer, manager, VP).
 *
 * What it does (idempotent by email prefix `qamarathon.` and module name):
 *   1. Admin login.
 *   2. Creates two fresh modules: "QA Marathon Alpha" + "QA Marathon Beta".
 *   3. Generates 105 realistic CSV rows per module and imports them through
 *      POST /api/test-cases?action=import  (the exact API the Import tab
 *      uses) -> 210 draft test cases.
 *   4. Grants perform_review to developer + qa_engineer via the VP-togglable
 *      permission matrix (they lack it by default — verdicts need it).
 *   5. Invites 5 reviewers, one per role: product, developer, qa_engineer,
 *      manager, vp (emails qamarathon.<role>@tcms.dev, password QaMarathon@2026).
 *   6. Admin (author) submits one review per reviewer on a fresh test case.
 *   7. Each reviewer signs in and posts their own verdict (mixed approve /
 *      needs_revision / fail) -> review events by every single role.
 *
 * Prints a summary JSON at the end for the test report.
 */
const BASE = 'http://localhost:3000'
const PASSWORD = 'QaMarathon@2026'
const stamp = Date.now().toString().slice(-6)

async function req(method, path, { body, jar } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms' }
  if (jar) headers.Cookie = jar
  if (method !== 'GET') headers.Origin = BASE
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json, setCookie: res.headers.getSetCookie?.() ?? [] }
}
function jarOf(res) {
  return res.setCookie.map((c) => c.split(';')[0]).join('; ')
}
function csvCell(v) {
  return `"${String(v).replace(/"/g, '""')}"`
}

// ---------- test-case content generator (realistic, varied) ----------
const AREAS = ['login', 'signup', 'password reset', 'session timeout', 'checkout', 'refund flow', 'search ranking', 'filters', 'pagination', 'file upload', 'export', 'notifications', 'permissions', 'audit trail', 'rate limits', 'dark mode', 'localization', 'accessibility', 'responsive layout', 'print view']
const KINDS = ['functional', 'negative', 'boundary', 'security', 'usability', 'compatibility', 'performance']
const VERBS = ['Verify', 'Validate', 'Confirm', 'Ensure']

function makeRow(i, moduleName) {
  const area = AREAS[i % AREAS.length]
  const kind = KINDS[i % KINDS.length]
  const verb = VERBS[i % VERBS.length]
  const title = `${verb} ${area} handles case #${i + 1} (${kind} — ${moduleName})`
  const description = `${kind.charAt(0).toUpperCase() + kind.slice(1)} check #${i + 1}: exercise the ${area} flow with a ${kind} dataset and confirm the system behaves per spec. Covers the acceptance criteria for the ${area} epic, iteration ${Math.floor(i / AREAS.length) + 1}.`
  const preconditions = `User account exists with a test profile; ${area} feature flag is ON; environment seeded with fixture set ${(i % 5) + 1}.`
  const expectedResult = `The ${area} flow completes without errors, the response matches the contract for ${kind} input, and the audit trail records event ${i + 1}.`
  const priority = ['P0', 'P1', 'P2', 'P3'][i % 4]
  const tags = [kind, area.replace(/\s+/g, '-'), `sprint-${(i % 6) + 1}`].join(';')
  return { title, description, preconditions, priority, expectedResult, tags }
}

function makeCsv(rows) {
  const header = 'title,description,preconditions,priority,expected_result,tags'
  const lines = rows.map((r) => [r.title, r.description, r.preconditions, r.priority, r.expectedResult, r.tags].map(csvCell).join(','))
  return header + '\n' + lines.join('\n')
}

// ---------- main ----------
const login = await req('POST', '/api/auth?path=login', { body: { email: 'admin@tcms.com', password: 'Admin@123' } })
if (login.status !== 200) { console.error('FATAL: admin login failed', login.status, JSON.stringify(login.json)); process.exit(1) }
const adminJar = jarOf(login)
const me = login.json?.user
console.log(`admin: ${me?.email} role=${me?.role}`)

// 1+2. modules
const modulesToCreate = [
  { name: `QA Marathon Alpha`, description: 'Volume-seeded module A (QA marathon 2026-10-09)' },
  { name: `QA Marathon Beta`, description: 'Volume-seeded module B (QA marathon 2026-10-09)' },
]
const moduleIds = []
for (const m of modulesToCreate) {
  const existing = await req('GET', `/api/modules`, { jar: adminJar })
  const flat = existing.json?.flat ?? []
  const found = flat.find((f) => f.name === m.name)
  if (found) { moduleIds.push(found.moduleId); console.log(`module exists: ${m.name}`); continue }
  const created = await req('POST', '/api/modules', { jar: adminJar, body: m })
  if (created.status !== 200 && created.status !== 201) { console.error('FATAL: module create failed', JSON.stringify(created.json)); process.exit(1) }
  moduleIds.push(created.json?.module?.moduleId ?? created.json?.moduleId)
  console.log(`module created: ${m.name}`)
}

// 3. CSV imports — 105 rows x 2 files (cap is 200/file; two files also prove
//    the import works repeatedly).
let created = 0
let failedRows = 0
for (let f = 0; f < 2; f++) {
  const rows = Array.from({ length: 105 }, (_, i) => makeRow(f * 105 + i, modulesToCreate[f].name))
  const csv = makeCsv(rows)
  const res = await req('POST', '/api/test-cases?action=import', {
    jar: adminJar,
    body: { moduleId: moduleIds[f], fileName: `qa-marathon-${f + 1}.csv`, csv },
  })
  if (res.status !== 200) { console.error(`FATAL: import file ${f + 1} failed`, res.status, JSON.stringify(res.json).slice(0, 300)); process.exit(1) }
  const c = (res.json?.results ?? res.json?.data?.results ?? []).filter((r) => r.status === 'created').length
  const fl = (res.json?.results ?? res.json?.data?.results ?? []).filter((r) => r.status === 'failed').length
  created += c
  failedRows += fl
  console.log(`import file ${f + 1}: ${c} created, ${fl} failed rows (status ${res.status})`)
}

// 4. grant perform_review to developer + qa_engineer (matrix override)
const grants = []
for (const role of ['developer', 'qa_engineer']) {
  const put = await req('PUT', '/api/permissions', { jar: adminJar, body: { role, action: 'perform_review', enabled: true } })
  grants.push({ role, action: 'perform_review', status: put.status })
  console.log(`permission grant: ${role}/perform_review -> ${put.status}`)
}

// 5. invite one reviewer per role
const ROLES = ['product', 'developer', 'qa_engineer', 'manager', 'vp']
const reviewers = []
for (const role of ROLES) {
  const email = `qamarathon.${role}@tcms.dev`
  const existing = await req('GET', '/api/users?action=options', { jar: adminJar })
  const found = (existing.json?.data ?? existing.json ?? []).find?.((u) => u.email === email)
  if (!found) {
    const inv = await req('POST', '/api/users', { jar: adminJar, body: { email, fullName: `QA Marathon ${role}`, password: PASSWORD, role } })
    if (inv.status !== 200 && inv.status !== 201) { console.error(`FATAL: invite ${role} failed`, inv.status, JSON.stringify(inv.json).slice(0, 200)); process.exit(1) }
  }
  reviewers.push({ role, email })
}
console.log(`reviewers ready: ${reviewers.map((r) => r.email).join(', ')}`)

// 6. submit one review per reviewer on a fresh case authored by admin
const reviewTargets = []
for (let i = 0; i < reviewers.length; i++) {
  const row = makeRow(900 + i, 'QA Marathon Alpha')
  const create = await req('POST', '/api/test-cases', {
    jar: adminJar,
    body: { title: row.title, moduleId: moduleIds[0], description: row.description, priority: row.priority, expectedResult: row.expectedResult, tags: ['review-demo'] },
  })
  if (create.status !== 200 && create.status !== 201) { console.error('FATAL: review-target case failed', JSON.stringify(create.json).slice(0, 200)); process.exit(1) }
  const tc = create.json?.testCase ?? create.json
  const reviewerOptions = await req('GET', '/api/users?action=options', { jar: adminJar })
  const opt = (reviewerOptions.json?.data ?? reviewerOptions.json ?? []).find?.((u) => u.email === reviewers[i].email)
  const reviewerId = opt?.userId
  const submit = await req('PUT', `/api/test-cases?id=${tc.testCaseId}&action=submit-review`, {
    jar: adminJar,
    body: { reviewerId, dueDate: new Date(Date.now() + 7 * 864e5).toISOString() },
  })
  if (submit.status !== 200 && submit.status !== 201) { console.error(`FATAL: submit-review for ${reviewers[i].role} failed`, submit.status, JSON.stringify(submit.json).slice(0, 200)); process.exit(1) }
  const reviewId = submit.json?.reviewRequestId ?? submit.json?.reviewRequest?.reviewRequestId
  reviewTargets.push({ ...reviewers[i], reviewId, testCaseId: tc.testCaseId })
  console.log(`review submitted: case=${tc.testCaseId.slice(-6)} -> ${reviewers[i].email} (review ${reviewId})`)
}

// 7. verdicts — each reviewer signs in and posts their own verdict
const VERDICTS = {
  product: { verdict: 'approved', comment: 'Acceptance criteria fully covered; product sign-off given.' },
  developer: { verdict: 'needs_revision', comment: 'Step 3 lacks the expected API error code; please add it.', flaggedFields: ['description'] },
  qa_engineer: { verdict: 'approved', comment: 'Reproduced manually with fixture set 2 — passes.' },
  manager: { verdict: 'failed', comment: 'Boundary row missing for the 2^n-1 input; failing this cycle.', flaggedFields: ['expectedResult'] },
  vp: { verdict: 'approved', comment: 'Executive spot-check passed — great coverage of the negative paths.' },
}
const verdictResults = []
for (const target of reviewTargets) {
  const rlogin = await req('POST', '/api/auth?path=login', { body: { email: target.email, password: PASSWORD } })
  if (rlogin.status !== 200) { console.error(`FATAL: reviewer login ${target.email} failed`, rlogin.status); process.exit(1) }
  const rjar = jarOf(rlogin)
  const v = await req('POST', `/api/reviews?id=${target.reviewId}`, { jar: rjar, body: VERDICTS[target.role] })
  verdictResults.push({ role: target.role, status: v.status, verdict: VERDICTS[target.role].verdict })
  console.log(`verdict by ${target.role}: ${v.status} (${VERDICTS[target.role].verdict})`)
}

console.log('\nSUMMARY:' + JSON.stringify({ createdTestCases: created, failedRows, moduleIds, grants, reviewTargets, verdictResults }, null, 2))
