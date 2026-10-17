#!/usr/bin/env node
/**
 * Readable numeric ids (Phase 5) — two proofs:
 *
 * A. LAST_INSERT_ID() is read on the SAME connection as its INSERT. 50 bugs (manager) and
 *    25 test cases (qa1) are created IN PARALLEL at the same moment; every returned id must
 *    be a positive-integer string, all ids distinct, and GET ?id= of each must return the
 *    row with the exact title that was sent (a wrong connection would hand one request
 *    another request's id).
 * B. Every id in every API response is a positive-integer digit string ("42"): a sweep over
 *    the list / detail / picker endpoints, checking every `id` / `*Id` / `*Ids` value
 *    recursively (null allowed; JSON numbers are a FAIL — ids travel as strings).
 *
 * Writes only its own bugs + test cases (and their activity rows) and removes them at the
 * end (scripts/lib/suite-cleanup.mjs, B16).
 * Usage: node scripts/verify-numeric-ids.mjs   (TCMS_BASE_URL, default http://localhost:3000)
 */
import { cleanupRunEntities } from './lib/suite-cleanup.mjs'

const BASE = process.env.TCMS_BASE_URL || 'http://localhost:3000'
const PARALLEL_BUGS = 50
const PARALLEL_CASES = 25
const stamp = Date.now()
const created = { bugs: [], cases: [] }
const ID_RE = /^[1-9][0-9]*$/
// `*Id` keys that are NOT TCMS row ids (external systems / tokens).
const NOT_ROW_IDS = new Set(['crewdeskUserId', 'telegramChatId', 'ticketId', 'crewdeskCommentId', 'testTicketId', 'jti'])

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

/** Collects every id-like value with its JSON path. */
function collectIds(value, path = '$', out = []) {
  if (Array.isArray(value)) value.forEach((v, i) => collectIds(v, `${path}[${i}]`, out))
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const isIdKey = (k === 'id' || /Id$/.test(k) || /Ids$/.test(k)) && !NOT_ROW_IDS.has(k)
      if (isIdKey && Array.isArray(v)) v.forEach((x, i) => out.push({ path: `${path}.${k}[${i}]`, key: k, value: x }))
      else if (isIdKey && (v === null || typeof v !== 'object')) out.push({ path: `${path}.${k}`, key: k, value: v })
      else collectIds(v, `${path}.${k}`, out)
    }
  }
  return out
}

/** A row id: digit string. entityId may also be a "role:action" key (permission toggles). */
function isValidId(entry) {
  if (entry.value === null || entry.value === undefined) return true
  if (typeof entry.value !== 'string') return false
  if (entry.key === 'entityId' && /^[a-z_]+:[a-z_]+$/.test(entry.value)) return true
  return ID_RE.test(entry.value)
}

async function partA(manager, qa, moduleId) {
  console.log(`\n== A. ${PARALLEL_BUGS} bugs + ${PARALLEL_CASES} test cases created in parallel ==`)
  const bugTitles = Array.from({ length: PARALLEL_BUGS }, (_, i) => `numeric-ids bug ${stamp} #${i}`)
  const caseTitles = Array.from({ length: PARALLEL_CASES }, (_, i) => `numeric-ids case ${stamp} #${i}`)
  const [bugs, cases] = await Promise.all([
    Promise.all(bugTitles.map((title) => api(manager, 'POST', '/api/bugs', { title, description: 'numeric-ids parallel insert', severity: 'low', moduleId }))),
    Promise.all(caseTitles.map((title) => api(qa, 'POST', '/api/test-cases', { title, moduleId, description: 'numeric-ids parallel insert' }))),
  ])
  for (const r of bugs) if (r.data?.bugId) created.bugs.push(r.data.bugId)
  for (const r of cases) if (r.data?.testCaseId) created.cases.push(r.data.testCaseId)

  check(`all ${PARALLEL_BUGS} bug creates -> 200`, bugs.every((r) => r.status === 200), bugs.filter((r) => r.status !== 200).map((r) => r.status).join(','))
  check(`all ${PARALLEL_CASES} test-case creates -> 200`, cases.every((r) => r.status === 200), cases.filter((r) => r.status !== 200).map((r) => `${r.status} ${JSON.stringify(r.data).slice(0, 80)}`).join(' | '))
  const bugIds = bugs.map((r) => r.data?.bugId)
  const caseIds = cases.map((r) => r.data?.testCaseId)
  check('every new bug id is a positive-integer string', bugIds.every((id) => typeof id === 'string' && ID_RE.test(id)), bugIds.slice(0, 5).join(','))
  check('every new test-case id is a positive-integer string', caseIds.every((id) => typeof id === 'string' && ID_RE.test(id)), caseIds.slice(0, 5).join(','))
  check('bug ids are all different', new Set(bugIds).size === bugIds.length)
  check('test-case ids are all different', new Set(caseIds).size === caseIds.length)

  // Each id must point at ITS row: the title it was created with.
  const bugReads = await Promise.all(bugIds.map((id) => api(manager, 'GET', `/api/bugs?id=${id}`)))
  const bugMismatch = bugReads.map((r, i) => (r.data?.title === bugTitles[i] ? null : `${bugIds[i]}:${r.data?.title}`)).filter(Boolean)
  check('every bug id returns the bug that was created with it', bugMismatch.length === 0, bugMismatch.slice(0, 3).join(' | '))
  const caseReads = await Promise.all(caseIds.map((id) => api(qa, 'GET', `/api/test-cases?id=${id}`)))
  const caseMismatch = caseReads.map((r, i) => (r.data?.title === caseTitles[i] ? null : `${caseIds[i]}:${r.data?.title}`)).filter(Boolean)
  check('every test-case id returns the case that was created with it', caseMismatch.length === 0, caseMismatch.slice(0, 3).join(' | '))
}

