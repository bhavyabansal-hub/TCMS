/**
 * PERMISSION MATRIX SUITE (QA marathon 2026-10-09, ported to the default matrix in REQ-001 R7).
 * For every role (vp, manager, product, developer, qa_engineer, viewer) a stamped
 * fixture user of that role signs in and probes EVERY action class. Expected
 * results come from DEFAULT_PERMISSIONS (src/lib/permissions.ts) — no seeded overrides.
 *
 * Also verifies the VP-togglable matrix round-trip: grant -> behavior flips ->
 * revoke -> flips back, with NO leftover override rows.
 *
 * REQ-001 R7 safety:
 *   - DB guard + GET_LOCK first; precondition: role_permissions has 0 rows
 *     (all 126 cells default), else PRECONDITION + exit 2 (replaces the old reset).
 *   - Fixture users + module by raw SQL / fixture VP; no demo account logs in.
 *   - Every review submission names an explicit fixture reviewer.
 *   - Cleanup in finally and on Ctrl+C, keyed on fixture ids and SQL-collected ids;
 *     touched matrix cells restored (S2 rule) and compared with the pre-run snapshot.
 *   - Test-only hooks: VERIFY_FAIL_AT / VERIFY_PAUSE_AT = after-fixtures | after-grant |
 *     mid-cleanup-content. Recovery: --cleanup-stamp=<stamp>.
 * Usage: node scripts/verify-permission-matrix.mjs [--cleanup-stamp=<n>]
 * Exit: 0 green, 1 any FAIL, 2 NOT RUN (guard, lock, precondition, bad hook), 130 Ctrl+C.
 */
import { randomBytes } from 'node:crypto'
import { GuardAbort, openGuardedDb } from './lib/db-guard.mjs'
import { createFixtureUsers, findUsersByEmails, fixtureEmail } from './lib/fixture-users.mjs'
import {
  ForcedFailure,
  PERMISSION_CACHE_WAIT_MS,
  checkResidue,
  createCounter,
  createRunState,
  diffMatrix,
  loginFixture,
  manifestPath,
  parseFlags,
  readHooks,
  readMatrixSnapshot,
  requestJson,
  resolveExitCode,
  runCleanupStep,
  sleep,
  writeManifest,
} from './lib/suite-harness.mjs'
import {
  collectEntities,
  countModuleDependents,
  countResidue,
  deleteActivityLogsByUsers,
  deleteBugsByIds,
  deleteLoginAttemptsByEmails,
  deleteModulesByIds,
  deleteNotificationsByEntity,
  deleteReviewsByParticipants,
  deleteTestCaseById,
  deleteUsersByIds,
  deleteWikiDocById,
  emptyEntities,
  restoreTouchedCells,
} from './lib/suite-data.mjs'

const SUITE = 'matrix'
const PREFIX = 'permmatrix'
const HOOK_STEPS = ['after-fixtures', 'after-grant', 'mid-cleanup-content']
const TOUCHED_CELLS = [
  { role: 'viewer', action: 'create_bug' },
  { role: 'viewer', action: 'create_test_case' },
  { role: 'developer', action: 'perform_review' },
]
const TOUCHED_KEYS = TOUCHED_CELLS.map((c) => `${c.role}:${c.action}`)
const RESIDUE_TABLES = [
  'users', 'modules', 'test_cases', 'test_case_history', 'review_requests', 'review_events',
  'module_review_requests', 'bugs', 'bug_test_case_links', 'wiki_documents', 'task_reports',
  'role_permissions', 'activity_logs', 'refresh_tokens', 'notifications',
]
const FIXTURE_SPECS = [
  { key: 'vp', role: 'vp' },
  { key: 'mgr', role: 'manager' },
  { key: 'prod', role: 'product' },
  { key: 'dev', role: 'developer' },
  { key: 'qa', role: 'qa_engineer' },
  { key: 'viewer', role: 'viewer' },
]

const fixtureSpecs = (stamp) =>
  FIXTURE_SPECS.map((s) => ({ ...s, name: `Permmatrix ${s.role}`, email: fixtureEmail(PREFIX, s.key, stamp) }))
const signupEmail = (stamp) => fixtureEmail(PREFIX, 'signup', stamp)
const allEmails = (stamp) => [...fixtureSpecs(stamp).map((s) => s.email), signupEmail(stamp)]

