/**
 * PERMISSION MATRIX SUITE (QA marathon 2026-10-09).
 * For every role (vp, manager, product, developer, qa_engineer, viewer) a
 * real user of that role signs in and probes EVERY action class. Expected
 * results come from DEFAULT_PERMISSIONS + the two overrides granted during
 * seeding (developer/qa_engineer perform_review).
 *
 * Also verifies the VP-togglable matrix round-trip: grant -> behavior flips
 * immediately -> revoke -> flips back, with NO leftover override rows.
 *
 * Exit code 0 = all expectations hold.
 */
const BASE = 'http://localhost:3000'
const PASSWORD = 'QaMarathon@2026'
let failures = 0
let passes = 0
function check(name, cond, detail = '') {
  if (cond) { passes++; console.log(`  ok  ${name}`) }
  else { failures++; console.error(`FAIL  ${name} ${detail}`) }
}

async function req(method, path, { body, jar } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms' }
  if (jar) headers.Cookie = jar
  if (method !== 'GET') headers.Origin = BASE
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  return { status: res.status, json: await res.json().catch(() => ({})), setCookie: res.headers.getSetCookie?.() ?? [] }
}
const jarOf = (res) => res.setCookie.map((c) => c.split(';')[0]).join('; ')

async function loginAs(email) {
  const res = await req('POST', '/api/auth?path=login', { body: { email, password: PASSWORD } })
  if (res.status !== 200) throw new Error(`login ${email} -> ${res.status}`)
  return { jar: jarOf(res), user: res.json.user, permissions: res.json.permissions }
}

// ---------- sessions for every role ----------
// viewer comes from SELF-SIGNUP (proves the default-viewer policy again)
const stamp = Date.now().toString().slice(-6)
const viewerReg = await req('POST', '/api/auth?path=register', { body: { fullName: `QA Marathon Viewer ${stamp}`, email: `qamarathon.viewer.${stamp}@tcms.dev`, password: PASSWORD } })
check('viewer self-signup ok + role=viewer', viewerReg.status === 200 && viewerReg.json?.user?.role === 'viewer', `${viewerReg.status}`)
check('viewer session permissions = []', Array.isArray(viewerReg.json?.permissions) && viewerReg.json.permissions.length === 0, JSON.stringify(viewerReg.json?.permissions))

const sessions = {
  vp: await loginAs('qamarathon.vp@tcms.dev'),
  manager: await loginAs('qamarathon.manager@tcms.dev'),
  product: await loginAs('qamarathon.product@tcms.dev'),
  developer: await loginAs('qamarathon.developer@tcms.dev'),
  qa_engineer: await loginAs('qamarathon.qa_engineer@tcms.dev'),
  viewer: { jar: jarOf(viewerReg), user: viewerReg.json.user, permissions: viewerReg.json.permissions },
}
for (const [role, s] of Object.entries(sessions)) {
  console.log(`session ${role}: ${s.user.email} perms=${s.permissions.length}`)
}

// ---------- admin setup session + fixtures ----------
const adminRes = await req('POST', '/api/auth?path=login', { body: { email: 'admin@tcms.com', password: 'Admin@123' } })
const adminJar = jarOf(adminRes)
const adminUser = adminRes.json.user

// DEFENSIVE CLEANUP: prior runs of this suite left a viewer/create_bug
// override behind (the toggle probe used to not restore). Reset both cells
// used by the round-trip below to their defaults so this run starts clean.
for (const cell of [{ role: 'viewer', action: 'create_bug', def: false }, { role: 'viewer', action: 'create_test_case', def: false }]) {
  await req('PUT', '/api/permissions', { jar: adminJar, body: { role: cell.role, action: cell.action, enabled: cell.def } })
}

const modules = await req('GET', '/api/modules', { jar: adminJar })
const alpha = (modules.json?.flat ?? []).find((m) => m.name === 'QA Marathon Alpha')
const moduleId = alpha.moduleId

async function adminCreateCase(title) {
  const res = await req('POST', '/api/test-cases', { jar: adminJar, body: { title, moduleId, description: `Matrix fixture ${title}`, priority: 'P2' } })
  return (res.json?.testCase ?? res.json)
}
async function adminCreateWiki(title) {
  const res = await req('POST', '/api/wiki', { jar: adminJar, body: { title, content: '<p>matrix fixture</p>', tags: [] } })
  return (res.json?.documentId ?? res.json?.wikiDocumentId ?? res.json?.id)
}
async function adminCreateBug(title) {
  const res = await req('POST', '/api/bugs', { jar: adminJar, body: { title, moduleId, description: `Matrix fixture ${title}`, severity: 'low' } })
  return (res.json?.bug?.bugId ?? res.json?.bugId ?? res.json?.id)
}

