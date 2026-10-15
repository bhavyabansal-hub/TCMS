// Verify the 2026-10-09 review-UX + test-case round:
//   1. bulk verdict on module reviews: approve-all / FAIL-ALL / NEEDS-REVISION-ALL
//      (proper comment required for fail & needs-revision; atomic; notifications
//      to case authors AND the requester)
//   2. change-reviewer on module reviews (permission holder reassigns module +
//      its open case reviews to any TCMS user, incl. self-takeover)
//   3. bulk delete of test cases (any selection; author-or-delete-right rule;
//      permanent cascade delete)
//   4. single verdict still notifies the requester as well
// Creates throwaway users + a module + cases, cleans everything up on green.
import bcrypt from 'bcryptjs'
import { PrismaClient } from '@prisma/client'

const BASE = 'http://localhost:3000'
const db = new PrismaClient()
let failed = 0
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok' : 'FAIL'}  ${msg}`); if (!cond) failed++ }

const STAMP = Date.now()
const DEV  = { email: `ux-dev-${STAMP}@tcms.test`,  name: 'UX Dev',  password: 'Ux@123456', role: 'developer' }
const QA   = { email: `ux-qa-${STAMP}@tcms.test`,   name: 'UX QA',   password: 'Ux@123456', role: 'qa_engineer' }
const QA2  = { email: `ux-qa2-${STAMP}@tcms.test`,  name: 'UX QA2',  password: 'Ux@123456', role: 'qa_engineer' }
const PROD = { email: `ux-prod-${STAMP}@tcms.test`, name: 'UX Prod', password: 'Ux@123456', role: 'product' }

for (const u of [DEV, QA, QA2, PROD]) {
  await db.user.create({ data: { email: u.email, fullName: u.name, passwordHash: await bcrypt.hash(u.password, 10), role: u.role, isActive: true } })
}
// QA needs perform_review to act (the owner grants it via the matrix in real use).
for (const [role, action] of [['qa_engineer', 'perform_review'], ['developer', 'create_module'], ['developer', 'create_test_case'], ['developer', 'edit_own_test_case'], ['developer', 'submit_review']]) {
  await db.$queryRaw`INSERT INTO role_permissions (role, action, enabled, updated_at)
    VALUES (${role}, ${action}, true, NOW())
    ON CONFLICT (role, action) DO UPDATE SET enabled = true, updated_at = NOW()`
}
await new Promise((r) => setTimeout(r, 3500)) // outlive the 3s permission-cache TTL

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
const J = async (res) => { const t = await res.text(); try { return JSON.parse(t) } catch { return { raw: t.slice(0, 120) } } }

const devJar = await login(DEV.email, DEV.password)
const qaJar = await login(QA.email, QA.password)
const prodJar = await login(PROD.email, PROD.password)

// --- dev: module + 4 cases ---
const mod = await J(await fetch(`${BASE}/api/modules`, { method: 'POST', headers: H(devJar), body: JSON.stringify({ name: `UX module ${STAMP}`, description: 'ux' }) }))
const moduleId = mod.data?.moduleId ?? mod.moduleId
ok(Boolean(moduleId), `module created (${moduleId ?? 'NONE'})`)

const caseIds = []
for (let i = 1; i <= 4; i++) {
  const tc = await J(await fetch(`${BASE}/api/test-cases`, { method: 'POST', headers: H(devJar), body: JSON.stringify({ moduleId, title: `UX case ${i} ${STAMP}`, description: 'ux case', expectedResult: 'works', priority: 'P2' }) }))
  const id = tc.data?.testCaseId ?? tc.testCaseId
  if (id) caseIds.push(id)
}
ok(caseIds.length === 4, `4 test cases created (${caseIds.length})`)

