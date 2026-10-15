// E2E: module review bulk-approve (approve-all) must also be restricted to
// the assigned reviewer — even when qa2 holds perform_review permission.
const BASE = 'http://localhost:3000'

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth?path=login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const json = await res.json()
  if (!json?.accessToken) throw new Error(`login failed for ${email}`)
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
  const [teamlead, qa1, qa2] = await Promise.all([
    login('teamlead@tcms.com', 'Lead@123'),
    login('qa1@tcms.com', 'QA@12345'),
    login('qa2@tcms.com', 'QA@12345'),
  ])

  // Find a module containing an eligible (needs_revision/draft) test case.
  const tcRes = await api(teamlead, '/api/test-cases')
  const d = tcRes.body?.data ?? []
  const items = Array.isArray(d) ? d : (d.items ?? [])
  const eligible = items.find((tc) => tc.status === 'needs_revision' || tc.status === 'draft')
  if (!eligible) throw new Error('no eligible test case for a module review')
  console.log('module:', eligible.moduleId, '| eligible case:', eligible.title)

  const usersRes = await api(teamlead, '/api/users')
  const users = usersRes.body?.data ?? []
  const qa1Id = (Array.isArray(users) ? users : []).find((u) => u.email === 'qa1@tcms.com')?.userId

  // Submit module review, reviewer = qa1.
  const sub = await api(teamlead, `/api/modules?id=${eligible.moduleId}&action=submit-review`, {
    method: 'PUT',
    body: JSON.stringify({ reviewerId: qa1Id, includeSubmodules: false }),
  })
  if (sub.status !== 200) throw new Error('module submit-review failed: ' + JSON.stringify(sub.body).slice(0, 300))
  const modReview = sub.body.moduleReview ?? sub.body
  console.log('module review:', modReview.moduleReviewRequestId)

  // qa2 (has perform_review but NOT assigned) -> 403
  const qa2Try = await api(qa2, `/api/module-reviews?id=${modReview.moduleReviewRequestId}&action=approve-all`, {
    method: 'POST',
    body: JSON.stringify({ comment: 'qa2 sneaking in' }),
  })
  console.log('qa2 approve-all ->', qa2Try.status, JSON.stringify(qa2Try.body?.error ?? '').slice(0, 100))
  if (qa2Try.status !== 403) throw new Error('FAIL: qa2 was NOT blocked on approve-all')

  // qa1 (assigned) -> 200
  const qa1Try = await api(qa1, `/api/module-reviews?id=${modReview.moduleReviewRequestId}&action=approve-all`, {
    method: 'POST',
    body: JSON.stringify({ comment: 'bulk approved' }),
  })
  console.log('qa1 approve-all ->', qa1Try.status, qa1Try.body?.approvedCount !== undefined ? `approvedCount=${qa1Try.body.approvedCount}` : JSON.stringify(qa1Try.body).slice(0, 120))
  if (qa1Try.status !== 200) throw new Error('FAIL: qa1 (assigned) could not approve-all')

  console.log('\nMODULE APPROVE-ALL GATE PASSED')
}

main().catch((e) => {
  console.error('E2E FAILED:', e.message)
  process.exit(1)
})