async function partB(vp) {
  console.log('\n== B. every id in every API response is a positive-integer string ==')
  const firstOf = (r, key) => (Array.isArray(r.data) ? r.data : r.data?.data ?? r.data?.flat ?? [])[0]?.[key]
  const lists = {
    '/api/auth': null,
    '/api/modules': null,
    '/api/test-cases?pageSize=50': null,
    '/api/test-cases?action=options': null,
    '/api/bugs?pageSize=50': null,
    '/api/bugs?action=options': null,
    '/api/reviews?pageSize=50': null,
    '/api/reviews?action=queue': null,
    '/api/module-reviews?action=all': null,
    '/api/module-reviews?action=queue': null,
    '/api/users?pageSize=50': null,
    '/api/users?action=options': null,
    '/api/notifications?pageSize=50': null,
    '/api/activity-logs?pageSize=50': null,
    '/api/task-reports?action=my': null,
    '/api/task-reports?pageSize=50': null,
    '/api/stats?action=dashboard': null,
    '/api/wiki?page=1&pageSize=24': null,
    '/api/permissions': null,
    '/api/search?q=log': null,
  }
  for (const path of Object.keys(lists)) lists[path] = await api(vp, 'GET', path)
  const details = []
  const mod = firstOf(lists['/api/modules'], 'moduleId')
  const tc = firstOf(lists['/api/test-cases?pageSize=50'], 'testCaseId')
  const bug = firstOf(lists['/api/bugs?pageSize=50'], 'bugId')
  const wiki = firstOf(lists['/api/wiki?page=1&pageSize=24'], 'wikiDocumentId')
  const review = firstOf(lists['/api/reviews?pageSize=50'], 'reviewRequestId')
  const moduleReview = firstOf(lists['/api/module-reviews?action=all'], 'moduleReviewRequestId')
  if (mod) details.push(`/api/modules?id=${mod}`)
  if (tc) details.push(`/api/test-cases?id=${tc}`, `/api/test-cases?id=${tc}&action=history`, `/api/test-cases?id=${tc}&action=reviews`)
  if (bug) details.push(`/api/bugs?id=${bug}`, `/api/bugs?id=${bug}&action=links`)
  if (wiki) details.push(`/api/wiki?id=${wiki}`)
  if (review) details.push(`/api/reviews?id=${review}`)
  if (moduleReview) details.push(`/api/module-reviews?id=${moduleReview}`)
  check('seed has a wiki document (covers /wiki/[id])', !!wiki)
  const all = { ...lists }
  for (const path of details) all[path] = await api(vp, 'GET', path)

  let total = 0
  for (const [path, r] of Object.entries(all)) {
    const ids = collectIds(r.data)
    total += ids.length
    const bad = ids.filter((e) => !isValidId(e))
    check(`${path}: 200 and ${ids.length} ids all positive-integer strings`, r.status === 200 && bad.length === 0,
      r.status !== 200 ? `status ${r.status}` : bad.slice(0, 3).map((e) => `${e.path}=${JSON.stringify(e.value)}`).join(' | '))
  }
  check('the sweep saw ids at all', total > 50, `ids=${total}`)
}

async function main() {
  console.log(`NUMERIC-IDS base=${BASE}`)
  const vp = await login('admin@tcms.com', 'Admin@123')
  const manager = await login('teamlead@tcms.com', 'Lead@123')
  const qa = await login('qa1@tcms.com', 'QA@12345')
  const mods = await api(vp, 'GET', '/api/modules')
  const moduleId = mods.data?.flat?.[0]?.moduleId
  check('a seeded module exists', typeof moduleId === 'string' && ID_RE.test(moduleId), String(moduleId))
  try {
    await partA(manager, qa, moduleId)
    await partB(vp)
  } finally {
    await cleanupRunEntities(check, created)
  }
  console.log(`\nNUMERIC-IDS RESULT: ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error('NUMERIC-IDS ERROR:', err.message)
  await cleanupRunEntities(check, created).catch(() => {})
  process.exit(2)
})
