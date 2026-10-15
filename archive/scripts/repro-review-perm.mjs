// Reproduce the user's scenario: review assigned to qa1 — can others approve?
// Mirrors their config: perform_review toggled ON for EVERY role.
const BASE = 'http://localhost:3000'
const out = (label, res, body) => console.log(`${label}: HTTP ${res.status} :: ${JSON.stringify(body).slice(0, 160)}`)

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth?path=login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`login failed for ${email}: ${JSON.stringify(data)}`)
  const d = data.data ?? data
  return { token: d.accessToken ?? d.token, user: d.user ?? data.user }
}

async function api(method, path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = null
  try { data = await res.json() } catch {}
  return { status: res.status, data }
}

async function main() {
  // 1. Login all actors
  const dev = await login('developer@tcms.com', 'Dev@12345')
  const qa1 = await login('qa1@tcms.com', 'QA@12345')
  const qa2 = await login('qa2@tcms.com', 'QA@12345')
  const lead = await login('teamlead@tcms.com', 'Lead@123')
  const admin = await login('admin@tcms.com', 'Admin@123')
  console.log('logged in: dev/qa1/qa2/lead/admin OK')

  // 2. Mirror user's config: toggle perform_review ON for EVERY role
  const matrix = await api('GET', '/api/permissions', admin.token)
  const toggles = matrix.data?.data ?? matrix.data ?? []
  for (const t of toggles.filter((t) => t.action === 'perform_review' && !t.enabled)) {
    const r = await api('PUT', '/api/permissions', admin.token, { role: t.role, action: 'perform_review', enabled: true })
    if (r.status !== 200) console.log(`  toggle ${t.role} failed:`, r.status)
  }
  const after = await api('GET', '/api/permissions', admin.token)
  const pr = (after.data?.data ?? after.data ?? []).filter((t) => t.action === 'perform_review')
  console.log('perform_review matrix now:', pr.map((t) => `${t.role}=${t.enabled}`).join(' '))

  // 3. Developer creates a test case and submits it FOR REVIEW to qa1 explicitly
  const mods = await api('GET', '/api/modules', dev.token)
  const modList = mods.data?.tree ?? []
  const moduleId = modList[0]?.moduleId
  const users = await api('GET', '/api/users', admin.token)
  const userList = users.data?.data ?? []
  const qa1Id = userList.find((u) => u.email === 'qa1@tcms.com')?.userId
  console.log('qa1 userId:', qa1Id, '| module:', moduleId)

  const created = await api('POST', '/api/test-cases', admin.token, {
    moduleId,
    title: 'PERM-TEST: only assigned reviewer can approve',
    description: 'Permission enforcement reproduction',
    steps: [{ stepNumber: 1, action: 'Do thing', expected: 'Thing happens' }],
    priority: 'P2',
    tags: ['perm-test'],
  })
  const tcId = (created.data?.data ?? created.data)?.testCaseId
  console.log('created test case:', tcId, 'HTTP', created.status)

  const submitted = await api('PUT', `/api/test-cases?id=${tcId}&action=submit-review`, admin.token, { reviewerId: qa1Id })
  const review = submitted.data?.data ?? submitted.data
  console.log('submit-review ->', submitted.status, 'reviewId:', review?.reviewRequestId, 'reviewer:', review?.reviewerId)

  // 4. THE KEY TEST: non-assigned users try to approve
  for (const [name, sess] of [['qa2 (other QA, has perform_review)', qa2], ['teamlead (has perform_review)', lead], ['admin (all permissions)', admin]]) {
    const r = await api('POST', `/api/reviews?id=${review.reviewRequestId}`, sess.token, { verdict: 'approved', comment: 'trying to approve', flaggedFields: [] })
    out(`  approve attempt by ${name}`, r, r.data?.error ?? r.data)
  }

  // 5. Assigned reviewer CAN approve (use needs_revision to keep it open, then check qa1 approve works)
  const verdictQa1 = await api('POST', `/api/reviews?id=${review.reviewRequestId}`, qa1.token, { verdict: 'needs_revision', comment: 'assigned reviewer verdict test', flaggedFields: [] })
  out('  verdict by ASSIGNED qa1', verdictQa1, verdictQa1.data?.error ?? { reviewStatus: verdictQa1.data?.data?.reviewStatus ?? verdictQa1.data?.reviewStatus })

  // 6. Re-check a non-assigned user after verdict (review still open / in_progress)
  const r2 = await api('POST', `/api/reviews?id=${review.reviewRequestId}`, qa2.token, { verdict: 'approved', comment: 'second attempt', flaggedFields: [] })
  out('  second approve attempt by qa2 (review in_progress)', r2, r2.data?.error ?? r2.data)

  // cleanup: mark case deprecated so repeat runs stay clean
  await api('DELETE', `/api/test-cases?id=${tcId}`, admin.token)
}

main().catch((e) => { console.error('SCRIPT FAIL:', e.message); process.exit(1) })