// --- module review R1: dev -> QA (4 case reviews) ---
const qaUser = await db.user.findUnique({ where: { email: QA.email } })
const sr = await J(await fetch(`${BASE}/api/modules?id=${moduleId}&action=submit-review`, { method: 'PUT', headers: H(devJar), body: JSON.stringify({ reviewerId: qaUser.userId }) }))
const r1 = sr.data?.moduleReview?.moduleReviewRequestId ?? sr.moduleReview?.moduleReviewRequestId
ok(sr.data?.caseReviewCount === 4 || sr.caseReviewCount === 4, `module review R1 raised with 4 case reviews`)
ok(Boolean(r1), `module review id ${r1 ?? 'NONE'}`)

// --- 1a. BULK FAIL-ALL with comment (proper-msg rule) ---
const qa2User = await db.user.findUnique({ where: { email: QA2.email } })
const prodUser = await db.user.findUnique({ where: { email: PROD.email } })

const failNoComment = await fetch(`${BASE}/api/module-reviews?id=${r1}&action=bulk-verdict`, { method: 'POST', headers: H(qaJar), body: JSON.stringify({ verdict: 'failed' }) })
ok(failNoComment.status === 400, `fail-all without comment -> ${failNoComment.status} (must be 400 — "a proper msg there is to write")`)

const failAll = await J(await fetch(`${BASE}/api/module-reviews?id=${r1}&action=bulk-verdict`, { method: 'POST', headers: H(qaJar), body: JSON.stringify({ verdict: 'failed', comment: 'Steps are ambiguous across the board' }) }))
ok(failAll.affectedCount === 4 && failAll.moduleReviewStatus === 'completed', `fail-all recorded on 4 cases, module completed (${JSON.stringify({ a: failAll.affectedCount, s: failAll.moduleReviewStatus })})`)

const r1rows = await db.$queryRaw`SELECT status FROM review_requests WHERE module_review_id = ${r1}`
ok(r1rows.length === 4 && r1rows.every((r) => r.status === 'completed'), `all 4 case reviews of R1 completed in DB`)
const caseStates = await db.$queryRaw`SELECT status FROM test_cases WHERE test_case_id = ANY(${caseIds}::text[])`
ok(caseStates.every((c) => c.status === 'needs_revision'), `all 4 test cases moved to needs_revision`)

const devNotifs = await J(await fetch(`${BASE}/api/notifications?pageSize=50`, { headers: H(devJar) }))
const devList = Array.isArray(devNotifs) ? devNotifs : devNotifs.data ?? []
ok(devList.some((n) => n.type === 'review_failed' && n.body.includes('failed')), 'author/requester (dev) received the fail notification')

const bulkAgain = await fetch(`${BASE}/api/module-reviews?id=${r1}&action=bulk-verdict`, { method: 'POST', headers: H(qaJar), body: JSON.stringify({ verdict: 'approved' }) })
ok(bulkAgain.status === 400, `bulk verdict on completed module review -> ${bulkAgain.status} (must be 400)`)

// --- 2. module review R2 (cases are needs_revision -> eligible again) ---
const sr2 = await J(await fetch(`${BASE}/api/modules?id=${moduleId}&action=submit-review`, { method: 'PUT', headers: H(devJar), body: JSON.stringify({ reviewerId: qaUser.userId }) }))
const r2 = sr2.data?.moduleReview?.moduleReviewRequestId ?? sr2.moduleReview?.moduleReviewRequestId
ok(Boolean(r2), `module review R2 raised (cycle 2)`)

// Non-assignee permission holder cannot bulk-verdict (assignment rule)...
const prodBulk = await fetch(`${BASE}/api/module-reviews?id=${r2}&action=bulk-verdict`, { method: 'POST', headers: H(prodJar), body: JSON.stringify({ verdict: 'approved' }) })
ok(prodBulk.status === 403, `non-assigned product bulk-verdict -> ${prodBulk.status} (must be 403)`)

