// B16: end-of-run cleanup for the DoD suites (verify-import, verify-permissions,
// verify-notifications) and verify-concurrency. Deletes only the rows the run itself created, by primary key,
// in one transaction (FK order), then proves residue 0 for those keys.
// Kept on purpose: activity_logs written by the demo accounts (audit trail).
// A module review is deleted only when every case review in it belongs to the run;
// otherwise it is left alone and reported as a FAIL.
import { GuardAbort, openGuardedDb, sqlIn } from './db-guard.mjs'

const pks = (rows, key) => rows.map((r) => String(r[key]))

/** Reads the case reviews hanging off the run's cases and module reviews. */
async function collectReviews(tx, created) {
  const reviews = await tx.$queryRaw`SELECT review_request_id, test_case_id, module_review_id FROM review_requests
    WHERE ${sqlIn('test_case_id', created.cases)} OR ${sqlIn('module_review_id', created.moduleReviews)} FOR UPDATE`
  const foreign = reviews.filter((r) => r.module_review_id && !created.cases.includes(r.test_case_id))
  return { reviewIds: pks(reviews, 'review_request_id'), foreign }
}

function deleteRunNotifications(tx, e, userIds) {
  return tx.$executeRaw`DELETE FROM notifications WHERE
       (entity_type = 'test_case'     AND ${sqlIn('entity_id', e.cases)})
    OR (entity_type = 'review'        AND ${sqlIn('entity_id', e.reviews)})
    OR (entity_type = 'module_review' AND ${sqlIn('entity_id', e.moduleReviews)})
    OR (entity_type = 'bug'           AND ${sqlIn('entity_id', e.bugs)})
    OR (entity_type = 'task_report'   AND ${sqlIn('entity_id', e.taskReports)})
    OR ${sqlIn('user_id', userIds)}`
}

async function deleteRunRows(tx, e, users) {
  const removed = {}
  removed.notifications = await deleteRunNotifications(tx, e, users.ids)
  removed.bugs = await tx.$executeRaw`DELETE FROM bugs WHERE ${sqlIn('bug_id', e.bugs)}`
  removed.test_cases = await tx.$executeRaw`DELETE FROM test_cases WHERE ${sqlIn('test_case_id', e.cases)}`
  removed.module_review_requests = await tx.$executeRaw`DELETE FROM module_review_requests
    WHERE ${sqlIn('module_review_request_id', e.moduleReviews)}`
  removed.modules = await tx.$executeRaw`DELETE FROM modules WHERE ${sqlIn('module_id', e.modules)}`
  removed.task_reports = await tx.$executeRaw`DELETE FROM task_reports WHERE ${sqlIn('task_report_id', e.taskReports)}`
  removed.refresh_tokens = await tx.$executeRaw`DELETE FROM refresh_tokens WHERE ${sqlIn('user_id', users.ids)}`
  removed.login_attempts = await tx.$executeRaw`DELETE FROM login_attempts WHERE ${sqlIn('email', users.emails)}`
  removed.activity_logs = await tx.$executeRaw`DELETE FROM activity_logs WHERE ${sqlIn('user_id', users.ids)}`
  removed.users = await tx.$executeRaw`DELETE FROM users WHERE ${sqlIn('user_id', users.ids)}`
  return removed
}

async function countLeft(tx, e, users) {
  const n = async (sql) => Number((await sql)[0].n)
  return {
    test_cases: await n(tx.$queryRaw`SELECT COUNT(*) AS n FROM test_cases WHERE ${sqlIn('test_case_id', e.cases)}`),
    review_requests: await n(tx.$queryRaw`SELECT COUNT(*) AS n FROM review_requests WHERE ${sqlIn('review_request_id', e.reviews)}`),
    module_review_requests: await n(tx.$queryRaw`SELECT COUNT(*) AS n FROM module_review_requests WHERE ${sqlIn('module_review_request_id', e.moduleReviews)}`),
    bugs: await n(tx.$queryRaw`SELECT COUNT(*) AS n FROM bugs WHERE ${sqlIn('bug_id', e.bugs)}`),
    modules: await n(tx.$queryRaw`SELECT COUNT(*) AS n FROM modules WHERE ${sqlIn('module_id', e.modules)}`),
    task_reports: await n(tx.$queryRaw`SELECT COUNT(*) AS n FROM task_reports WHERE ${sqlIn('task_report_id', e.taskReports)}`),
    users: await n(tx.$queryRaw`SELECT COUNT(*) AS n FROM users WHERE ${sqlIn('user_id', users.ids)}`),
  }
}

/**
 * @param {(name: string, cond: boolean, detail?: string) => void} check  the suite's PASS/FAIL counter
 * @param {{ cases?: string[], bugs?: string[], moduleReviews?: string[], modules?: string[], taskReports?: string[] }} created
 *   ids from API responses
 *   (modules: leaf modules the run created; their cases and bugs must be in the lists too)
 * @param {{ userIds?: string[], emails?: string[] }} [tempUsers]  fixture users the run registered
 */
export async function cleanupRunEntities(check, created, tempUsers = {}) {
  const e = {
    cases: created.cases ?? [],
    bugs: created.bugs ?? [],
    moduleReviews: created.moduleReviews ?? [],
    modules: created.modules ?? [],
    taskReports: created.taskReports ?? [],
    reviews: [],
  }
  const users = { ids: tempUsers.userIds ?? [], emails: tempUsers.emails ?? [] }
  let guard
  try {
    guard = await openGuardedDb()
  } catch (err) {
    check(`cleanup: DB guard (${err instanceof GuardAbort ? err.message : err.code ?? err.name})`, false)
    return
  }
  try {
    guard.setBusy(true)
    await guard.db.$transaction(async (tx) => {
      const { reviewIds, foreign } = await collectReviews(tx, e)
      e.reviews = reviewIds
      check('cleanup: module reviews hold only this run\'s cases', foreign.length === 0,
        foreign.map((r) => `${r.module_review_id}/${r.test_case_id}`).join(','))
      if (foreign.length) e.moduleReviews = e.moduleReviews.filter((id) => !foreign.some((r) => r.module_review_id === id))
      const removed = await deleteRunRows(tx, e, users)
      console.log(`CLEANUP removed ${Object.entries(removed).map(([t, n]) => `${t}=${n}`).join(' ')}`)
      const left = await countLeft(tx, e, users)
      check('cleanup: residue 0 for every row this run created', Object.values(left).every((n) => n === 0), JSON.stringify(left))
    }, { maxWait: 10_000, timeout: 60_000 })
  } catch (err) {
    check(`cleanup: transaction failed, rolled back (${err.code ?? err.name})`, false)
  } finally {
    guard.setBusy(false)
    await guard.release()
  }
}
