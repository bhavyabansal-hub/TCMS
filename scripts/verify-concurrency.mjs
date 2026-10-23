#!/usr/bin/env node
/**
 * Race test for optimistic locking (backlog B2): two users editing the same record never
 * silently overwrite each other. For test cases, bugs, modules, reviews and module-review
 * bulk verdicts:
 *   - stale save (expectedUpdatedAt = an old value)          -> 409 STALE message
 *   - two parallel saves loaded from the same updatedAt      -> exactly one 200, one 409
 *   - save with the fresh updatedAt                          -> 200
 *   - legacy client without expectedUpdatedAt                -> 200 (server guards its own read)
 *   - malformed expectedUpdatedAt                            -> 400
 * Works on its own temp module + case + bug + review; removes them at the end (B16).
 * Usage: node scripts/verify-concurrency.mjs   (app on http://localhost:3000)
 */
import { cleanupRunEntities } from './lib/suite-cleanup.mjs'

const BASE = process.env.TCMS_BASE_URL || 'http://localhost:3000'
const STALE = 'This item was changed by someone else — reload'
const stamp = Date.now()
const created = { modules: [], cases: [], bugs: [], moduleReviews: [] }
let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`) }
}

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth?path=login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms' },
    body: JSON.stringify({ email, password }),
  })
  const raw = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('tcms-access=')) ?? ''
  const token = raw.split(';')[0].replace(/^tcms-access=/, '')
  if (!token) throw new Error(`login failed for ${email} (${res.status})`)
  return { token, user: (await res.json()).user }
}

async function api(session, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms', Cookie: `tcms-access=${session.token}` },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = null
  try { data = await res.json() } catch { /* no body */ }
  return { status: res.status, data }
}

const isStale = (r) => r.status === 409 && r.data?.error === STALE
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The shared scenario for one resource. `put(session, body)` saves; `load()` returns updatedAt. */
async function checkResource(label, { a, b, load, put, bodyA, bodyB }) {
  const t0 = await load()
  check(`${label}: loaded updatedAt`, typeof t0 === 'string', String(t0))
  await sleep(5) // a later write always gets a different DATETIME(3) value
  const first = await put(a, { ...bodyA, expectedUpdatedAt: t0 })
  check(`${label}: user A saves with the loaded value -> 200`, first.status === 200, `${first.status} ${JSON.stringify(first.data).slice(0, 120)}`)
  const second = await put(b, { ...bodyB, expectedUpdatedAt: t0 })
  check(`${label}: user B saves the stale copy -> 409 "${STALE}"`, isStale(second), `${second.status} ${JSON.stringify(second.data)}`)

  const t1 = await load()
  await sleep(5)
  const [r1, r2] = await Promise.all([
    put(a, { ...bodyA, expectedUpdatedAt: t1 }),
    put(b, { ...bodyB, expectedUpdatedAt: t1 }),
  ])
  const statuses = [r1.status, r2.status].sort().join(',')
  check(`${label}: two parallel saves from one copy -> one 200 + one 409`, statuses === '200,409' && (isStale(r1) || isStale(r2)), statuses)

  const t2 = await load()
  await sleep(5)
  const fresh = await put(b, { ...bodyB, expectedUpdatedAt: t2 })
  check(`${label}: reload + save -> 200`, fresh.status === 200, `${fresh.status}`)
  const bad = await put(b, { ...bodyB, expectedUpdatedAt: 'yesterday' })
  check(`${label}: malformed expectedUpdatedAt -> 400`, bad.status === 400, `${bad.status}`)
}

async function main() {
  const vp = await login('admin@tcms.com', 'Admin@123')
  const manager = await login('teamlead@tcms.com', 'Lead@123')

  // ---- fixtures (all removed at the end) ----
  const mod = await api(vp, 'POST', '/api/modules', { name: `Concurrency verify ${stamp}`, description: 'verify-concurrency fixture' })
  const moduleId = mod.data?.moduleId
  if (moduleId) created.modules.push(moduleId)
  check('fixture: temp module', !!moduleId, JSON.stringify(mod.data).slice(0, 120))
  const tc = await api(vp, 'POST', '/api/test-cases', { title: `Concurrency case ${stamp}`, moduleId, description: 'fixture', priority: 'P2' })
  const testCaseId = tc.data?.testCaseId
  if (testCaseId) created.cases.push(testCaseId)
  check('fixture: temp test case', !!testCaseId, JSON.stringify(tc.data).slice(0, 120))
  const bug = await api(vp, 'POST', '/api/bugs', { title: `Concurrency bug ${stamp}`, description: 'fixture', severity: 'low', moduleId })
  const bugId = bug.data?.bugId
  if (bugId) created.bugs.push(bugId)
  check('fixture: temp bug', !!bugId, JSON.stringify(bug.data).slice(0, 120))

  // ---- test cases, bugs, modules ----
  await checkResource('test case', {
    a: vp, b: manager,
    load: async () => (await api(vp, 'GET', `/api/test-cases?id=${testCaseId}`)).data?.updatedAt,
    put: (s, body) => api(s, 'PUT', `/api/test-cases?id=${testCaseId}`, body),
    bodyA: { title: `Concurrency case ${stamp} (A)` },
    bodyB: { title: `Concurrency case ${stamp} (B)` },
  })
  const legacyTc = await api(manager, 'PUT', `/api/test-cases?id=${testCaseId}`, { priority: 'P1' })
  check('test case: legacy client without expectedUpdatedAt -> 200', legacyTc.status === 200, `${legacyTc.status}`)

  await checkResource('bug', {
    a: vp, b: manager,
    load: async () => (await api(vp, 'GET', `/api/bugs?id=${bugId}`)).data?.updatedAt,
    put: (s, body) => api(s, 'PUT', `/api/bugs?id=${bugId}`, body),
    bodyA: { severity: 'high' },
    bodyB: { status: 'in_progress' },
  })
  const legacyBug = await api(manager, 'PUT', `/api/bugs?id=${bugId}`, { severity: 'medium' })
  check('bug: legacy client without expectedUpdatedAt -> 200', legacyBug.status === 200, `${legacyBug.status}`)

  await checkResource('module', {
    a: vp, b: manager,
    load: async () => (await api(vp, 'GET', `/api/modules?id=${moduleId}`)).data?.module?.updatedAt,
    put: (s, body) => api(s, 'PUT', `/api/modules?id=${moduleId}`, body),
    bodyA: { description: 'edited by A' },
    bodyB: { description: 'edited by B' },
  })

  // ---- reviews: forward (vp -> manager) and verdict races on one open review ----
  const submit = await api(vp, 'PUT', `/api/test-cases?id=${testCaseId}&action=submit-review`, { reviewerId: vp.user.userId })
  const reviewId = submit.data?.reviewRequestId
  check('fixture: review raised (reviewer = vp)', !!reviewId, `${submit.status} ${JSON.stringify(submit.data).slice(0, 120)}`)
  const loadReview = async () => (await api(vp, 'GET', `/api/reviews?id=${reviewId}`)).data?.updatedAt
  const r0 = await loadReview()
  await sleep(5)
  const fwd = await api(vp, 'POST', `/api/reviews?id=${reviewId}&action=forward`, { reviewerId: manager.user.userId, expectedUpdatedAt: r0 })
  check('review: forward with the loaded value -> 200', fwd.status === 200, `${fwd.status} ${JSON.stringify(fwd.data).slice(0, 120)}`)
  const staleFwd = await api(manager, 'POST', `/api/reviews?id=${reviewId}&action=forward`, { reviewerId: vp.user.userId, expectedUpdatedAt: r0 })
  check('review: forward from a stale copy -> 409', isStale(staleFwd), `${staleFwd.status} ${JSON.stringify(staleFwd.data)}`)
  const r1 = await loadReview()
  await sleep(5)
  const verdict = { verdict: 'needs_revision', comment: 'race', flaggedFields: ['title'] }
  const [v1, v2] = await Promise.all([
    api(manager, 'POST', `/api/reviews?id=${reviewId}`, { ...verdict, expectedUpdatedAt: r1 }),
    api(manager, 'POST', `/api/reviews?id=${reviewId}`, { ...verdict, expectedUpdatedAt: r1 }),
  ])
  const vs = [v1.status, v2.status].sort().join(',')
  check('review: two parallel verdicts from one copy -> one 200 + one 409', vs === '200,409', vs)
  const staleVerdict = await api(manager, 'POST', `/api/reviews?id=${reviewId}`, { ...verdict, expectedUpdatedAt: r1 })
  check('review: verdict from a stale copy -> 409', isStale(staleVerdict), `${staleVerdict.status} ${JSON.stringify(staleVerdict.data)}`)
  const events = (await api(manager, 'GET', `/api/reviews?id=${reviewId}`)).data?.events ?? []
  check('review: exactly one verdict event recorded (the loser wrote nothing)', events.length === 1, `events=${events.length}`)

  // ---- module review bulk verdict: two reviewers' clicks on one open module review ----
  const tc2 = await api(vp, 'POST', '/api/test-cases', { title: `Concurrency case 2 ${stamp}`, moduleId, description: 'fixture', priority: 'P2' })
  if (tc2.data?.testCaseId) created.cases.push(tc2.data.testCaseId)
  const modSubmit = await api(vp, 'PUT', `/api/modules?id=${moduleId}&action=submit-review`, { reviewerId: manager.user.userId, includeSubmodules: false })
  const moduleReviewId = modSubmit.data?.moduleReview?.moduleReviewRequestId
  if (moduleReviewId) created.moduleReviews.push(moduleReviewId)
  check('fixture: module review raised (reviewer = manager)', !!moduleReviewId, `${modSubmit.status} ${JSON.stringify(modSubmit.data).slice(0, 120)}`)
  const m0 = (await api(manager, 'GET', `/api/module-reviews?id=${moduleReviewId}`)).data?.updatedAt
  await sleep(5)
  const bulk = { verdict: 'needs_revision', comment: 'race' }
  const [b1, b2] = await Promise.all([
    api(manager, 'POST', `/api/module-reviews?id=${moduleReviewId}&action=bulk-verdict`, { ...bulk, expectedUpdatedAt: m0 }),
    api(manager, 'POST', `/api/module-reviews?id=${moduleReviewId}&action=bulk-verdict`, { ...bulk, expectedUpdatedAt: m0 }),
  ])
  const bs = [b1.status, b2.status].sort().join(',')
  check('module review: two parallel bulk verdicts from one copy -> one 200 + one 409', bs === '200,409', `${bs} ${JSON.stringify([b1.data, b2.data]).slice(0, 200)}`)
  const staleBulk = await api(manager, 'POST', `/api/module-reviews?id=${moduleReviewId}&action=bulk-verdict`, { ...bulk, expectedUpdatedAt: m0 })
  check('module review: bulk verdict from a stale copy -> 409', isStale(staleBulk), `${staleBulk.status} ${JSON.stringify(staleBulk.data)}`)
}

main()
  .catch((e) => check(`run aborted: ${e.message}`, false))
  .finally(async () => {
    await cleanupRunEntities(check, created)
    console.log(`\nCONCURRENCY RESULT: ${pass} passed, ${fail} failed`)
    process.exitCode = fail ? 1 : 0
  })
