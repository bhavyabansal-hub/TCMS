#!/usr/bin/env node
/**
 * Regression suite for the chaos-test findings of 2026-10-22
 * (docs/qa/CHAOS-FINDINGS-2026-10-22.txt). Every check runs WITHOUT waiting, so a
 * stale cache shows up as a FAIL instead of hiding behind a TTL:
 *   1. deactivate / reactivate / role change take effect on the very next request
 *   2. 24 overlapping toggles of one permission cell -> no 500, matrix = DB
 *   3. a toggle is honoured by another route on the very next request
 *   4. 5 parallel submit-review of one case -> exactly one 200, one open review
 *   5. 3 parallel module submit-review -> exactly one 200, one open review per case
 *   6. deleting a module under review puts its cases back to "draft" (resubmittable)
 *   7. a module review whose last open case review is superseded (resubmit) or
 *      removed (case delete) is completed, not left open forever
 *   8. verdict + bulk verdict + resubmit + case delete + module delete at the same
 *      moment on one module review, 8 rounds -> never a deadlock answer, never 5xx
 * Own stamped fixture users; everything is removed at the end (residue 0).
 * Usage: node scripts/verify-chaos-fixes.mjs   (app on TCMS_BASE_URL, default :3000)
 */
import { GuardAbort, openGuardedDb, sqlIn } from './lib/db-guard.mjs'
import { cleanupFixtureRun } from './lib/fixture-cleanup.mjs'
import { createFixtureUsers, fixtureEmail } from './lib/fixture-users.mjs'
import { BASE, createCounter, jarFromSetCookie } from './lib/suite-harness.mjs'

const stamp = String(Date.now())
const PREFIX = 'chaosfix'
const counter = createCounter()
const check = counter.check
const s = {} // role -> { jar, user }
let baseModule = null // every case / bug needs a module

