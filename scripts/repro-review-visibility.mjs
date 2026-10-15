// Reproduce the owner's exact scenario (2026-10-09, clarified rule):
//   PERMISSION = VISIBILITY, ASSIGNMENT = VERDICT POWER, FORWARD = RE-ROUTING.
//   A PRODUCT user holding perform_review must SEE every review (list +
//   detail) even when he is NOT the requester/reviewer; he must still be
//   unable to VERDICT it until it is assigned to him — and the forward
//   endpoint (any permission holder, any open review, incl. to himself) is
//   the sanctioned way to get it assigned.
// Creates throwaway repro-* users, a module + test case, one dev->QA review,
// then audits every reviews/module-reviews read path AS PRODUCT and AS DEV.
// Cleanup removes everything it created.
import { readFileSync } from 'node:fs'
import bcrypt from 'bcryptjs'
import { PrismaClient } from '@prisma/client'

const BASE = 'http://localhost:3000'
const db = new PrismaClient()
let failed = 0
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok' : 'FAIL'}  ${msg}`); if (!cond) failed++ }

const STAMP = Date.now()
const DEV = { email: `repro-dev-${STAMP}@tcms.test`, name: 'Repro Dev', password: 'Repro@12345', role: 'developer' }
const QA  = { email: `repro-qa-${STAMP}@tcms.test`,  name: 'Repro QA',  password: 'Repro@12345', role: 'qa_engineer' }
const QA2 = { email: `repro-qa2-${STAMP}@tcms.test`, name: 'Repro QA2', password: 'Repro@12345', role: 'qa_engineer' }
const PROD = { email: `repro-prod-${STAMP}@tcms.test`, name: 'Repro Prod', password: 'Repro@12345', role: 'product' }

for (const u of [DEV, QA, QA2, PROD]) {
  await db.user.create({ data: { email: u.email, fullName: u.name, passwordHash: await bcrypt.hash(u.password, 10), role: u.role, isActive: true } })
}

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth?path=login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms', Origin: BASE },
    body: JSON.stringify({ email, password }),
  })
  if (res.status !== 200) throw new Error(`login ${email} -> ${res.status}: ${await res.text()}`)
  const pair = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('tcms-access='))
  return pair ? pair.split(';')[0] : ''
}
const H = (jar) => ({ Cookie: jar, 'X-Requested-With': 'tcms', Origin: BASE, 'Content-Type': 'application/json' })

// Dev needs create_test_case etc.; QA/QA2 need perform_review to open details
// and act (the owner grants it via the matrix in real use). Idempotent upsert.
for (const [role, action] of [
  ['developer', 'create_module'], ['developer', 'create_test_case'], ['developer', 'edit_own_test_case'], ['developer', 'submit_review'], ['developer', 'perform_review'],
  ['qa_engineer', 'perform_review'],
]) {
  await db.$queryRaw`INSERT INTO role_permissions (role, action, enabled, updated_at)
    VALUES (${role}, ${action}, true, NOW())
    ON CONFLICT (role, action) DO UPDATE SET enabled = true, updated_at = NOW()`
}
await new Promise((r) => setTimeout(r, 3500)) // outlive the 3s permission-cache TTL

const devJar = await login(DEV.email, DEV.password)
const qaJar = await login(QA.email, QA.password)
const prodJar = await login(PROD.email, PROD.password)

// --- dev creates module + test case, submits review to QA ---
const modRes = await fetch(`${BASE}/api/modules`, { method: 'POST', headers: H(devJar), body: JSON.stringify({ name: `Repro module ${STAMP}`, description: 'repro' }) })
const mod = await modRes.json()
ok(modRes.status === 200 || modRes.status === 201, `dev creates module -> ${modRes.status}`)
const moduleId = mod.data?.moduleId ?? mod.moduleId

const tcRes = await fetch(`${BASE}/api/test-cases`, { method: 'POST', headers: H(devJar), body: JSON.stringify({ moduleId, title: `Repro TC ${STAMP}`, description: 'repro case', expectedResult: 'works', priority: 'P2' }) })
const tcJson = await tcRes.json()
ok(tcRes.status === 200 || tcRes.status === 201, `dev creates test case -> ${tcRes.status}`)
const testCaseId = tcJson.data?.testCaseId ?? tcJson.testCaseId

// reviewer id of QA user
const qaUser = await db.user.findUnique({ where: { email: QA.email } })
const srRes = await fetch(`${BASE}/api/test-cases?id=${testCaseId}&action=submit-review`, { method: 'PUT', headers: H(devJar), body: JSON.stringify({ reviewerId: qaUser.userId }) })
const srJson = await srRes.json()
ok(srRes.status === 200 || srRes.status === 201, `dev submits review to QA -> ${srRes.status}`)
const reviewId = srJson.data?.review?.reviewRequestId ?? srJson.data?.reviewRequestId ?? srJson.reviewRequestId
ok(Boolean(reviewId), `review id extracted: ${reviewId ?? 'NONE'}`)
const reviewRow = await db.$queryRaw`SELECT reviewer_id, requester_id, status FROM review_requests WHERE review_request_id = ${reviewId}`
console.log('  ..   review row:', JSON.stringify(reviewRow[0] ?? {}))
console.log('  ..   qa user id:', qaUser.userId)