// ...but CAN change the reviewer (owner rule): R2 + open cases go to QA2.
const chg = await J(await fetch(`${BASE}/api/module-reviews?id=${r2}&action=change-reviewer`, { method: 'POST', headers: H(prodJar), body: JSON.stringify({ reviewerId: qa2User.userId }) }))
ok(Boolean(chg.data?.moduleReviewRequestId ?? chg.moduleReviewRequestId), `product (non-participant) changed reviewer -> QA2`)
const r2row = await db.$queryRaw`SELECT reviewer_id FROM module_review_requests WHERE module_review_request_id = ${r2}`
ok(r2row[0]?.reviewer_id === qa2User.userId, `module review reviewer is now QA2`)
const r2cases = await db.$queryRaw`SELECT reviewer_id, status FROM review_requests WHERE module_review_id = ${r2}`
ok(r2cases.every((c) => c.reviewer_id === qa2User.userId), `all ${r2cases.length} open case reviews reassigned to QA2`)

const chgSelf = await fetch(`${BASE}/api/module-reviews?id=${r2}&action=change-reviewer`, { method: 'POST', headers: H(prodJar), body: JSON.stringify({ reviewerId: qa2User.userId }) })
ok(chgSelf.status === 400, `change-reviewer to the current reviewer -> ${chgSelf.status} (must be 400 no-op)`)

const qa2Jar = await login(QA2.email, QA2.password)
const qa2Notifs = await J(await fetch(`${BASE}/api/notifications?pageSize=20`, { headers: H(qa2Jar) }))
const qa2List = Array.isArray(qa2Notifs) ? qa2Notifs : qa2Notifs.data ?? []
ok(qa2List.some((n) => n.type === 'review_assigned'), 'QA2 notified about the assignment')

// --- 1b. bulk NEEDS-REVISION-ALL keeps the module open; then bulk approve closes it ---
const nr = await J(await fetch(`${BASE}/api/module-reviews?id=${r2}&action=bulk-verdict`, { method: 'POST', headers: H(qa2Jar), body: JSON.stringify({ verdict: 'needs_revision', comment: 'Please tighten the preconditions' }) }))
ok(nr.affectedCount === 4 && nr.moduleReviewStatus === 'in_progress', `needs-revision-all on 4 cases, module stays open (${JSON.stringify({ a: nr.affectedCount, s: nr.moduleReviewStatus })})`)
const appr = await J(await fetch(`${BASE}/api/module-reviews?id=${r2}&action=bulk-verdict`, { method: 'POST', headers: H(qa2Jar), body: JSON.stringify({ verdict: 'approved' }) }))
ok(appr.affectedCount === 4 && appr.moduleReviewStatus === 'completed', `approve-all then closes the module review`)
const finalStates = await db.$queryRaw`SELECT status FROM test_cases WHERE test_case_id = ANY(${caseIds}::text[])`
ok(finalStates.every((c) => c.status === 'approved'), `all 4 test cases approved after the approve-all`)

// --- 3. BULK DELETE test cases ---
const delTwo = await J(await fetch(`${BASE}/api/test-cases?action=bulk-delete`, { method: 'DELETE', headers: H(devJar), body: JSON.stringify({ ids: caseIds.slice(0, 2) }) }))
ok(delTwo.deleted === 2 && Array.isArray(delTwo.missing), `author bulk-deleted 2 of his own cases (${JSON.stringify(delTwo)})`)
const gone = await fetch(`${BASE}/api/test-cases?id=${caseIds[0]}`, { headers: H(devJar) })
ok(gone.status === 404, `deleted case is gone (404)`)
const remaining = await db.$queryRaw`SELECT COUNT(*)::int AS n FROM test_cases WHERE test_case_id = ANY(${caseIds}::text[])`
ok(remaining[0].n === 2, `exactly 2 of the 4 cases remain`)

// QA2's own case cannot be bulk-deleted by dev (no delete rights, not author)
const qa2tc = await J(await fetch(`${BASE}/api/test-cases`, { method: 'POST', headers: H(qa2Jar), body: JSON.stringify({ moduleId, title: `UX qa2 case ${STAMP}`, description: 'x', priority: 'P3' }) }))
const qa2tcId = qa2tc.data?.testCaseId ?? qa2tc.testCaseId
const forbidden = await fetch(`${BASE}/api/test-cases?action=bulk-delete`, { method: 'DELETE', headers: H(devJar), body: JSON.stringify({ ids: [qa2tcId] }) })
ok(forbidden.status === 403, `dev deleting someone else's case -> ${forbidden.status} (must be 403)`)
const empty = await fetch(`${BASE}/api/test-cases?action=bulk-delete`, { method: 'DELETE', headers: H(devJar), body: JSON.stringify({ ids: [] }) })
ok(empty.status === 400, `bulk delete with no ids -> ${empty.status} (must be 400)`)