const fixtures = {
  adminCase: await adminCreateCase(`Matrix fixture admin case ${stamp}`),
  adminCase2: await adminCreateCase(`Matrix fixture admin case 2 ${stamp}`),
  adminWiki: await adminCreateWiki(`Matrix fixture wiki ${stamp}`),
  adminBug: await adminCreateBug(`Matrix fixture bug ${stamp}`),
}
check('fixtures created', !!fixtures.adminCase?.testCaseId && !!fixtures.adminWiki && !!fixtures.adminBug, JSON.stringify(Object.keys(fixtures)))

// ---------- the matrix ----------
// expected: map role -> boolean (allowed)
const M = (vp, manager, product, developer, qa, viewer) => ({ vp, manager, product, developer, qa_engineer: qa, viewer })

const MATRIX = []
MATRIX.push({
  name: 'list test cases (open read)',
  run: (s) => req('GET', '/api/test-cases?pageSize=1', { jar: s.jar }),
  expect: M(true, true, true, true, true, true),
})
MATRIX.push({
  name: 'create test case (create_test_case)',
  run: (s) => req('POST', '/api/test-cases', { jar: s.jar, body: { title: `matrix probe ${s.user.role}`, moduleId, description: 'probe' } }),
  expect: M(true, true, true, false, true, false),
})
MATRIX.push({
  name: 'edit ANY admin-authored case (edit_any_test_case)',
  run: (s) => req('PUT', `/api/test-cases?id=${fixtures.adminCase.testCaseId}`, { jar: s.jar, body: { title: `edited by ${s.user.role}` } }),
  expect: M(true, true, false, false, false, false),
})
MATRIX.push({
  name: 'submit review (submit_review)',
  run: (s) => req('PUT', `/api/test-cases?id=${fixtures.adminCase2.testCaseId}&action=submit-review`, { jar: s.jar, body: {} }),
  expect: M(true, true, true, false, true, false),
})
MATRIX.push({
  name: 'delete admin-authored case (author-or-delete_test_case)',
  // Destructive probes get a FRESH fixture per role: an earlier role's
  // successful delete must not turn later roles' probes into misleading 404s.
  run: async (s) => {
    const tc = await adminCreateCase(`delete probe ${s.user.role} ${stamp}`)
    return req('DELETE', `/api/test-cases?id=${tc.testCaseId}`, { jar: s.jar })
  },
  expect: M(true, true, false, false, false, false),
})
MATRIX.push({
  name: 'bulk delete admin-authored case (delete_test_case)',
  run: async (s) => {
    const tc = await adminCreateCase(`bulk-delete probe ${s.user.role} ${stamp}`)
    return req('DELETE', '/api/test-cases?action=bulk-delete', { jar: s.jar, body: { ids: [tc.testCaseId] } })
  },
  expect: M(true, true, false, false, false, false),
})
MATRIX.push({
  name: 'create module (create_module)',
  run: (s) => req('POST', '/api/modules', { jar: s.jar, body: { name: `matrix module ${s.user.role} ${stamp}` } }),
  expect: M(true, true, true, false, false, false),
})
MATRIX.push({
  name: 'edit module (edit_module)',
  run: (s) => req('PUT', `/api/modules?id=${moduleId}`, { jar: s.jar, body: { description: `touched by ${s.user.role}` } }),
  expect: M(true, true, true, false, false, false),
})
MATRIX.push({
  name: 'create bug (create_bug)',
  run: (s) => req('POST', '/api/bugs', { jar: s.jar, body: { title: `matrix bug ${s.user.role}`, moduleId, description: 'probe' } }),
  expect: M(true, true, true, true, true, false),
})
MATRIX.push({
  name: 'link test case to bug (create/assign_bug)',
  run: (s) => req('PUT', `/api/bugs?id=${fixtures.adminBug}&action=link-tc`, { jar: s.jar, body: { testCaseId: fixtures.adminCase.testCaseId } }),
  expect: M(true, true, true, true, true, false),
})
MATRIX.push({
  name: 'delete bug (delete_bug)',
  run: async (s) => {
    const bid = await adminCreateBug(`bug delete probe ${s.user.role} ${stamp}`)
    return req('DELETE', `/api/bugs?id=${bid}`, { jar: s.jar })
  },
  expect: M(true, true, false, false, false, false),
})
MATRIX.push({
  name: 'create task report (create_task_report)',
  run: (s) => req('POST', '/api/task-reports', { jar: s.jar, body: { reportDate: new Date().toISOString().slice(0, 10), tasks: [{ description: `matrix probe ${s.user.role}`, timeSpentMinutes: 30, status: 'done' }] } }),
  expect: M(true, true, true, true, true, false),
})
MATRIX.push({
  name: 'task report summary (view_all_task_reports)',
  run: (s) => req('GET', '/api/task-reports?action=summary', { jar: s.jar }),
  // product HAS view_all_task_reports by default (DEFAULT_PERMISSIONS).
  expect: M(true, true, true, false, false, false),
})
MATRIX.push({
  name: 'list users (manage_users)',
  run: (s) => req('GET', '/api/users?pageSize=1', { jar: s.jar }),
  expect: M(true, true, false, false, false, false),
})
MATRIX.push({
  name: 'change other user role (manage_users; 404 on missing target)',
  // Points at a NON-EXISTENT user id: permission holders pass the gate and
  // hit 404; everyone else is stopped at 403. No real role ever changes.
  run: (s) => req('PUT', '/api/users?id=00000000-0000-0000-0000-0000000000aa', { jar: s.jar, body: { role: 'vp' } }),
  expect: M(true, true, false, false, false, false),
  // 404 = allowed-through; treat any non-403 4xx/2xx accordingly
  allow404: true,
})
MATRIX.push({
  name: 'read permission matrix (manage_permissions)',
  run: (s) => req('GET', '/api/permissions', { jar: s.jar }),
  expect: M(true, false, false, false, false, false),
})
MATRIX.push({
  name: 'toggle permission (manage_permissions)',
  // Probe flips viewer/create_bug ON; when the flip succeeds it is
  // immediately restored (enabled:false = default-restore deletes the row),
  // so the probe leaves NO leftover override behind.
  run: async (s) => {
    const probeRes = await req('PUT', '/api/permissions', { jar: s.jar, body: { role: 'viewer', action: 'create_bug', enabled: true } })
    if (probeRes.status >= 200 && probeRes.status < 300) {
      await req('PUT', '/api/permissions', { jar: s.jar, body: { role: 'viewer', action: 'create_bug', enabled: false } })
    }
    return probeRes
  },
  expect: M(true, false, false, false, false, false),
})
MATRIX.push({
  name: 'activity feed (view_activity_logs)',
  run: (s) => req('GET', '/api/activity-logs?pageSize=1', { jar: s.jar }),
  // product HAS view_activity_logs by default (DEFAULT_PERMISSIONS).
  expect: M(true, true, true, false, false, false),
})
MATRIX.push({
  name: 'create wiki doc (create_wiki_doc)',
  run: (s) => req('POST', '/api/wiki', { jar: s.jar, body: { title: `matrix wiki ${s.user.role}`, content: '<p>probe</p>' } }),
  expect: M(true, true, true, false, true, false),
})
MATRIX.push({
  name: 'edit admin wiki doc (edit_any_wiki_doc)',
  run: (s) => req('PUT', `/api/wiki?id=${fixtures.adminWiki}`, { jar: s.jar, body: { title: `wiki edited by ${s.user.role}` } }),
  expect: M(true, true, false, false, false, false),
})
MATRIX.push({
  name: 'delete admin wiki doc (author-or-delete_wiki_doc)',
  run: async (s) => {
    const wid = await adminCreateWiki(`wiki delete probe ${s.user.role} ${stamp}`)
    return req('DELETE', `/api/wiki?id=${wid}`, { jar: s.jar })
  },
  expect: M(true, true, false, false, false, false),
})
MATRIX.push({
  name: 'reports stats (view_all_task_reports)',
  run: (s) => req('GET', '/api/stats?action=reports', { jar: s.jar }),
  // product HAS view_all_task_reports by default (DEFAULT_PERMISSIONS).
  expect: M(true, true, true, false, false, false),
})
MATRIX.push({
  name: 'own notifications (self-scoped)',
  run: (s) => req('GET', '/api/notifications?pageSize=1', { jar: s.jar }),
  expect: M(true, true, true, true, true, true),
})
MATRIX.push({
  name: 'global search (open read)',
  run: (s) => req('GET', '/api/search?q=matrix', { jar: s.jar }),
  expect: M(true, true, true, true, true, true),
})
MATRIX.push({
  name: 'dashboard stats (open read)',
  run: (s) => req('GET', '/api/stats?action=dashboard', { jar: s.jar }),
  expect: M(true, true, true, true, true, true),
})