// --- what PRODUCT sees: PERMISSION = VISIBILITY ---
const prodList = await (await fetch(`${BASE}/api/reviews?pageSize=100`, { headers: H(prodJar) })).json()
const prodListRows = prodList.data ?? []
ok(Array.isArray(prodListRows) && prodListRows.some((r) => (r.reviewRequestId ?? r.review_request_id) === reviewId), `product All-Reviews list contains the review (sees ${prodListRows.length} rows total — permission grants visibility)`)

const prodModAllRes = await fetch(`${BASE}/api/module-reviews?action=all`, { headers: H(prodJar) })
ok(prodModAllRes.status === 200, `product module-reviews?all -> ${prodModAllRes.status} (must be 200)`)

const prodQueue = await (await fetch(`${BASE}/api/reviews?action=queue`, { headers: H(prodJar) })).json()
ok((prodQueue.data ?? []).length === 0, `product queue sees ${(prodQueue.data ?? []).length} rows (must be 0 — queue stays assignment-scoped)`)

const prodModQueue = await (await fetch(`${BASE}/api/module-reviews?action=queue`, { headers: H(prodJar) })).json()
ok((prodModQueue.data ?? []).length === 0, `product module queue sees ${(prodModQueue.data ?? []).length} rows (must be 0)`)

const prodDetail = await fetch(`${BASE}/api/reviews?id=${reviewId}`, { headers: H(prodJar) })
ok(prodDetail.status === 200, `product opens someone else's review detail -> ${prodDetail.status} (must be 200 — visibility)`)

const prodVerdict = await fetch(`${BASE}/api/reviews?id=${reviewId}`, { method: 'POST', headers: H(prodJar), body: JSON.stringify({ verdict: 'approved', flaggedFields: [] }) })
ok(prodVerdict.status === 403, `product verdict on unassigned review -> ${prodVerdict.status} (must be 403 — assignment gates verdicts)`)

// --- sanity: the ASSIGNED QA can see + act; the REQUESTER sees but cannot act ---
const qaQueue = await (await fetch(`${BASE}/api/reviews?action=queue`, { headers: H(qaJar) })).json()
ok((Array.isArray(qaQueue) ? qaQueue : qaQueue.data ?? []).some((r) => (r.reviewRequestId ?? r.review_request_id) === reviewId), 'assigned QA sees the review in their queue')
const qaDetail = await fetch(`${BASE}/api/reviews?id=${reviewId}`, { headers: H(qaJar) })
ok(qaDetail.status === 200, `assigned QA opens review detail -> ${qaDetail.status}`)
if (qaDetail.status !== 200) console.log('  ..   qa detail body:', (await qaDetail.text()).slice(0, 200))
const devList = await (await fetch(`${BASE}/api/reviews?pageSize=100`, { headers: H(devJar) })).json()
ok((devList.data ?? []).some((r) => (r.reviewRequestId ?? r.review_request_id) === reviewId), 'requester sees their own raised review (All Reviews tab)')

// --- FORWARD flow (owner rule: permission = power to re-route any open
//     review; forwarding to yourself is how it gets assigned to you) ---
const devUserId = (await db.user.findUnique({ where: { email: DEV.email } })).userId
const prodUserId = (await db.user.findUnique({ where: { email: PROD.email } })).userId

const bogusForward = await fetch(`${BASE}/api/reviews?id=${reviewId}&action=forward`, { method: 'POST', headers: H(prodJar), body: JSON.stringify({ reviewerId: '00000000-0000-0000-0000-000000000000' }) })
ok(bogusForward.status === 400, `non-participant (product) forward to bogus target -> ${bogusForward.status} (must be 400 — gate passes, target invalid)`)

const devSelfForward = await fetch(`${BASE}/api/reviews?id=${reviewId}&action=forward`, { method: 'POST', headers: H(devJar), body: JSON.stringify({ reviewerId: devUserId }) })
ok(devSelfForward.status === 200, `requester forwards the review to himself (takeover) -> ${devSelfForward.status} (must be 200)`)
const devSelfAgain = await fetch(`${BASE}/api/reviews?id=${reviewId}&action=forward`, { method: 'POST', headers: H(devJar), body: JSON.stringify({ reviewerId: devUserId }) })
ok(devSelfAgain.status === 400, `forward to the current reviewer again -> ${devSelfAgain.status} (must be 400 — no-op)`)