// --- 4. single verdict notifies the REQUESTER when they differ from the author ---
// QA2 (submit_review) submits DEV's case to QA: requester=QA2, author=dev.
const sr3 = await J(await fetch(`${BASE}/api/test-cases?id=${caseIds[3]}&action=submit-review`, { method: 'PUT', headers: H(qa2Jar), body: JSON.stringify({ reviewerId: qaUser.userId }) }))
const singleId = sr3.data?.review?.reviewRequestId ?? sr3.data?.reviewRequestId ?? sr3.reviewRequestId
ok(Boolean(singleId), `single review raised (requester QA2 != author dev)`)
const single = await fetch(`${BASE}/api/reviews?id=${singleId}`, { method: 'POST', headers: H(qaJar), body: JSON.stringify({ verdict: 'needs_revision', comment: 'Tighten step 2' }) })
ok(single.status === 200, `single verdict by the assigned reviewer -> ${single.status}`)
const qa2Notifs2 = await J(await fetch(`${BASE}/api/notifications?pageSize=50`, { headers: H(qa2Jar) }))
const qa2List2 = Array.isArray(qa2Notifs2) ? qa2Notifs2 : qa2Notifs2.data ?? []
ok(qa2List2.some((n) => n.type === 'review_needs_revision' && n.body.includes('you sent for review')), 'requester (QA2) received the single-verdict notification')

console.log(failed === 0 ? '\nRESULT: ALL REVIEW-UX + BULK-DELETE CHECKS GREEN' : `\nRESULT: ${failed} CHECK(S) FAILED`)
process.exitCode = failed === 0 ? 0 : 1

if (failed !== 0) { console.log('cleanup SKIPPED — artifacts left for inspection'); await db.$disconnect(); process.exit() }

// --- cleanup ---
try {
  await db.$executeRaw`DELETE FROM review_events WHERE review_request_id IN (SELECT review_request_id FROM review_requests WHERE test_case_id = ANY(${caseIds}::text[]) OR test_case_id = ${qa2tcId})`
  await db.$executeRaw`DELETE FROM review_requests WHERE test_case_id = ANY(${caseIds}::text[]) OR test_case_id = ${qa2tcId}`
  await db.$executeRaw`DELETE FROM module_review_requests WHERE module_id = ${moduleId}`
  await db.$executeRaw`DELETE FROM test_case_history WHERE test_case_id = ANY(${caseIds}::text[]) OR test_case_id = ${qa2tcId}`
  await db.$executeRaw`DELETE FROM test_cases WHERE module_id = ${moduleId}`
  await db.$executeRaw`DELETE FROM modules WHERE module_id = ${moduleId}`
  const uids = [DEV, QA, QA2, PROD].map((u) => u.email)
  await db.$executeRaw`DELETE FROM notifications WHERE user_id IN (SELECT user_id FROM users WHERE email = ANY(${uids}::text[]))`
  await db.$executeRaw`DELETE FROM activity_logs WHERE user_id IN (SELECT user_id FROM users WHERE email = ANY(${uids}::text[]))`
  for (const u of [DEV, QA, QA2, PROD]) await db.user.delete({ where: { email: u.email } })
  await db.$executeRaw`DELETE FROM role_permissions WHERE (role = 'qa_engineer' AND action = 'perform_review') OR (role = 'developer' AND action IN ('create_module','create_test_case','edit_own_test_case','submit_review'))`
  console.log('cleanup done')
} catch (e) {
  console.error('cleanup error:', String(e).slice(0, 300))
} finally {
  await db.$disconnect()
}
