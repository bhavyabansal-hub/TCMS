/**
 * QA MARATHON SEED — PHASE 2 (fix-up): the first pass assigned reviews to the
 * auto-picked reviewer because /api/users?action=options does not expose
 * email (match by fullName instead). This pass:
 *   1. Submits one fresh review per role with the CORRECT reviewerId.
 *   2. Each reviewer posts their own verdict (approve/needs-revision/fail mix).
 *   3. Prints a verification summary (review events per role + notifications).
 */
const BASE = 'http://localhost:3000'
const PASSWORD = 'QaMarathon@2026'

async function req(method, path, { body, jar } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms' }
  if (jar) headers.Cookie = jar
  if (method !== 'GET') headers.Origin = BASE
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  return { status: res.status, json: await res.json().catch(() => ({})), setCookie: res.headers.getSetCookie?.() ?? [] }
}
const jarOf = (res) => res.setCookie.map((c) => c.split(';')[0]).join('; ')

const login = await req('POST', '/api/auth?path=login', { body: { email: 'admin@tcms.com', password: 'Admin@123' } })
const adminJar = jarOf(login)
const modules = await req('GET', '/api/modules', { jar: adminJar })
const alpha = (modules.json?.flat ?? []).find((m) => m.name === 'QA Marathon Alpha')
if (!alpha) { console.error('FATAL: QA Marathon Alpha module missing'); process.exit(1) }

const options = await req('GET', '/api/users?action=options', { jar: adminJar })
const opts = options.json // bare array
if (!Array.isArray(opts)) { console.error('FATAL: options not an array', JSON.stringify(opts).slice(0, 200)); process.exit(1) }

const ROLES = ['product', 'developer', 'qa_engineer', 'manager', 'vp']
const VERDICTS = {
  product: { verdict: 'approved', comment: 'Acceptance criteria fully covered; product sign-off given.' },
  developer: { verdict: 'needs_revision', comment: 'Step 3 lacks the expected API error code; please add it.', flaggedFields: ['description'] },
  qa_engineer: { verdict: 'approved', comment: 'Reproduced manually with fixture set 2 — passes.' },
  manager: { verdict: 'failed', comment: 'Boundary row missing for the 2^n-1 input; failing this cycle.', flaggedFields: ['expectedResult'] },
  vp: { verdict: 'approved', comment: 'Executive spot-check passed — great coverage of the negative paths.' },
}

const results = []
for (const role of ROLES) {
  const reviewer = opts.find((u) => u.fullName === `QA Marathon ${role}`)
  if (!reviewer) { console.error(`FATAL: options has no user "QA Marathon ${role}"`); process.exit(1) }
  // fresh case authored by admin
  const create = await req('POST', '/api/test-cases', {
    jar: adminJar,
    body: {
      title: `Review-per-role demo (${role}) — ${Date.now().toString().slice(-6)}`,
      moduleId: alpha.moduleId,
      description: `Seed case for a review performed by a ${role}. Covers the role-coverage requirement of the QA marathon.`,
      priority: 'P1',
      expectedResult: 'Review verdict recorded by the assigned reviewer.',
      tags: ['review-demo', 'qa-marathon'],
    },
  })
  const tc = create.json?.testCase ?? create.json
  const submit = await req('PUT', `/api/test-cases?id=${tc.testCaseId}&action=submit-review`, {
    jar: adminJar,
    body: { reviewerId: reviewer.userId, dueDate: new Date(Date.now() + 7 * 864e5).toISOString() },
  })
  const reviewId = submit.json?.reviewRequestId ?? submit.json?.reviewRequest?.reviewRequestId
  if (!reviewId) { console.error(`FATAL: submit for ${role} failed`, submit.status, JSON.stringify(submit.json).slice(0, 200)); process.exit(1) }

  const rlogin = await req('POST', '/api/auth?path=login', { body: { email: `qamarathon.${role}@tcms.dev`, password: PASSWORD } })
  if (rlogin.status !== 200) { console.error(`FATAL: ${role} login failed`, rlogin.status); process.exit(1) }
  const rjar = jarOf(rlogin)
  const verdict = await req('POST', `/api/reviews?id=${reviewId}`, { jar: rjar, body: VERDICTS[role] })
  results.push({ role, testCaseId: tc.testCaseId, reviewId, submitStatus: submit.status, verdictStatus: verdict.status, verdict: VERDICTS[role].verdict })
  console.log(`${role}: submit=${submit.status} verdict=${verdict.status} (${VERDICTS[role].verdict})`)
}

console.log('\nVERDICT RESULTS: ' + JSON.stringify(results, null, 1))
const allOk = results.every((r) => r.verdictStatus >= 200 && r.verdictStatus < 300)
console.log(allOk ? 'ALL 5 ROLE VERDICTS RECORDED' : 'SOME VERDICTS FAILED')
process.exit(allOk ? 0 : 1)