console.log('\n=== MATRIX PROBES ===')
for (const probe of MATRIX) {
  for (const role of Object.keys(sessions)) {
    const s = sessions[role]
    const res = await probe.run(s)
    const expected = probe.expect[role]
    const allowed = res.status >= 200 && res.status < 300
    const ok = probe.allow404
      ? (expected ? (allowed || res.status === 404) : res.status === 403)
      : (expected ? allowed : res.status === 403)
    check(`${probe.name} — ${role} -> ${res.status}`, ok, `expected ${expected ? (probe.allow404 ? 'allow/404' : 'allow') : '403'}`)
  }
}

// ---------- verdict permission (override-driven): assigned reviewer ----------
console.log('\n=== VERDICT / OVERRIDE ROUND-TRIP ===')
// grant needed because reviewer must differ from author (admin)
const dev = sessions.developer
const caseForVerdict = await adminCreateCase(`Verdict override fixture ${stamp}`)
const devOpt = (await req('GET', '/api/users?action=options', { jar: adminJar })).json.find((u) => u.fullName === 'QA Marathon developer')
const submit = await req('PUT', `/api/test-cases?id=${caseForVerdict.testCaseId}&action=submit-review`, { jar: adminJar, body: { reviewerId: devOpt.userId } })
const reviewId = submit.json?.reviewRequestId ?? submit.json?.reviewRequest?.reviewRequestId
check('review submitted to developer', !!reviewId, JSON.stringify(submit.json).slice(0, 120))