// expected: map role -> boolean (allowed)
const M = (vp, manager, product, developer, qa, viewer) => ({ vp, manager, product, developer, qa_engineer: qa, viewer })

/** The 25 probes; expectations = DEFAULT_PERMISSIONS (R7.AC2). */
function buildMatrix(ctx, req, fx) {
  const { stamp } = ctx
  const MATRIX = []
  MATRIX.push({
    name: 'list test cases (open read)',
    run: (s) => req('GET', '/api/test-cases?pageSize=1', { jar: s.jar }),
    expect: M(true, true, true, true, true, true),
  })
  MATRIX.push({
    name: 'create test case (create_test_case)',
    run: (s) => req('POST', '/api/test-cases', { jar: s.jar, body: { title: `matrix probe ${s.user.role} ${stamp}`, moduleId: fx.moduleId, description: 'probe' } }),
    expect: M(true, true, true, false, true, false),
  })
  MATRIX.push({
    name: 'edit ANY admin-authored case (edit_any_test_case)',
    run: (s) => req('PUT', `/api/test-cases?id=${fx.adminCase.testCaseId}`, { jar: s.jar, body: { title: `edited by ${s.user.role} ${stamp}` } }),
    expect: M(true, true, false, false, false, false),
  })
  MATRIX.push({
    name: 'submit review (submit_review)',
    // Explicit fixture reviewer (R7.AC11): no demo VP/manager is auto-picked or notified.
    run: (s) => req('PUT', `/api/test-cases?id=${fx.adminCase2.testCaseId}&action=submit-review`, { jar: s.jar, body: { reviewerId: fx.reviewerId } }),
    expect: M(true, true, true, false, true, false),
  })
  MATRIX.push({
    name: 'delete admin-authored case (author-or-delete_test_case)',
    // Destructive probes get a FRESH fixture per role: an earlier role's
    // successful delete must not turn later roles' probes into misleading 404s.
    run: async (s) => {
      const tc = await fx.createCase(`delete probe ${s.user.role} ${stamp}`)
      return req('DELETE', `/api/test-cases?id=${tc.testCaseId}`, { jar: s.jar })
    },
    expect: M(true, true, false, false, false, false),
  })
  MATRIX.push({
    name: 'bulk delete admin-authored case (delete_test_case)',
    run: async (s) => {
      const tc = await fx.createCase(`bulk-delete probe ${s.user.role} ${stamp}`)
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
    run: (s) => req('PUT', `/api/modules?id=${fx.moduleId}`, { jar: s.jar, body: { description: `touched by ${s.user.role} ${stamp}` } }),
    expect: M(true, true, true, false, false, false),
  })
  MATRIX.push({
    name: 'create bug (create_bug)',
    run: (s) => req('POST', '/api/bugs', { jar: s.jar, body: { title: `matrix bug ${s.user.role} ${stamp}`, moduleId: fx.moduleId, description: 'probe' } }),
    expect: M(true, true, true, true, true, false),
  })
  MATRIX.push({
    name: 'link test case to bug (create/assign_bug)',
    run: (s) => req('PUT', `/api/bugs?id=${fx.adminBug}&action=link-tc`, { jar: s.jar, body: { testCaseId: fx.adminCase.testCaseId } }),
    expect: M(true, true, true, true, true, false),
  })
  MATRIX.push({
    name: 'delete bug (delete_bug)',
    run: async (s) => {
      const bid = await fx.createBug(`bug delete probe ${s.user.role} ${stamp}`)
      return req('DELETE', `/api/bugs?id=${bid}`, { jar: s.jar })
    },
    expect: M(true, true, false, false, false, false),
  })
  MATRIX.push({
    name: 'create task report (create_task_report)',
    run: (s) => req('POST', '/api/task-reports', { jar: s.jar, body: { reportDate: new Date().toISOString().slice(0, 10), tasks: [{ description: `matrix probe ${s.user.role} ${stamp}`, timeSpentMinutes: 30, status: 'done' }] } }),
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
    run: (s) => req('PUT', '/api/users?id=999999999', { jar: s.jar, body: { role: 'vp' } }),
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
    // so the probe leaves NO leftover override behind. Restore status is checked (R7.AC13).
    run: async (s) => {
      const probeRes = await req('PUT', '/api/permissions', { jar: s.jar, body: { role: 'viewer', action: 'create_bug', enabled: true } })
      if (probeRes.status >= 200 && probeRes.status < 300) {
        const restore = await req('PUT', '/api/permissions', { jar: s.jar, body: { role: 'viewer', action: 'create_bug', enabled: false } })
        fx.toggleRestores.push(restore.status)
      }
      return probeRes
    },
    expect: M(true, false, false, false, false, false),
    after: async () => {
      const cell = await fx.readCell('viewer', 'create_bug')
      return {
        name: 'toggle probe: every restore PUT -> 200 and viewer/create_bug reads source default (GET)',
        ok: fx.toggleRestores.length > 0 && fx.toggleRestores.every((st) => st === 200) && cell?.source === 'default',
        detail: `restores=${JSON.stringify(fx.toggleRestores)} cell=${JSON.stringify(cell)}`,
      }
    },
  })
  MATRIX.push({
    name: 'activity feed (view_activity_logs)',
    run: (s) => req('GET', '/api/activity-logs?pageSize=1', { jar: s.jar }),
    // product HAS view_activity_logs by default (DEFAULT_PERMISSIONS).
    expect: M(true, true, true, false, false, false),
  })
  MATRIX.push({
    name: 'create wiki doc (create_wiki_doc)',
    run: (s) => req('POST', '/api/wiki', { jar: s.jar, body: { title: `matrix wiki ${s.user.role} ${stamp}`, content: '<p>probe</p>' } }),
    expect: M(true, true, true, false, true, false),
  })
  MATRIX.push({
    name: 'edit admin wiki doc (edit_any_wiki_doc)',
    run: (s) => req('PUT', `/api/wiki?id=${fx.adminWiki}`, { jar: s.jar, body: { title: `wiki edited by ${s.user.role} ${stamp}` } }),
    expect: M(true, true, false, false, false, false),
  })
  MATRIX.push({
    name: 'delete admin wiki doc (author-or-delete_wiki_doc)',
    run: async (s) => {
      const wid = await fx.createWiki(`wiki delete probe ${s.user.role} ${stamp}`)
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
  return MATRIX
}

// ---------- the suite ----------

async function runProbes(ctx, counter, state) {
  const { stamp, db } = ctx
  const signal = state.signal
  const check = counter.check
  const req = (method, urlPath, opts = {}) => requestJson(method, urlPath, { ...opts, signal })

  // ---------- signup (R7.AC5: TCMS_ALLOW_SIGNUP is never changed) ----------
  const signupPassword = `Su${randomBytes(12).toString('base64url')}7`
  const viewerReg = await req('POST', '/api/auth?path=register', {
    body: { fullName: `Permmatrix Signup ${stamp}`, email: signupEmail(stamp), password: signupPassword },
  })
  if (viewerReg.status === 200) {
    check('signup: register -> 200 + role=viewer', viewerReg.json?.user?.role === 'viewer', `${viewerReg.status}`)
    check('signup: session permissions = []', Array.isArray(viewerReg.json?.permissions) && viewerReg.json.permissions.length === 0, JSON.stringify(viewerReg.json?.permissions))
  } else {
    check('signup: register -> 403 (closed)', viewerReg.status === 403, `got ${viewerReg.status}`)
    const rows = await db.$queryRaw`SELECT COUNT(*) AS n FROM users WHERE email = ${signupEmail(stamp)}`
    check('signup: no user row for the signup email', Number(rows[0].n) === 0, `rows=${Number(rows[0].n)}`)
  }

  // ---------- sessions for every role (stamped fixtures only, R7.AC10) ----------
  await sleep(PERMISSION_CACHE_WAIT_MS, signal)
  const byKey = Object.fromEntries(ctx.fixtures.map((u) => [u.key, u]))
  const sessions = {
    vp: await loginFixture(byKey.vp, signal),
    manager: await loginFixture(byKey.mgr, signal),
    product: await loginFixture(byKey.prod, signal),
    developer: await loginFixture(byKey.dev, signal),
    qa_engineer: await loginFixture(byKey.qa, signal),
    viewer: await loginFixture(byKey.viewer, signal),
  }
  for (const [role, s] of Object.entries(sessions)) console.log(`session ${role}: fixture perms=${s.permissions.length}`)
  const vpJar = sessions.vp.jar
  ctx.vpJar = vpJar

  // Pre-run 126-cell snapshot: fixtures exist, no permission write yet (P6).
  ctx.snapshot = await readMatrixSnapshot(vpJar, signal)
  if (!ctx.snapshot) throw new Error('could not read the pre-run GET /api/permissions snapshot')

  // ---------- fixture content, authored by the fixture VP ----------
  const fx = { toggleRestores: [], reviewerId: byKey.mgr.userId }
  fx.createCase = async (title) => {
    const res = await req('POST', '/api/test-cases', { jar: vpJar, body: { title, moduleId: fx.moduleId, description: `Matrix fixture ${title}`, priority: 'P2' } })
    const tc = res.json?.testCase ?? res.json
    if (tc?.testCaseId) ctx.entities.cases.push(tc.testCaseId)
    return tc
  }
  fx.createWiki = async (title) => {
    const res = await req('POST', '/api/wiki', { jar: vpJar, body: { title, content: '<p>matrix fixture</p>', tags: [] } })
    const id = res.json?.documentId ?? res.json?.wikiDocumentId ?? res.json?.id
    if (id) ctx.entities.wikiDocs.push(id)
    return id
  }
  fx.createBug = async (title) => {
    const res = await req('POST', '/api/bugs', { jar: vpJar, body: { title, moduleId: fx.moduleId, description: `Matrix fixture ${title}`, severity: 'low' } })
    const id = res.json?.bug?.bugId ?? res.json?.bugId ?? res.json?.id
    if (id) ctx.entities.bugs.push(id)
    return id
  }
  fx.readCell = async (role, action) => {
    const res = await req('GET', '/api/permissions', { jar: vpJar })
    return Array.isArray(res.json) ? res.json.find((t) => t.role === role && t.action === action) : null
  }

  const mod = await req('POST', '/api/modules', { jar: vpJar, body: { name: `${PREFIX} module ${stamp}` } })
  fx.moduleId = mod.json?.moduleId
  if (fx.moduleId) ctx.entities.modules.push(fx.moduleId)
  fx.adminCase = await fx.createCase(`Matrix fixture admin case ${stamp}`)
  fx.adminCase2 = await fx.createCase(`Matrix fixture admin case 2 ${stamp}`)
  fx.adminWiki = await fx.createWiki(`Matrix fixture wiki ${stamp}`)
  fx.adminBug = await fx.createBug(`Matrix fixture bug ${stamp}`)
  check(
    'fixtures created',
    ctx.fixtures.length === 6 && !!fx.moduleId && !!fx.adminCase?.testCaseId && !!fx.adminCase2?.testCaseId && !!fx.adminWiki && !!fx.adminBug,
    JSON.stringify({ users: ctx.fixtures.length, module: !!fx.moduleId, case: !!fx.adminCase?.testCaseId, case2: !!fx.adminCase2?.testCaseId, wiki: !!fx.adminWiki, bug: !!fx.adminBug })
  )
  await state.hook('after-fixtures')

  // ---------- the matrix ----------
  console.log('\n=== MATRIX PROBES ===')
  for (const probe of buildMatrix(ctx, req, fx)) {
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
    if (probe.after) {
      const r = await probe.after()
      check(r.name, r.ok, r.detail)
    }
  }

  // ---------- verdict permission round-trip on the default matrix (R7.AC3) ----------
  console.log('\n=== VERDICT / OVERRIDE ROUND-TRIP ===')
  const dev = sessions.developer
  const devId = byKey.dev.userId
  const caseForVerdict = await fx.createCase(`Verdict override fixture ${stamp}`)
  const submit = await req('PUT', `/api/test-cases?id=${caseForVerdict?.testCaseId}&action=submit-review`, { jar: vpJar, body: { reviewerId: devId } })
  const reviewId = submit.json?.reviewRequestId ?? submit.json?.reviewRequest?.reviewRequestId
  if (reviewId) ctx.entities.reviews.push(reviewId)
  check('review submitted to fixture developer', !!reviewId, JSON.stringify(submit.json).slice(0, 120))

  const denied = await req('POST', `/api/reviews?id=${reviewId}`, { jar: dev.jar, body: { verdict: 'approved', comment: 'should be denied (default matrix)' } })
  check('developer verdict without perform_review (default) -> 403', denied.status === 403, String(denied.status))
  const grant = await req('PUT', '/api/permissions', { jar: vpJar, body: { role: 'developer', action: 'perform_review', enabled: true } })
  check('VP grant developer/perform_review -> 200', grant.status === 200, String(grant.status))
  await state.hook('after-grant')
  await sleep(PERMISSION_CACHE_WAIT_MS, signal)
  // session permission snapshot refreshes on /api/auth GET
  const refreshed = await req('GET', '/api/auth', { jar: dev.jar })
  check('developer session now carries perform_review', refreshed.json?.permissions?.includes('perform_review') === true, JSON.stringify(refreshed.json?.permissions))
  const allowed = await req('POST', `/api/reviews?id=${reviewId}`, { jar: dev.jar, body: { verdict: 'approved', comment: 'granted — override round-trip works' } })
  check('developer verdict after grant -> 200', allowed.status === 200, String(allowed.status))
  const revoke = await req('PUT', '/api/permissions', { jar: vpJar, body: { role: 'developer', action: 'perform_review', enabled: false } })
  check('VP revoke developer/perform_review (default-restore) -> 200', revoke.status === 200, String(revoke.status))
  await sleep(PERMISSION_CACHE_WAIT_MS, signal)

  // grant->use->revoke on viewer (create_test_case)
  const grantV = await req('PUT', '/api/permissions', { jar: vpJar, body: { role: 'viewer', action: 'create_test_case', enabled: true } })
  check('VP grant viewer/create_test_case -> 200', grantV.status === 200, String(grantV.status))
  await sleep(PERMISSION_CACHE_WAIT_MS, signal)
  const viewerCreate = await req('POST', '/api/test-cases', { jar: sessions.viewer.jar, body: { title: `viewer can now create ${stamp}`, moduleId: fx.moduleId, description: 'override round-trip' } })
  if (viewerCreate.json?.testCaseId) ctx.entities.cases.push(viewerCreate.json.testCaseId)
  check('viewer create while granted -> 200', viewerCreate.status === 200 || viewerCreate.status === 201, String(viewerCreate.status))
  const revokeV = await req('PUT', '/api/permissions', { jar: vpJar, body: { role: 'viewer', action: 'create_test_case', enabled: false } })
  check('VP revoke viewer/create_test_case (default-restore) -> 200', revokeV.status === 200, String(revokeV.status))
  await sleep(PERMISSION_CACHE_WAIT_MS, signal)
  const viewerCreate2 = await req('POST', '/api/test-cases', { jar: sessions.viewer.jar, body: { title: `viewer denied again ${stamp}`, moduleId: fx.moduleId, description: 'override round-trip' } })
  check('viewer create after revoke -> 403', viewerCreate2.status === 403, String(viewerCreate2.status))

  // ---------- no leftover override rows for the round-trip cells ----------
  console.log('\n=== DB/STATE HYGIENE ===')
  const stale1 = await fx.readCell('viewer', 'create_test_case')
  const stale2 = await fx.readCell('developer', 'perform_review')
  check('viewer/create_test_case back to default source', stale1?.source === 'default', JSON.stringify(stale1))
  check('developer/perform_review reads source default, enabled false', stale2?.source === 'default' && stale2?.enabled === false, JSON.stringify(stale2))
}

// ---------- cleanup (finally, Ctrl+C, and --cleanup-stamp recovery) ----------

async function cleanupMatrix(ctx, counter, state, { isRecovery }) {
  const { db, guard } = ctx
  console.log('\n=== CLEANUP (SQL, keyed on fixture ids and collected ids) ===')
  const emails = allEmails(ctx.stamp)
  const found = await findUsersByEmails(db, emails)
  const fixtureIds = [...new Set([...ctx.fixtures.map((u) => u.userId), ...found.map((r) => r.user_id)])]
  const entities = await collectEntities(db, fixtureIds, ctx.entities)
  writeManifest(ctx.manifestFile, { suite: SUITE, stamp: ctx.stamp, emails, fixtureIds, entities })
  console.log(`      fixture users found=${fixtureIds.length} ${Object.entries(entities).map(([k, v]) => `${k}=${v.length}`).join(' ')}`)
  if (!(await guard.assertLockOwned())) counter.check('lock tcms_verify still owned by this run', false, 'lock lost')

  await runCleanupStep(counter, 'notifications by entity_type/entity_id of collected ids', async () => {
    const n = await deleteNotificationsByEntity(db, entities)
    return { ok: true, detail: `${n} deleted` }
  })
  await runCleanupStep(counter, 'bugs', async () => {
    const n = await deleteBugsByIds(db, entities.bugs)
    return { ok: true, detail: `${n} deleted of ${entities.bugs.length} listed` }
  })
  await runCleanupStep(counter, 'test_cases (before the module)', async () => {
    let n = 0
    for (const [i, id] of entities.cases.entries()) {
      n += await deleteTestCaseById(db, id)
      if (i === 0 && !isRecovery) await state.hook('mid-cleanup-content')
    }
    return { ok: true, detail: `${n} deleted of ${entities.cases.length} listed` }
  })
  await runCleanupStep(counter, 'review_requests/module_review_requests by fixture reviewer/requester', async () => {
    const n = await deleteReviewsByParticipants(db, fixtureIds)
    return { ok: true, detail: `${n} deleted` }
  })
  await runCleanupStep(counter, 'wiki_documents', async () => {
    let n = 0
    for (const id of entities.wikiDocs) n += await deleteWikiDocById(db, id)
    return { ok: true, detail: `${n} deleted of ${entities.wikiDocs.length} listed` }
  })
  await runCleanupStep(counter, 'modules', async () => {
    const dependents = await countModuleDependents(db, entities.modules)
    if (dependents > 0) return { ok: false, detail: `${dependents} case(s)/bug(s) still point at the fixture modules; modules NOT deleted (SET NULL trap)` }
    const n = await deleteModulesByIds(db, entities.modules)
    return { ok: true, detail: `${n} deleted of ${entities.modules.length} listed` }
  })
  let restoredRows = 0
  await runCleanupStep(counter, 'role_permissions touched cells', async () => {
    const { deleted, foreign } = await restoreTouchedCells(db, TOUCHED_CELLS, fixtureIds)
    restoredRows = deleted
    if (foreign.length) return { ok: false, detail: `matrix changed by another actor: ${foreign.join(', ')} (not touched)` }
    return { ok: true, detail: `${deleted} fixture row(s) deleted` }
  })
  if (!isRecovery || restoredRows > 0) await sleep(PERMISSION_CACHE_WAIT_MS)

  if (!isRecovery) {
    const after = ctx.vpJar ? await readMatrixSnapshot(ctx.vpJar).catch(() => null) : null
    if (!ctx.snapshot || !after) {
      counter.check('matrix: touched cells equal the pre-run GET snapshot', false, 'no pre-run or post-run GET snapshot')
      counter.check('matrix: untouched cells unchanged', false, 'no pre-run or post-run GET snapshot')
    } else {
      const touched = diffMatrix(ctx.snapshot, after, { only: TOUCHED_KEYS })
      counter.check('matrix: touched cells equal the pre-run GET snapshot', touched.length === 0, touched.join('; '))
      const others = diffMatrix(ctx.snapshot, after, { except: TOUCHED_KEYS })
      counter.check('matrix: untouched cells unchanged', others.length === 0, `matrix changed by another actor: ${others.join('; ')}`)
    }
  }

  await runCleanupStep(counter, 'activity_logs by fixture user_id', async () => {
    const n = await deleteActivityLogsByUsers(db, fixtureIds)
    return { ok: true, detail: `${n} deleted` }
  })
  await runCleanupStep(counter, 'login_attempts by fixture email', async () => {
    const n = await deleteLoginAttemptsByEmails(db, emails)
    return { ok: true, detail: `${n} deleted` }
  })
  await runCleanupStep(counter, 'users by fixture id (incl. signup account)', async () => {
    const { deleted, failed } = await deleteUsersByIds(db, fixtureIds)
    return { ok: failed.length === 0, detail: `${deleted} deleted${failed.length ? `; not deleted: ${failed.join(', ')}` : ''}` }
  })

  console.log('\n=== RESIDUE (by fixture ids and collected ids) ===')
  const residue = await countResidue(db, { fixtureIds, emails, entities }, RESIDUE_TABLES)
  checkResidue(counter, residue)
}

// ---------- entry points ----------

async function runSuite(ctx, hooks) {
  const counter = createCounter()
  const state = createRunState(hooks)
  // R7.AC0 / P6: precondition by SQL before any fixture exists (replaces the old reset).
  const rows = await ctx.db.$queryRaw`SELECT role, action, enabled, updated_by_id FROM role_permissions ORDER BY role, action`
  if (rows.length > 0) {
    console.log(`PRECONDITION: ${rows.length} override row(s): ${rows.map((r) => `${r.role}/${r.action}=${Number(r.enabled)}`).join(', ')}`)
    console.log('NOT RUN: no fixture created, nothing written')
    process.removeListener('SIGINT', state.onSigint)
    return 2
  }

  try {
    ctx.fixtures = await createFixtureUsers(ctx.db, fixtureSpecs(ctx.stamp))
    writeManifest(ctx.manifestFile, { suite: SUITE, stamp: ctx.stamp, fixtureIds: ctx.fixtures.map((u) => u.userId) })
    await runProbes(ctx, counter, state)
  } catch (err) {
    if (state.interrupted) counter.check('INTERRUPTED (SIGINT)', false)
    else if (err instanceof ForcedFailure) counter.check(err.message, false)
    else counter.check(`suite aborted: ${err.message}`, false)
  } finally {
    state.cleaning = true
    try {
      await cleanupMatrix(ctx, counter, state, { isRecovery: false })
    } catch (err) {
      counter.check('cleanup completed', false, err.message)
    }
  }

  console.log(`\nPASS=${counter.pass} FAIL=${counter.fail}`)
  console.log(`RESULT: ${counter.pass} passed, ${counter.fail} failed`)
  process.removeListener('SIGINT', state.onSigint)
  return resolveExitCode(state, counter)
}

async function runRecovery(ctx) {
  const counter = createCounter()
  const state = createRunState({ failAt: null, pauseAt: null })
  state.cleaning = true
  console.log(`RECOVERY: cleanup only for stamp ${ctx.stamp}`)
  try {
    await cleanupMatrix(ctx, counter, state, { isRecovery: true })
  } catch (err) {
    counter.check('cleanup completed', false, err.message)
  }
  console.log(`\nPASS=${counter.pass} FAIL=${counter.fail}`)
  console.log(`RESULT: recovery ${counter.pass} passed, ${counter.fail} failed`)
  process.removeListener('SIGINT', state.onSigint)
  return counter.fail > 0 ? 1 : 0
}

async function main() {
  const flags = parseFlags(process.argv.slice(2))
  const recoveryStamp = flags['cleanup-stamp']
  const stamp = recoveryStamp ? String(recoveryStamp) : String(Date.now())
  console.log(`STAMP=${stamp}`)
  if (recoveryStamp && !/^\d{13}$/.test(stamp)) {
    console.log('NOT RUN: --cleanup-stamp must be the 13-digit stamp printed by an earlier run')
    return 2
  }
  const hooks = readHooks(HOOK_STEPS)
  if (!hooks.ok) {
    console.log(`NOT RUN: ${hooks.message}`)
    return 2
  }
  const manifestFile = manifestPath(SUITE, stamp)
  console.log(`MANIFEST=${manifestFile}`)

  let guard
  try {
    guard = await openGuardedDb()
  } catch (err) {
    if (err instanceof GuardAbort) {
      console.log(`NOT RUN: ${err.message}`)
      return 2
    }
    throw err
  }
  const ctx = { db: guard.db, guard, stamp, manifestFile, fixtures: [], entities: emptyEntities(), snapshot: null, vpJar: null }
  try {
    return recoveryStamp ? await runRecovery(ctx) : await runSuite(ctx, hooks)
  } finally {
    await guard.release()
  }
}

main().then(
  (code) => { process.exitCode = code },
  (err) => { console.error(`SUITE ERROR: ${err.message}`); process.exitCode = 1 }
)