const prodForward = await fetch(`${BASE}/api/reviews?id=${reviewId}&action=forward`, { method: 'POST', headers: H(prodJar), body: JSON.stringify({ reviewerId: (await db.user.findUnique({ where: { email: QA2.email } })).userId }) })
const fwdJson = await prodForward.json()
ok(prodForward.status === 200, `permission holder (product, non-participant) forwards to QA2 -> ${prodForward.status}`)
ok(fwdJson.reviewerId === (await db.user.findUnique({ where: { email: QA2.email } })).userId, `reviewer is now QA2 (${fwdJson.reviewerId ?? 'MISSING'})`)

const qa2Jar = await login(QA2.email, QA2.password)
const qa2Queue = await (await fetch(`${BASE}/api/reviews?action=queue`, { headers: H(qa2Jar) })).json()
ok((Array.isArray(qa2Queue) ? qa2Queue : qa2Queue.data ?? []).some((r) => (r.reviewRequestId ?? r.review_request_id) === reviewId), 'QA2 now sees the forwarded review in their queue')

// notifications: QA2 got a review_assigned notification
const qa2Notifs = await (await fetch(`${BASE}/api/notifications?pageSize=20`, { headers: H(qa2Jar) })).json()
const notifList = Array.isArray(qa2Notifs) ? qa2Notifs : qa2Notifs.data ?? []
ok(Array.isArray(notifList) && notifList.some((n) => n.type === 'review_assigned'), 'QA2 received a review_assigned notification')

// --- takeover completes the owner rule: assigned -> can act ---
const qa2ToProd = await fetch(`${BASE}/api/reviews?id=${reviewId}&action=forward`, { method: 'POST', headers: H(qa2Jar), body: JSON.stringify({ reviewerId: prodUserId }) })
ok(qa2ToProd.status === 200, `assignee QA2 forwards to product -> ${qa2ToProd.status} (must be 200)`)
const prodQueueAfter = await (await fetch(`${BASE}/api/reviews?action=queue`, { headers: H(prodJar) })).json()
ok((Array.isArray(prodQueueAfter) ? prodQueueAfter : prodQueueAfter.data ?? []).some((r) => (r.reviewRequestId ?? r.review_request_id) === reviewId), 'product queue now contains the review (it is assigned to him)')
const prodVerdictAfter = await fetch(`${BASE}/api/reviews?id=${reviewId}`, { method: 'POST', headers: H(prodJar), body: JSON.stringify({ verdict: 'approved', flaggedFields: [] }) })
ok(prodVerdictAfter.status === 200, `product verdict AFTER assignment -> ${prodVerdictAfter.status} (must be 200 — assignment grants verdict power)`)
const fwdCompleted = await fetch(`${BASE}/api/reviews?id=${reviewId}&action=forward`, { method: 'POST', headers: H(prodJar), body: JSON.stringify({ reviewerId: devUserId }) })
ok(fwdCompleted.status === 400, `forward a completed review -> ${fwdCompleted.status} (must be 400)`)

// --- password minimum is 6 (owner request) ---
const weak = await fetch(`${BASE}/api/auth?path=register`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms', Origin: BASE }, body: JSON.stringify({ fullName: 'Pwd Six', email: `pwd6-${STAMP}@tcms.test`, password: 'Ab1', role: 'viewer' }) })
ok(weak.status === 400, `3-char password rejected -> ${weak.status} (must be 400)`)
const six = await fetch(`${BASE}/api/auth?path=register`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms', Origin: BASE }, body: JSON.stringify({ fullName: 'Pwd Six', email: `pwd6-${STAMP}@tcms.test`, password: 'Ab1xyz', role: 'viewer' }) })
ok(six.status === 200, `6-char password accepted -> ${six.status} (must be 200)`)

console.log(failed === 0 ? '\nRESULT: OWNER RULE HOLDS — permission=visibility, assignment=verdict, forward=re-routing' : `\nRESULT: ${failed} CHECK(S) FAILED`)
process.exitCode = failed === 0 ? 0 : 1

// --- cleanup (only when green, so failures stay inspectable) ---
if (failed !== 0) { console.log('cleanup SKIPPED — artifacts left for inspection'); process.exit() }

// --- cleanup ---
try {
  if (testCaseId) await db.$executeRaw`DELETE FROM test_cases WHERE test_case_id = ${testCaseId}`
  if (moduleId) await db.$executeRaw`DELETE FROM modules WHERE module_id = ${moduleId}`
  for (const u of [DEV, QA, QA2, PROD]) await db.user.delete({ where: { email: u.email } })
  await db.user.delete({ where: { email: `pwd6-${STAMP}@tcms.test` } }).catch(() => {})
  await db.$executeRaw`DELETE FROM role_permissions WHERE (role = 'developer' AND action IN ('create_module','create_test_case','edit_own_test_case','submit_review','perform_review')) OR (role = 'qa_engineer' AND action = 'perform_review')`
  console.log('cleanup done')
} catch (e) {
  console.error('cleanup error (repro-* rows may remain):', String(e).slice(0, 200))
} finally {
  await db.$disconnect()
}