// TEMP-REVOKE developer perform_review -> verdict must 403
const revoke = await req('PUT', '/api/permissions', { jar: adminJar, body: { role: 'developer', action: 'perform_review', enabled: false } })
check('VP revoke developer/perform_review -> 200', revoke.status === 200, String(revoke.status))
const denied = await req('POST', `/api/reviews?id=${reviewId}`, { jar: dev.jar, body: { verdict: 'approved', comment: 'should be denied now' } })
check('developer verdict while revoked -> 403', denied.status === 403, String(denied.status))
// re-grant (seed state) -> verdict must 200
const grant = await req('PUT', '/api/permissions', { jar: adminJar, body: { role: 'developer', action: 'perform_review', enabled: true } })
check('VP re-grant developer/perform_review -> 200', grant.status === 200, String(grant.status))
// session permission snapshot refreshes on /api/auth GET
const refreshed = await req('GET', '/api/auth', { jar: dev.jar })
check('developer session now carries perform_review', refreshed.json?.permissions?.includes('perform_review') === true, JSON.stringify(refreshed.json?.permissions))
const allowed = await req('POST', `/api/reviews?id=${reviewId}`, { jar: dev.jar, body: { verdict: 'approved', comment: 'granted again — override round-trip works' } })
check('developer verdict after re-grant -> 200', allowed.status === 200, String(allowed.status))

// grant->use->revoke on viewer (create_test_case)
const grantV = await req('PUT', '/api/permissions', { jar: adminJar, body: { role: 'viewer', action: 'create_test_case', enabled: true } })
check('VP grant viewer/create_test_case -> 200', grantV.status === 200, String(grantV.status))
const viewerCreate = await req('POST', '/api/test-cases', { jar: sessions.viewer.jar, body: { title: `viewer can now create ${stamp}`, moduleId, description: 'override round-trip' } })
check('viewer create while granted -> 200', viewerCreate.status === 200 || viewerCreate.status === 201, String(viewerCreate.status))
const revokeV = await req('PUT', '/api/permissions', { jar: adminJar, body: { role: 'viewer', action: 'create_test_case', enabled: false } })
check('VP revoke viewer/create_test_case (default-restore) -> 200', revokeV.status === 200, String(revokeV.status))
const viewerCreate2 = await req('POST', '/api/test-cases', { jar: sessions.viewer.jar, body: { title: `viewer denied again ${stamp}`, moduleId, description: 'override round-trip' } })
check('viewer create after revoke -> 403', viewerCreate2.status === 403, String(viewerCreate2.status))

// ---------- no leftover override rows for the round-trip cells ----------
console.log('\n=== DB/STATE HYGIENE ===')
const matrixAfter = await req('GET', '/api/permissions', { jar: adminJar })
const toggles = matrixAfter.json?.toggles ?? matrixAfter.json ?? []
const stale1 = toggles.find?.((t) => t.role === 'viewer' && t.action === 'create_test_case')
const stale2 = toggles.find?.((t) => t.role === 'developer' && t.action === 'perform_review')
check('viewer/create_test_case back to default source', stale1?.source === 'default', JSON.stringify(stale1))
check('developer/perform_review override remains (seed grant, enabled)', stale2?.enabled === true, JSON.stringify(stale2))

console.log(`\nRESULT: ${passes} passed, ${failures} failed`)
process.exit(failures ? 1 : 0)
