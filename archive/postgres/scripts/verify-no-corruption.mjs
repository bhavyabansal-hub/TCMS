/**
 * Concurrency / corruption-proof smoke (owner requirement: "no corruption,
 * even with many test cases"). Runs against the LOCAL production server.
 *
 * Proves:
 *   1. LOST-UPDATE GUARD: 8 concurrent PUTs on one test case -> the outcome is
 *      ALWAYS corruption-free: final version === 1 + #successes, history holds
 *      every version 1..final-1 EXACTLY ONCE (no duplicate/missing snapshot),
 *      and where an overlap occurred a 409 was served (guard observed live).
 *   2. LOCK PROOF (deterministic, DB level): a transaction holding the row
 *      lock forces a concurrent optimistic update to match 0 rows.
 *   3. BULK VOLUME: CSV import of 60 rows -> exactly 60 created rows.
 *   4. VERDICT GUARD: a completed review refuses a second verdict (409),
 *      review_events keeps exactly one event for that review.
 */
const BASE = 'http://localhost:3000'
const ORIGIN = BASE
const CSV_ROWS = 60

async function req(method, path, { body, jar } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms' }
  if (jar) headers.Cookie = jar
  if (method === 'POST' || method === 'DELETE' || method === 'PUT') headers.Origin = ORIGIN
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json, setCookie: res.headers.getSetCookie?.() ?? [] }
}

async function login(email, password) {
  const res = await req('POST', '/api/auth?path=login', { body: { email, password } })
  if (res.status !== 200) throw new Error(`login failed: ${JSON.stringify(res.json)}`)
  const pick = (name) => {
    const pair = res.setCookie.find((c) => c.startsWith(`${name}=`))
    return pair ? pair.split(';')[0].slice(name.length + 1) : undefined
  }
  return `tcms-access=${pick('tcms-access')}`
}

