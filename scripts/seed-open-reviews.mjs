// Restore the demo state that makes the permission matrix visible:
//  1. Remove the stale manager:manage_permissions override (leftover from an
//     earlier toggle demo) — manager must NOT hold manage_permissions.
//  2. Ensure open review work exists so Reviews queues are non-empty:
//     qa1 submits one draft test case AND the Authentication module for
//     review, reviewer = the manager — through the REAL API (notifications,
//     case reviews and counters stay consistent).
// Sandbox-only helper. Usage: node scripts/seed-open-reviews.mjs
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()
const BASE = 'http://localhost:3000'

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth?path=login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status}`)
  const data = await res.json()
  return data.accessToken
}

async function api(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: `tcms-access=${token}` },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }
  return { status: res.status, data }
}

async function main() {
  // ---- 1. pristine matrix ----
  const removed = await db.$executeRaw`
    DELETE FROM role_permissions WHERE role = 'manager' AND action = 'manage_permissions'`
  console.log(`stale manager:manage_permissions overrides removed: ${removed}`)

  // ---- 2. open demo reviews via the API ----
  const qaToken = await login('qa1@tcms.com', 'QA@12345')

  // Manager user id (Leo Lead).
  const options = await api(qaToken, 'GET', '/api/users?action=options')
  if (options.status !== 200) throw new Error(`options failed: ${options.status} ${JSON.stringify(options.data)}`)
  console.log(`users options -> ${options.data.length} rows (qa1 sees pickers now)`)
  const manager = options.data.find((u) => u.role === 'manager')
  if (!manager) throw new Error('no manager user found')
  console.log(`manager: ${manager.fullName} canPerformReview=${manager.canPerformReview}`)

  // Existing modules: submit the 'Authentication' root module for review.
  const tree = await api(qaToken, 'GET', '/api/modules')
  const auth = tree.data.flat.find((m) => m.name === 'Authentication')
  if (!auth) throw new Error('Authentication module not found')

  // Existing draft/needs_revision test case to submit individually.
  const tcList = await api(qaToken, 'GET', '/api/test-cases?pageSize=50')
  const eligible = tcList.data.data.find(
    (tc) => tc.status === 'draft' || tc.status === 'needs_revision'
  )

  if (!eligible) {
    console.log('no draft test case found -> qa1 creates one')
    const created = await api(qaToken, 'POST', '/api/test-cases', {
      title: 'Password reset email contains a valid single-use link',
      moduleId: auth.moduleId,
      priority: 'P1',
      description: 'Verify the password reset flow sends a single-use link that expires.',
      expectedResult: 'Reset link works exactly once and expires afterwards.',
      tags: ['auth', 'reset'],
      steps: [
        { stepNumber: 1, action: 'Request a password reset email', expected: 'Email arrives within 1 minute' },
        { stepNumber: 2, action: 'Open the reset link and set a new password', expected: 'Password is changed' },
        { stepNumber: 3, action: 'Reuse the same link', expected: 'Link is rejected as expired/used' },
      ],
    })
    if (created.status !== 200 && created.status !== 201) throw new Error(`create tc failed: ${created.status} ${JSON.stringify(created.data)}`)
    console.log(`created test case ${created.data.testCaseId}`)
  }

  // Submit one test case for review (reviewer = manager).
  const target = eligible ?? (await api(qaToken, 'GET', '/api/test-cases?pageSize=50')).data.data.find((tc) => tc.status === 'draft')
  const single = await api(qaToken, 'PUT', `/api/test-cases?id=${target.testCaseId}&action=submit-review`, {
    reviewerId: manager.userId,
  })
  console.log(`single submit-review -> ${single.status} ${single.status === 200 ? `review ${single.data.reviewRequestId}` : JSON.stringify(single.data)}`)

  // Submit the whole Authentication module for review (reviewer = manager).
  const moduleReview = await api(qaToken, 'PUT', `/api/modules?id=${auth.moduleId}&action=submit-review`, {
    reviewerId: manager.userId,
    includeSubmodules: true,
  })
  console.log(
    `module submit-review -> ${moduleReview.status} ${moduleReview.status === 200 ? `${moduleReview.data.caseReviewCount} case reviews` : JSON.stringify(moduleReview.data)}`
  )

  // ---- 3. manager-side proof ----
  const mgrToken = await login('teamlead@tcms.com', 'Lead@123')
  const queue = await api(mgrToken, 'GET', '/api/reviews?action=queue')
  const mQueue = await api(mgrToken, 'GET', '/api/module-reviews?action=queue')
  const all = await api(mgrToken, 'GET', '/api/module-reviews?action=all')
  console.log(`manager single-review queue: ${Array.isArray(queue.data) ? queue.data.length : queue.data} open`)
  console.log(`manager module-review queue: ${Array.isArray(mQueue.data) ? mQueue.data.length : mQueue.data} open`)
  console.log(`manager all module reviews:   ${Array.isArray(all.data) ? all.data.length : all.data}`)
  const me = await api(mgrToken, 'GET', '/api/auth')
  console.log(`manager permissions (${me.data.permissions.length}): ${me.data.permissions.join(',')}`)
  console.log(`manager has manage_permissions: ${me.data.permissions.includes('manage_permissions')}`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
