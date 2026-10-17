#!/usr/bin/env node
/**
 * Backlog B4: "Needs revision" flagged fields must round-trip (an old note said they
 * might always save as empty). Raises a review on a temp case, records needs_revision
 * and failed verdicts with flagged fields, and reads them back through both read paths:
 * GET /api/reviews?id= and GET /api/test-cases?id=&action=reviews. Removes its rows (B16).
 * Usage: node scripts/verify-flagged-fields.mjs   (app on http://localhost:3000)
 */
import { cleanupRunEntities } from './lib/suite-cleanup.mjs'

const BASE = process.env.TCMS_BASE_URL || 'http://localhost:3000'
const stamp = Date.now()
const created = { modules: [], cases: [] }
let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`) }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth?path=login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms' },
    body: JSON.stringify({ email, password }),
  })
  const cookie = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('tcms-access='))?.split(';')[0]
  if (!cookie) throw new Error(`login failed for ${email} (${res.status})`)
  return { cookie, user: (await res.json()).user }
}

async function api(s, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms', Cookie: s.cookie },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = null
  try { data = await res.json() } catch { /* no body */ }
  return { status: res.status, data }
}

async function main() {
  const vp = await login('admin@tcms.com', 'Admin@123')
  const manager = await login('teamlead@tcms.com', 'Lead@123')
  const mod = await api(vp, 'POST', '/api/modules', { name: `Flagged verify ${stamp}`, description: 'B4 fixture' })
  if (mod.data?.moduleId) created.modules.push(mod.data.moduleId)
  const tc = await api(vp, 'POST', '/api/test-cases', { title: `Flagged case ${stamp}`, moduleId: mod.data?.moduleId, description: 'fixture', priority: 'P2' })
  if (tc.data?.testCaseId) created.cases.push(tc.data.testCaseId)
  const submit = await api(vp, 'PUT', `/api/test-cases?id=${tc.data?.testCaseId}&action=submit-review`, { reviewerId: manager.user.userId })
  const reviewId = submit.data?.reviewRequestId
  check('fixture: review raised for the manager', !!reviewId, `${submit.status}`)

  const first = ['Title', 'Expected Result']
  const v1 = await api(manager, 'POST', `/api/reviews?id=${reviewId}`, { verdict: 'needs_revision', comment: 'fix these', flaggedFields: first })
  check('needs_revision with 2 flagged fields -> 200', v1.status === 200, `${v1.status} ${JSON.stringify(v1.data).slice(0, 120)}`)
  const second = ['Description']
  const v2 = await api(manager, 'POST', `/api/reviews?id=${reviewId}`, { verdict: 'failed', comment: 'still wrong', flaggedFields: second })
  check('failed with 1 flagged field -> 200', v2.status === 200, `${v2.status}`)

  const detail = await api(manager, 'GET', `/api/reviews?id=${reviewId}`)
  const events = [...(detail.data?.events ?? [])].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  check('GET review: 2 events', events.length === 2, `events=${events.length}`)
  check('GET review: needs_revision event keeps its flagged fields', same(events[0]?.flaggedFields, first), JSON.stringify(events[0]?.flaggedFields))
  check('GET review: failed event keeps its flagged fields', same(events[1]?.flaggedFields, second), JSON.stringify(events[1]?.flaggedFields))

  const history = await api(vp, 'GET', `/api/test-cases?id=${tc.data?.testCaseId}&action=reviews`)
  const all = (history.data ?? []).flatMap((r) => r.events ?? []).map((e) => e.flaggedFields)
  check('GET test-case reviews: both flagged lists present', all.some((f) => same(f, first)) && all.some((f) => same(f, second)), JSON.stringify(all))

  const bad = await api(manager, 'POST', `/api/reviews?id=${reviewId}`, { verdict: 'needs_revision', comment: 'x', flaggedFields: 'Title' })
  check('flaggedFields not an array -> 400', bad.status === 400, `${bad.status}`)
}

main()
  .catch((e) => check(`run aborted: ${e.message}`, false))
  .finally(async () => {
    await cleanupRunEntities(check, created)
    console.log(`\nFLAGGED-FIELDS RESULT: ${pass} passed, ${fail} failed`)
    process.exitCode = fail ? 1 : 0
  })
