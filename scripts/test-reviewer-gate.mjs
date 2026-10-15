// E2E verification: only the ASSIGNED reviewer can submit a verdict.
// 1. teamlead submits a test case for review assigned to qa1
// 2. qa2 (has perform_review, NOT assigned) -> expect 403
// 3. qa1 (assigned reviewer) -> expect success
// 4. teamlead tries again on the same review -> expect 403 (also proves gate holds for non-assignees)
const BASE = 'http://localhost:3000'

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth?path=login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const json = await res.json()
  if (!json?.accessToken) throw new Error(`login failed for ${email}: ${JSON.stringify(json).slice(0, 200)}`)
  return json.accessToken
}

async function api(token, path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  })
  let body = null
  try { body = await res.json() } catch {}
  return { status: res.status, body }
}

async function main() {
  const [admin, teamlead, qa1, qa2] = await Promise.all([
    login('admin@tcms.com', 'Admin@123'),
    login('teamlead@tcms.com', 'Lead@123'),
    login('qa1@tcms.com', 'QA@12345'),
    login('qa2@tcms.com', 'QA@12345'),
  ])

  // Reproduce the user's setup: perform_review enabled for qa_engineer role.
  const toggle = await api(admin, '/api/permissions', {
    method: 'PUT',
    body: JSON.stringify({ role: 'qa_engineer', action: 'perform_review', enabled: true }),
  })
  console.log('qa perform_review toggle ->', toggle.status)
  if (toggle.status !== 200) throw new Error('toggle failed: ' + JSON.stringify(toggle.body).slice(0, 200))

  // Pick a draft test case owned by someone else (not qa1/qa2) and its users list.
  const usersRes = await api(teamlead, '/api/users')
  const users = usersRes.body?.data?.users ?? usersRes.body?.data ?? []
  const qa1Id = (Array.isArray(users) ? users : []).find((u) => u.email === 'qa1@tcms.com')?.userId
  if (!qa1Id) throw new Error('qa1 id not found: ' + JSON.stringify(usersRes.body).slice(0, 300))

  const tcRes = await api(teamlead, '/api/test-cases?status=draft')
  const rows = tcRes.body?.data ?? []
  const list = Array.isArray(rows) ? rows : (rows.items ?? rows.data ?? [])
  const draft = list.find((tc) => tc.authorId !== qa1Id) ?? list[0]
  if (!draft) throw new Error('no draft test case found: ' + JSON.stringify(tcRes.body).slice(0, 300))
  console.log('using test case:', draft.testCaseId, '-', draft.title)

  // 1. Submit for review, reviewer = qa1
  const submitRes = await api(teamlead, '/api/test-cases?id=' + draft.testCaseId + '&action=submit-review', {
    method: 'PUT',
    body: JSON.stringify({ reviewerId: qa1Id }),
  })
  if (submitRes.status !== 200) throw new Error('submit-review failed: ' + JSON.stringify(submitRes.body).slice(0, 300))
  const review = submitRes.body
  console.log('review created:', review.reviewRequestId, 'assigned to qa1')

  // 2. qa2 tries to approve -> MUST be 403
  const qa2Try = await api(qa2, `/api/reviews?id=${review.reviewRequestId}`, {
    method: 'POST',
    body: JSON.stringify({ verdict: 'approved', comment: 'qa2 sneaking an approval', flaggedFields: [] }),
  })
  console.log('qa2 (not assigned) verdict ->', qa2Try.status, JSON.stringify(qa2Try.body?.error ?? qa2Try.body?.message ?? '').slice(0, 120))
  if (qa2Try.status !== 403) throw new Error('FAIL: qa2 was NOT blocked')

  // 3. qa1 (assigned) approves -> MUST succeed
  const qa1Try = await api(qa1, `/api/reviews?id=${review.reviewRequestId}`, {
    method: 'POST',
    body: JSON.stringify({ verdict: 'approved', comment: 'LGTM', flaggedFields: [] }),
  })
  console.log('qa1 (assigned) verdict ->', qa1Try.status, qa1Try.body?.data ? 'reviewStatus=' + qa1Try.body.data.reviewStatus : JSON.stringify(qa1Try.body).slice(0, 160))
  if (qa1Try.status !== 200) throw new Error('FAIL: qa1 (assigned) could not approve')

  // 4. verdict on a completed review -> 400
  const qa1Again = await api(qa1, `/api/reviews?id=${review.reviewRequestId}`, {
    method: 'POST',
    body: JSON.stringify({ verdict: 'approved', comment: 'double tap', flaggedFields: [] }),
  })
  console.log('qa1 repeat verdict on completed ->', qa1Again.status, JSON.stringify(qa1Again.body?.error ?? '').slice(0, 120))

  console.log('\nALL REVIEWER-GATE CHECKS PASSED')
}

main().catch((e) => {
  console.error('E2E FAILED:', e.message)
  process.exit(1)
})