async function api(who, method, urlPath, body) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: { 'X-Requested-With': 'tcms', Origin: BASE, ...(who ? { Cookie: who.jar } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let json = null
  try { json = await res.json() } catch { /* no body */ }
  return { status: res.status, json }
}

async function login(spec) {
  const res = await fetch(`${BASE}/api/auth?path=login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms', Origin: BASE },
    body: JSON.stringify({ email: spec.email, password: spec.password }),
  })
  if (res.status !== 200) throw new Error(`login failed for fixture ${spec.role} (${res.status})`)
  return { jar: jarFromSetCookie(res.headers.getSetCookie?.() ?? []), user: (await res.json()).user }
}

const caseBody = (title, moduleId = baseModule) => ({ title: `Chaosfix ${title} ${stamp}`, description: 'chaos regression', moduleId })
const bugBody = (title) => ({ title: `Chaosfix ${title} ${stamp}`, description: 'chaos regression', moduleId: baseModule })
const newCase = async (who, moduleId = baseModule) => (await api(who, 'POST', '/api/test-cases', caseBody(`case ${Math.random()}`, moduleId))).json?.testCaseId
const newModule = async (name) => (await api(s.vp, 'POST', '/api/modules', { name: `Chaosfix ${name} ${stamp}` })).json?.moduleId
const count = async (db, q) => Number((await q)[0].n)

async function sessions() {
  const target = s.developer
  // Warm the user cache first: the old bug only showed with a cached entry.
  check('setup: developer can read lists', (await api(target, 'GET', '/api/bugs?pageSize=1')).status === 200)
  const off = await api(s.manager, 'PUT', `/api/users?id=${target.user.userId}`, { isActive: false })
  check('1a manager deactivates developer -> 200', off.status === 200, `${off.status}`)
  const after = await api(target, 'GET', '/api/bugs?pageSize=1')
  check('1b deactivated developer -> 401 on the very next request', after.status === 401, `${after.status}`)
  const write = await api(target, 'POST', '/api/bugs', bugBody('ghost'))
  check('1c deactivated developer cannot create a bug', write.status === 401, `${write.status}`)
  await api(s.manager, 'PUT', `/api/users?id=${target.user.userId}`, { isActive: true })
  check('1d reactivated developer -> 200 at once', (await api(target, 'GET', '/api/bugs?pageSize=1')).status === 200)

  const denied = await api(target, 'POST', '/api/test-cases', caseBody('denied'))
  check('1e developer cannot create a test case (default)', denied.status === 403, `${denied.status}`)
  const promote = await api(s.vp, 'PUT', `/api/users?id=${target.user.userId}`, { role: 'qa_engineer' })
  check('1f VP changes developer -> qa_engineer', promote.status === 200, `${promote.status}`)
  const allowed = await api(target, 'POST', '/api/test-cases', caseBody('promoted'))
  check('1g new role counts on the very next request (create test case 200)', allowed.status === 200, `${allowed.status}`)
  await api(s.vp, 'PUT', `/api/users?id=${target.user.userId}`, { role: 'developer' })
  const again = await api(target, 'POST', '/api/test-cases', caseBody('demoted'))
  check('1h role back to developer -> 403 on the very next request', again.status === 403, `${again.status}`)

  const mgr = s.manager
  await api(s.vp, 'PUT', `/api/users?id=${mgr.user.userId}`, { role: 'viewer' })
  const delCase = await newCase(s.qa_engineer)
  const del = await api(mgr, 'DELETE', `/api/test-cases?id=${delCase}`)
  check('1i manager demoted to viewer cannot delete a test case', del.status === 403, `${del.status}`)
  await api(s.vp, 'PUT', `/api/users?id=${mgr.user.userId}`, { role: 'manager' })
}

async function toggles(db) {
  const cell = { role: 'viewer', action: 'create_bug' }
  const rs = await Promise.all(Array.from({ length: 24 }, (_, k) => api(s.vp, 'PUT', '/api/permissions', { ...cell, enabled: k % 2 === 0 })))
  const codes = [...new Set(rs.map((r) => r.status))].join(',')
  check('2a 24 overlapping toggles of one cell -> all 200 (no 500)', rs.every((r) => r.status === 200), codes)
  const matrix = await api(s.vp, 'GET', '/api/permissions')
  const shown = matrix.json?.find((c) => c.role === cell.role && c.action === cell.action)
  const rows = await db.$queryRaw`SELECT enabled FROM role_permissions WHERE role = ${cell.role} AND action = ${cell.action}`
  const dbValue = rows.length ? Boolean(Number(rows[0].enabled)) : false // no row = default (off for viewer)
  check('2b matrix after the storm equals the database', shown && shown.enabled === dbValue, `matrix=${shown?.enabled} db=${dbValue} rows=${rows.length}`)
  await api(s.vp, 'PUT', '/api/permissions', { ...cell, enabled: false })
  check('2c back to default leaves no override row', (await count(db, db.$queryRaw`SELECT COUNT(*) AS n FROM role_permissions`)) === 0)

  // 3: another route honours the toggle on the very next request (shared cache).
  const off = await api(s.vp, 'PUT', '/api/permissions', { role: 'developer', action: 'create_bug', enabled: false })
  check('3a VP turns developer create_bug OFF', off.status === 200, `${off.status}`)
  const bug = await api(s.developer, 'POST', '/api/bugs', bugBody('blocked'))
  check('3b developer create bug -> 403 on the very next request', bug.status === 403, `${bug.status}`)
  const qa = await api(s.qa_engineer, 'POST', '/api/bugs', bugBody('qa bug'))
  check('3c other cells keep their value meanwhile (qa create bug 200)', qa.status === 200, `${qa.status}`)
  await api(s.vp, 'PUT', '/api/permissions', { role: 'developer', action: 'create_bug', enabled: true })
  const back = await api(s.developer, 'POST', '/api/bugs', bugBody('allowed'))
  check('3d developer create bug -> 200 right after ON', back.status === 200, `${back.status}`)
}

async function caseSubmits(db) {
  const id = await newCase(s.qa_engineer)
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => api(s.qa_engineer, 'PUT', `/api/test-cases?id=${id}&action=submit-review`, { reviewerId: s.manager.user.userId })))
  const ok = rs.filter((r) => r.status === 200).length
  check('4a 5 parallel submit-review -> exactly one 200', ok === 1, rs.map((r) => r.status).join(','))
  check('4b the others are refused (400/409), never 500', rs.every((r) => [200, 400, 409].includes(r.status)), rs.map((r) => r.status).join(','))
  const open = await count(db, db.$queryRaw`SELECT COUNT(*) AS n FROM review_requests WHERE test_case_id = ${id} AND status IN ('pending','in_progress')`)
  check('4c exactly one open review in the database', open === 1, `open=${open}`)
}

async function moduleSubmits(db) {
  const mod = await newModule('parallel')
  const ids = [await newCase(s.product, mod), await newCase(s.product, mod), await newCase(s.product, mod)]
  const rs = await Promise.all([1, 2, 3].map(() => api(s.product, 'PUT', `/api/modules?id=${mod}&action=submit-review`, { reviewerId: s.manager.user.userId })))
  const ok = rs.filter((r) => r.status === 200).length
  check('5a 3 parallel module submit-review -> exactly one 200', ok === 1, rs.map((r) => r.status).join(','))
  check('5b the others answer 400, never 500', rs.every((r) => [200, 400, 409].includes(r.status)), rs.map((r) => r.status).join(','))
  const multi = await db.$queryRaw`SELECT test_case_id FROM review_requests WHERE ${sqlIn('test_case_id', ids)} AND status IN ('pending','in_progress') GROUP BY test_case_id HAVING COUNT(*) > 1`
  check('5c no case has two open reviews', multi.length === 0, multi.map((r) => r.test_case_id).join(','))
  const single = await api(s.product, 'PUT', `/api/test-cases?id=${ids[0]}&action=submit-review`, { reviewerId: s.vp.user.userId })
  check('5d single submit of a case already in the module review -> 400', single.status === 400, `${single.status}`)
}

async function moduleDelete(db) {
  const mod = await newModule('doomed')
  const ids = [await newCase(s.qa_engineer, mod), await newCase(s.qa_engineer, mod)]
  const sub = await api(s.qa_engineer, 'PUT', `/api/modules?id=${mod}&action=submit-review`, { reviewerId: s.manager.user.userId })
  check('6a module sent for review', sub.status === 200, `${sub.status}`)
  const del = await api(s.vp, 'DELETE', `/api/modules?id=${mod}`)
  check('6b VP deletes the module under review -> 200', del.status === 200, `${del.status}`)
  const statuses = (await db.$queryRaw`SELECT status FROM test_cases WHERE ${sqlIn('test_case_id', ids)}`).map((r) => r.status)
  check('6c its cases are back to "draft" (not stuck in review)', statuses.length === 2 && statuses.every((x) => x === 'draft'), statuses.join(','))
  const again = await api(s.qa_engineer, 'PUT', `/api/test-cases?id=${ids[0]}&action=submit-review`, { reviewerId: s.manager.user.userId })
  check('6d such a case can be submitted again -> 200', again.status === 200, `${again.status}`)
}

async function emptyModuleReviews(db) {
  const mrStatus = async (id) => (await db.$queryRaw`SELECT status FROM module_review_requests WHERE module_review_request_id = ${id}`)[0]?.status
  const mod = await newModule('superseded')
  const ids = [await newCase(s.qa_engineer, mod), await newCase(s.qa_engineer, mod)]
  const sub = await api(s.qa_engineer, 'PUT', `/api/modules?id=${mod}&action=submit-review`, { reviewerId: s.manager.user.userId })
  const mr = sub.json?.moduleReview?.moduleReviewRequestId
  check('7a module review raised', !!mr, `${sub.status}`)
  const verdict = await api(s.manager, 'POST', `/api/module-reviews?id=${mr}&action=bulk-verdict`, { verdict: 'needs_revision', comment: 'fix both' })
  check('7b bulk needs_revision -> 200', verdict.status === 200, `${verdict.status}`)
  for (const id of ids) await api(s.qa_engineer, 'PUT', `/api/test-cases?id=${id}&action=submit-review`, { reviewerId: s.manager.user.userId })
  check('7c both cases resubmitted one by one -> old module review completed', (await mrStatus(mr)) === 'completed', String(await mrStatus(mr)))

  const mod2 = await newModule('emptied')
  const only = await newCase(s.qa_engineer, mod2)
  const sub2 = await api(s.qa_engineer, 'PUT', `/api/modules?id=${mod2}&action=submit-review`, { reviewerId: s.manager.user.userId })
  const mr2 = sub2.json?.moduleReview?.moduleReviewRequestId
  const del = await api(s.qa_engineer, 'DELETE', `/api/test-cases?id=${only}`)
  check('7d author deletes the only case under module review -> 200', del.status === 200, `${del.status}`)
  check('7e that module review is completed (not open with nothing inside)', (await mrStatus(mr2)) === 'completed', String(await mrStatus(mr2)))
}

const DEADLOCK = 'Someone else is saving the same item right now'

async function lockOrder() {
  const statuses = []
  for (let round = 0; round < 8; round++) {
    const mod = await newModule(`race${round}`)
    const ids = [await newCase(s.qa_engineer, mod), await newCase(s.qa_engineer, mod), await newCase(s.qa_engineer, mod)]
    const sub = await api(s.qa_engineer, 'PUT', `/api/modules?id=${mod}&action=submit-review`, { reviewerId: s.manager.user.userId })
    const mr = sub.json?.moduleReview?.moduleReviewRequestId
    const first = (await api(s.manager, 'GET', `/api/module-reviews?id=${mr}`)).json?.caseReviews?.[0]?.reviewRequestId
    // needs_revision on one case first, so a resubmit of it is allowed during the race
    if (first) await api(s.manager, 'POST', `/api/reviews?id=${first}`, { verdict: 'needs_revision', comment: 'x', flaggedFields: ['title'] })
    const second = (await api(s.manager, 'GET', `/api/module-reviews?id=${mr}`)).json?.caseReviews?.find((c) => c.status !== 'completed' && c.reviewRequestId !== first)?.reviewRequestId
    const rs = await Promise.all([
      api(s.manager, 'POST', `/api/module-reviews?id=${mr}&action=bulk-verdict`, { verdict: 'approved' }),
      second ? api(s.manager, 'POST', `/api/reviews?id=${second}`, { verdict: 'approved' }) : Promise.resolve({ status: 0 }),
      api(s.qa_engineer, 'PUT', `/api/test-cases?id=${ids[0]}&action=submit-review`, { reviewerId: s.vp.user.userId }),
      api(s.qa_engineer, 'DELETE', `/api/test-cases?id=${ids[2]}`),
      round % 2 ? api(s.vp, 'DELETE', `/api/modules?id=${mod}`) : api(s.qa_engineer, 'PUT', `/api/modules?id=${mod}&action=submit-review`, { reviewerId: s.product.user.userId }),
    ])
    statuses.push(...rs)
  }
  const deadlocks = statuses.filter((r) => String(r.json?.error ?? '').startsWith(DEADLOCK)).length
  const errors = statuses.filter((r) => r.status >= 500).length
  check('8a 8 rounds of 5 parallel review writes -> no deadlock answer', deadlocks === 0, `deadlocks=${deadlocks}`)
  check('8b ... and no 5xx', errors === 0, `5xx=${errors}`)
}

async function main() {
  let guard
  try {
    guard = await openGuardedDb()
  } catch (err) {
    console.log(`NOT RUN: ${err instanceof GuardAbort ? err.message : err.message}`)
    process.exitCode = 2
    return
  }
  const { db } = guard
  let fixtures = []
  try {
    const pre = await count(db, db.$queryRaw`SELECT COUNT(*) AS n FROM role_permissions`)
    if (pre !== 0) {
      console.log(`NOT RUN: role_permissions has ${pre} override row(s); this suite resets it to 0`)
      process.exitCode = 2
      return
    }
    const roles = ['vp', 'manager', 'product', 'developer', 'qa_engineer']
    fixtures = await createFixtureUsers(db, roles.map((role) => ({ key: role, role, email: fixtureEmail(PREFIX, role, stamp), name: `Chaosfix ${role}` })))
    for (const f of fixtures) s[f.role] = await login(f)
    baseModule = await newModule('base')
    check('setup: base module', !!baseModule)
    await sessions()
    await toggles(db)
    await caseSubmits(db)
    await moduleSubmits(db)
    await moduleDelete(db)
    await emptyModuleReviews(db)
    await lockOrder()
  } catch (err) {
    check(`suite aborted: ${err.message}`, false)
  } finally {
    if (fixtures.length) {
      try {
        const report = await cleanupFixtureRun(db, fixtures, { prefix: PREFIX, stamp })
        check('cleanup: residue 0', Object.values(report.residue).every((n) => n === 0), JSON.stringify(report.residue))
      } catch (err) {
        check(`cleanup failed (stamp ${stamp})`, false, err.message)
      }
    }
    await guard.release()
  }
  console.log(`\nCHAOS-FIXES RESULT: ${counter.pass} passed, ${counter.fail} failed`)
  process.exitCode = counter.fail ? 1 : 0
}

main()