let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok  ${name}`)
  else { failures++; console.error(`FAIL  ${name} ${detail}`) }
}

// ---------- setup ----------
const jar = await login('admin@tcms.com', 'Admin@123')

const modules = await req('GET', '/api/modules', { jar })
const moduleId = modules.json.flat[0].moduleId
check('setup: at least one module exists', Boolean(moduleId))

// ============================================================
// 1. LOST-UPDATE GUARD — 8 concurrent edits on one test case
// ============================================================
console.log('\n[1] concurrent edits (lost-update guard)')
const created = await req('POST', '/api/test-cases', {
  jar,
  body: { moduleId, title: 'Corruption probe — concurrent edit', priority: 'P2', tags: [], description: 'probe' },
})
check('create probe case -> 200', created.status === 200, JSON.stringify(created.json))
const probeId = created.json.testCaseId
const initialVersion = created.json.version // 1

const results = await Promise.all(
  Array.from({ length: 8 }, (_, i) =>
    req('PUT', `/api/test-cases?id=${probeId}`, { jar, body: { title: `Concurrent edit ${i + 1}` } }))
)
const okCount = results.filter((r) => r.status === 200).length
const conflictCount = results.filter((r) => r.status === 409).length
const other = results.filter((r) => r.status !== 200 && r.status !== 409)
check('only 200s and 409s came back', other.length === 0, JSON.stringify(other.map((r) => r.status)))
console.log(`  (observed: ${okCount} saved, ${conflictCount} rejected with 409 — overlap or serialized, both are safe)`)

// Invariants that MUST hold in every outcome:
const probeAfter = await req('GET', `/api/test-cases?id=${probeId}`, { jar })
check('final version === 1 + saved count', probeAfter.json.version === initialVersion + okCount,
  `version ${probeAfter.json.version}, saved ${okCount}`)
// The winning titles must be a subset of what we sent (no phantom content).
const sentTitles = new Set(Array.from({ length: 8 }, (_, i) => `Concurrent edit ${i + 1}`))
check('final title is one of the sent edits', sentTitles.has(probeAfter.json.title), probeAfter.json.title)

const history = await req('GET', `/api/test-cases?id=${probeId}&action=history`, { jar })
const versions = history.json.map((h) => h.version).sort((x, y) => x - y)
const expected = Array.from({ length: probeAfter.json.version - initialVersion }, (_, i) => initialVersion + i)
check('history snapshots are exactly 1..final-1, each ONCE',
  JSON.stringify(versions) === JSON.stringify(expected),
  `got ${JSON.stringify(versions)}, expected ${JSON.stringify(expected)}`)

// Sequential edit still works after the burst.
const afterBurst = await req('PUT', `/api/test-cases?id=${probeId}`, { jar, body: { title: 'Sequential edit after burst' } })
check('sequential edit after burst -> 200', afterBurst.status === 200, JSON.stringify(afterBurst.json))

// ============================================================
// 2. LOCK PROOF (deterministic, DB level)
// ============================================================
console.log('\n[2] optimistic-lock proof at the SQL level')
process.env.DATABASE_URL = 'postgresql://tcms:tcms@localhost:5499/tcms'
const { PrismaClient } = await import('/home/z/my-project/node_modules/@prisma/client/default.js')
const db = new PrismaClient()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  // Re-read AFTER the sequential edit so the version is fresh.
  const fresh = await req('GET', `/api/test-cases?id=${probeId}`, { jar })
  const versionNow = fresh.json.version
  // A mimics the app's optimistic update: it bumps version when it wins.
  const txA = db.$transaction(async (tx) => {
    const nA = await tx.$executeRaw`UPDATE test_cases SET title = 'Lock proof A', version = ${versionNow + 1} WHERE test_case_id = ${probeId} AND version = ${versionNow}`
    await sleep(600) // hold the row lock so a concurrent writer MUST queue
    return nA
  })
  await sleep(150) // A's UPDATE has now locked the row
  const txB = db.$transaction(async (tx) => {
    return tx.$executeRaw`UPDATE test_cases SET title = 'Lock proof B' WHERE test_case_id = ${probeId} AND version = ${versionNow}`
  })
  const [nA, nB] = await Promise.all([txA, txB])
  check('writer A (holds lock) matched the row', nA === 1, String(nA))
  check('writer B (queued behind lock) matched ZERO rows -> 409 path', nB === 0, String(nB))
} finally {
  await db.$disconnect()
}
// Server state unchanged by the raw lock proof? A committed, so version moved
// WITHOUT bumping version — restore cleanly by bumping through the API.
const afterLockProof = await req('PUT', `/api/test-cases?id=${probeId}`, { jar, body: { title: 'After lock proof' } })
check('API edit after lock proof -> 200 (row intact)', afterLockProof.status === 200, JSON.stringify(afterLockProof.json))

// ============================================================
// 3. BULK VOLUME — CSV import of 60 rows
// ============================================================
console.log(`\n[3] bulk CSV import (${CSV_ROWS} rows)`)
const header = 'title,description,priority,tags'
const rows = Array.from({ length: CSV_ROWS }, (_, i) =>
  `"Bulk import case ${i + 1}","Volume probe row ${i + 1}",P2,probe;bulk`).join('\n')
const imp = await req('POST', '/api/test-cases?action=import', {
  jar,
  body: { moduleId, fileName: 'probe.csv', csv: `${header}\n${rows}` },
})
check(`import ${CSV_ROWS} rows -> 200`, imp.status === 200, JSON.stringify(imp.json).slice(0, 200))
check(`imported count === ${CSV_ROWS}`, imp.json.imported === CSV_ROWS, `got ${imp.json.imported}`)
check('failed count === 0', imp.json.failed === 0, `got ${imp.json.failed}`)

const search = await req('GET', '/api/test-cases?search=Bulk%20import%20case&pageSize=1', { jar })
check('imported rows are queryable (total >= 60)', search.json.total >= CSV_ROWS, `got ${search.json.total}`)

// ============================================================
// 4. VERDICT GUARD — one verdict per review
// ============================================================
console.log('\n[4] single-verdict guard')
const tcList = await req('GET', `/api/test-cases?moduleId=${moduleId}&pageSize=1`, { jar })
const someCase = tcList.json.data[0]
check('have a case to submit for review', Boolean(someCase?.testCaseId))
const submitted = await req('PUT', `/api/test-cases?id=${someCase.testCaseId}&action=submit-review`, { jar, body: {} })
check('submit-review -> 200', submitted.status === 200, JSON.stringify(submitted.json))
const reviewId = submitted.json.reviewRequestId

// Verdict authority is the ASSIGNED reviewer (auto-picked: first vp/manager
// that is not the submitter -> the seeded team lead). Login as that user.
const reviewerJar = await login('teamlead@tcms.com', 'Lead@123')
const [v1, v2] = await Promise.all([
  req('POST', `/api/reviews?id=${reviewId}`, { jar: reviewerJar, body: { verdict: 'approved', comment: 'first verdict', flaggedFields: [] } }),
  req('POST', `/api/reviews?id=${reviewId}`, { jar: reviewerJar, body: { verdict: 'failed', comment: 'second verdict', flaggedFields: [] } }),
])
const vStatuses = [v1.status, v2.status].sort()
check('exactly one verdict accepted (one 200, one 409)',
  JSON.stringify(vStatuses) === '[200,409]', `got ${vStatuses}`)

const detail = await req('GET', `/api/reviews?id=${reviewId}`, { jar })
check('review status is completed', detail.json.status === 'completed', detail.json.status)
check('exactly ONE event recorded', (detail.json.events ?? []).length === 1,
  `got ${(detail.json.events ?? []).length}`)

// ---------- cleanup ----------
const del = await req('DELETE', `/api/test-cases?id=${probeId}`, { jar })
check('cleanup: probe case deleted', del.status === 200, JSON.stringify(del.json))

console.log(failures === 0 ? '\nALL CORRUPTION PROBES PASSED' : `\n${failures} PROBE(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
