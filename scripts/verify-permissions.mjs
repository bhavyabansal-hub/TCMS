// Permission-behavior battery — proves the bidirectional rule:
//   granted  -> the user CAN see and use the feature
//   withheld -> the user CANNOT see it (UI) nor call it (API 403)
// Covers every fix from the permission-correctness pass.
// Sandbox-only. Usage: node scripts/verify-permissions.mjs
import { randomUUID } from 'node:crypto'
import { cleanupRunEntities } from './lib/suite-cleanup.mjs'

const BASE = 'http://localhost:3000'
let pass = 0
let fail = 0

function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; console.log(`FAIL  ${name} ${extra}`) }
}

const CSRF = { 'X-Requested-With': 'tcms' } // first-party marker (API CSRF contract)

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth?path=login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...CSRF },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status}`)
  // Cookie-session contract: access token arrives as httpOnly cookie, not body.
  const raw = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('tcms-access=')) ?? ''
  const token = raw.split(';')[0].replace(/^tcms-access=/, '')
  if (!token) throw new Error(`login for ${email} set no tcms-access cookie`)
  return token
}

async function api(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...CSRF, Cookie: token ? `tcms-access=${token}` : '' },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = null
  try { data = await res.json() } catch { /* no body */ }
  return { status: res.status, data }
}

// B16: every row this run creates is recorded here and removed at the end.
const created = { cases: [], bugs: [], moduleReviews: [] }

async function main() {
  const vp = await login('admin@tcms.com', 'Admin@123')
  const manager = await login('teamlead@tcms.com', 'Lead@123')
  const product = await login('product@tcms.com', 'Product@123')
  const developer = await login('developer@tcms.com', 'Dev@12345')
  const qa = await login('qa1@tcms.com', 'QA@12345')
  const viewer = await login('viewer@tcms.com', 'View@12345')

  // ---- 0. FIXTURE: a fresh seed ships NO review requests, so raise them here.
  // One module review auto-creates a per-case review as well; the auto-picked
  // reviewer is the manager (manager-first routing, submitter excluded).
  const mods = await api(qa, 'GET', '/api/modules')
  const target = mods.data.flat.find((m) => m.parentId) ?? mods.data.flat[0]
  const tcCreate = await api(qa, 'POST', '/api/test-cases', {
    title: `Perm-verify case ${Date.now()}`,
    moduleId: target?.moduleId,
    description: 'Fixture for the permissions suite',
    priority: 'P2',
    steps: [{ stepNumber: 1, action: 'Run', expected: 'Pass' }],
  })
  check('fixture: qa created a draft case', !!tcCreate.data?.testCaseId, JSON.stringify(tcCreate.data).slice(0, 100))
  if (tcCreate.data?.testCaseId) created.cases.push(tcCreate.data.testCaseId)
  const modSubmit = await api(qa, 'PUT', `/api/modules?id=${target?.moduleId}&action=submit-review`, { includeSubmodules: false })
  check('fixture: module review raised (manager auto-picked)', modSubmit.status === 200, JSON.stringify(modSubmit.data).slice(0, 140))
  const raisedId = modSubmit.data?.moduleReview?.moduleReviewRequestId
  if (raisedId) created.moduleReviews.push(raisedId)

  // ---- 1. GRANTED -> Manager SEES the raised reviews ----
  const mQueue = await api(manager, 'GET', '/api/reviews?action=queue')
  check('manager review queue reachable (perform+submit granted)', mQueue.status === 200)
  check('manager review queue NON-EMPTY (reviews raised are visible)', Array.isArray(mQueue.data) && mQueue.data.length > 0, `got ${JSON.stringify(mQueue.data).slice(0, 80)}`)
  const mModQueue = await api(manager, 'GET', '/api/module-reviews?action=queue')
  check('manager module-review queue NON-EMPTY', Array.isArray(mModQueue.data) && mModQueue.data.length > 0)
  const mAll = await api(manager, 'GET', '/api/module-reviews?action=all')
  check('manager all module reviews NON-EMPTY', Array.isArray(mAll.data) && mAll.data.length > 0)
  const mPerms = await api(manager, 'GET', '/api/auth')
  check('manager holds perform_review + submit_review', mPerms.data.permissions.includes('perform_review') && mPerms.data.permissions.includes('submit_review'))

  // ---- 2. WITHHELD -> Manager must NOT touch the permissions panel ----
  const mPermPanel = await api(manager, 'GET', '/api/permissions')
  check('manager GET /permissions -> 403 (manage_permissions not granted)', mPermPanel.status === 403, `got ${mPermPanel.status}`)
  check('manager session has NO manage_permissions', !mPerms.data.permissions.includes('manage_permissions'))

  // ---- 3. Review worklist: participants only ----
  const vReviews = await api(viewer, 'GET', '/api/reviews?pageSize=10')
  check('viewer GET /reviews (cross-user list) -> 403', vReviews.status === 403, `got ${vReviews.status}`)
  const vQueue = await api(viewer, 'GET', '/api/reviews?action=queue')
  check('viewer own queue -> 200 empty (self-scoped reads stay open)', vQueue.status === 200 && Array.isArray(vQueue.data) && vQueue.data.length === 0)
  const dPerms = await api(developer, 'GET', '/api/auth')
  const qPerms = await api(qa, 'GET', '/api/auth')
  const dReviews = await api(developer, 'GET', '/api/reviews?pageSize=10')
  const devSeesReviews = dPerms.data.permissions.includes('perform_review')
  check(`developer GET /reviews -> ${devSeesReviews ? 200 : 403} (matches effective matrix)`, dReviews.status === (devSeesReviews ? 200 : 403), `got ${dReviews.status}`)
  const qAll = await api(qa, 'GET', '/api/reviews?pageSize=10')
  // Visibility now follows the EFFECTIVE matrix (perform_review), which the
  // deployment may legitimately extend via runtime overrides (e.g. the QA
  // marathon grants qa_engineer perform_review). Derive, don't hardcode.
  const qaSeesReviews = qPerms.data.permissions.includes('perform_review')
  check(`qa GET /reviews -> ${qaSeesReviews ? 200 : 403} (matches effective matrix)`, qAll.status === (qaSeesReviews ? 200 : 403), `got ${qAll.status}`)

  // ---- 4. Module review detail: participants only ----
  const modId = mAll.data?.[0]?.moduleReviewRequestId
  const vMod = modId ? await api(viewer, 'GET', `/api/module-reviews?id=${modId}`) : { status: 'skipped' }
  check('viewer GET module-review detail -> 403', vMod.status === 403, `got ${vMod.status}`)
  const mMod = modId ? await api(manager, 'GET', `/api/module-reviews?id=${modId}`) : { status: 'skipped' }
  check('manager GET module-review detail -> 200', mMod.status === 200, `got ${mMod.status}`)

  // ---- 5. Bug triage: viewer read-only; developer (create_bug) can triage ----
  // Runs on a bug this suite creates (B16: never touch seed bugs).
  const bugs = await api(developer, 'GET', '/api/bugs?pageSize=5')
  check('developer can list bugs', bugs.status === 200)
  const tempBug = await api(developer, 'POST', '/api/bugs', {
    title: `Permission battery temp bug ${Date.now()}`,
    description: 'Fixture for the permissions suite',
    severity: 'low',
    moduleId: target?.moduleId,
  })
  const bugId = tempBug.data?.bugId
  if (bugId) created.bugs.push(bugId)
  check('developer created a bug (create_bug granted)', !!bugId, `got ${tempBug.status} ${JSON.stringify(tempBug.data).slice(0, 120)}`)
  const vBug = await api(viewer, 'PUT', `/api/bugs?id=${bugId}`, { status: 'in_progress' })
  check('viewer PUT bug status -> 403 (no bug rights)', vBug.status === 403, `got ${vBug.status}`)
  const dBug = await api(developer, 'PUT', `/api/bugs?id=${bugId}`, { status: 'in_progress' })
  check('developer PUT bug status -> 200 (create_bug participant)', dBug.status === 200, `got ${dBug.status} ${JSON.stringify(dBug.data).slice(0, 80)}`)
  // T1-2: re-sending the current assignee is a no-op, so the check must
  // request a real change (unassigned -> a real user) to hit assign_bug.
  const devOpts = await api(developer, 'GET', '/api/users?action=options')
  const assigneeId = (devOpts.data ?? []).find((u) => u.userId)?.userId
  const dBugAssign = await api(developer, 'PUT', `/api/bugs?id=${bugId}`, { assignedToId: assigneeId })
  check('developer reassign bug -> 403 (assign_bug withheld)', !!assigneeId && dBugAssign.status === 403, `got ${dBugAssign.status}`)
  const dBugSame = await api(developer, 'PUT', `/api/bugs?id=${bugId}`, { assignedToId: null })
  check('developer re-sends current assignee -> 200 (no-op, T1-2)', dBugSame.status === 200, `got ${dBugSame.status}`)
  const mBugAssign = await api(manager, 'PUT', `/api/bugs?id=${bugId}`, { assignedToId: null })
  check('manager reassign bug -> 200 (assign_bug granted)', mBugAssign.status === 200, `got ${mBugAssign.status}`)

  // ---- 6. Picker endpoint: open to all, matrix-driven flags ----
  const qOpts = await api(qa, 'GET', '/api/users?action=options')
  check('qa GET /users?action=options -> 200 (pickers work without manage_users)', qOpts.status === 200, `got ${qOpts.status}`)
  const reviewers = (qOpts.data ?? []).filter((u) => u.canPerformReview).map((u) => u.role)
  // Flags must mirror the EFFECTIVE matrix (defaults + runtime overrides),
  // not a frozen default list — the deployment grants roles at runtime.
  const vpMatrix = await api(vp, 'GET', '/api/permissions')
  const expectedReviewerRoles = new Set(
    (vpMatrix.data ?? []).filter((t) => t.action === 'perform_review' && t.enabled).map((t) => t.role)
  )
  const unexpectedRoles = reviewers.filter((r) => !expectedReviewerRoles.has(r))
  check('options reviewer flags mirror the effective matrix',
    qOpts.status === 200 && expectedReviewerRoles.size > 0 && unexpectedRoles.length === 0,
    `flags=${[...new Set(reviewers)].join(',')} expected=[${[...expectedReviewerRoles].join(',')}]`)
  const qUsers = await api(qa, 'GET', '/api/users')
  check('qa GET /users (admin list) -> 403 still', qUsers.status === 403, `got ${qUsers.status}`)
  const vOpts = await api(viewer, 'GET', '/api/users?action=options')
  check('viewer GET options -> 200 (harmless name list, no emails)', vOpts.status === 200 && vOpts.data.every((u) => !('email' in u)))

  // ---- 7. LIVE matrix: grant perform_review to developer -> flags flip ----
  const grant = await api(vp, 'PUT', '/api/permissions', { role: 'developer', action: 'perform_review', enabled: true })
  check('vp grants developer:perform_review', grant.status === 200)
  // Documented convergence: other route instances refresh within the 3s TTL
  // (the toggling instance is already fresh; every requireUser() re-checks).
  await new Promise((r) => setTimeout(r, 3500))
  const dOpts = await api(developer, 'GET', '/api/users?action=options')
  const dFlag = (dOpts.data ?? []).find((u) => u.role === 'developer')?.canPerformReview
  check('developer options flag flips to true immediately', dFlag === true, `got ${dFlag}`)
  const dPerm = await api(developer, 'GET', '/api/auth')
  check('developer session now includes perform_review', dPerm.data.permissions.includes('perform_review'))
  const dReviews2 = await api(developer, 'GET', '/api/reviews?pageSize=10')
  check('developer GET /reviews -> 200 AFTER grant (granted = usable)', dReviews2.status === 200, `got ${dReviews2.status}`)
  const revert = await api(vp, 'PUT', '/api/permissions', { role: 'developer', action: 'perform_review', enabled: false })
  check('vp reverts developer:perform_review', revert.status === 200)
  await new Promise((r) => setTimeout(r, 3500))
  const dReviews3 = await api(developer, 'GET', '/api/reviews?pageSize=10')
  check('developer GET /reviews -> 403 again after revert', dReviews3.status === 403, `got ${dReviews3.status}`)

  // ---- 7b. R11 (REQ-001): PUT /task-reports?id= requires create_task_report,
  //      checked before the lookup. Random UUID + valid body {} -> writes nothing.
  const vPut = await api(viewer, 'PUT', `/api/task-reports?id=${randomUUID()}`, {})
  check('viewer PUT /task-reports?id=<random uuid> body {} -> 403 Insufficient role',
    vPut.status === 403 && vPut.data?.error === 'Insufficient role', `got ${vPut.status} ${JSON.stringify(vPut.data)}`)
  const qPut = await api(qa, 'PUT', `/api/task-reports?id=${randomUUID()}`, {})
  check('qa PUT /task-reports?id=<random uuid> body {} -> 404 Report not found (holder passes the gate)',
    qPut.status === 404, `got ${qPut.status} ${JSON.stringify(qPut.data)}`)

  // ---- 8. override hygiene: every remaining row must be a KNOWN grant ----
  // The deployment intentionally seeds {developer, qa_engineer}:perform_review
  // (QA marathon). Anything outside that set means a probe leaked state.
  const vPerm = await api(vp, 'GET', '/api/permissions')
  const nonDefault = (vPerm.data ?? []).filter((t) => t.source === 'override')
  const KNOWN_GRANTS = new Set(['developer:perform_review', 'qa_engineer:perform_review'])
  const unknownRows = nonDefault.filter((t) => !KNOWN_GRANTS.has(`${t.role}:${t.action}`))
  check('only known seed overrides remain (or pristine defaults)', unknownRows.length === 0, `got ${JSON.stringify(nonDefault)}`)

  await cleanupRunEntities(check, created)

  console.log('======================================')
  console.log(`PERMISSION-BEHAVIOR RESULT: ${pass} passed, ${fail} failed`)
  console.log('======================================')
  if (fail > 0) process.exit(1)
}

main().catch(async (e) => {
  console.error(e)
  await cleanupRunEntities(check, created)
  process.exit(1)
})
