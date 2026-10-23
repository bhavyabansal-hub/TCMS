// Cleanup for runs that work only through stamped fixture users (chaos-live-users,
// verify-chaos-fixes): deletes every row those users created or that hangs off them,
// in one transaction (FK order), resets role_permissions to 0 rows (callers check
// the precondition "0 rows" before they start), then counts what is left by stamp.
import { sqlIn } from './db-guard.mjs'

/**
 * @param {import('@prisma/client').PrismaClient} db guarded client
 * @param {{ userId: string, email: string }[]} fixtures
 * @param {{ prefix: string, stamp: string }} run  fixture e-mail prefix + stamp (titles carry the stamp)
 */
export async function cleanupFixtureRun(db, fixtures, { prefix, stamp }) {
  const ids = fixtures.map((f) => String(f.userId))
  const emails = fixtures.map((f) => f.email)
  const col = (rows, k) => rows.map((r) => String(r[k]))
  const report = {}
  await db.$transaction(async (tx) => {
    const mods = col(await tx.$queryRaw`SELECT module_id FROM modules WHERE ${sqlIn('created_by_id', ids)} OR ${sqlIn('owner_id', ids)}`, 'module_id')
    const cases = col(await tx.$queryRaw`SELECT test_case_id FROM test_cases WHERE ${sqlIn('author_id', ids)} OR ${sqlIn('module_id', mods)}`, 'test_case_id')
    const bugs = col(await tx.$queryRaw`SELECT bug_id FROM bugs WHERE ${sqlIn('reported_by_id', ids)} OR ${sqlIn('module_id', mods)}`, 'bug_id')
    const mrs = col(await tx.$queryRaw`SELECT module_review_request_id FROM module_review_requests WHERE ${sqlIn('module_id', mods)} OR ${sqlIn('requester_id', ids)} OR ${sqlIn('reviewer_id', ids)}`, 'module_review_request_id')
    const revs = col(await tx.$queryRaw`SELECT review_request_id FROM review_requests WHERE ${sqlIn('test_case_id', cases)} OR ${sqlIn('requester_id', ids)} OR ${sqlIn('reviewer_id', ids)} OR ${sqlIn('module_review_id', mrs)}`, 'review_request_id')
    const wiki = col(await tx.$queryRaw`SELECT wiki_document_id FROM wiki_documents WHERE ${sqlIn('author_id', ids)}`, 'wiki_document_id').filter(Boolean)
    const tasks = col(await tx.$queryRaw`SELECT task_report_id FROM task_reports WHERE ${sqlIn('reported_by_id', ids)}`, 'task_report_id')
    report.found = { modules: mods.length, cases: cases.length, bugs: bugs.length, reviews: revs.length, moduleReviews: mrs.length, wiki: wiki.length, taskReports: tasks.length }
    report.notifications = await tx.$executeRaw`DELETE FROM notifications WHERE ${sqlIn('user_id', ids)}
      OR (entity_type = 'test_case' AND ${sqlIn('entity_id', cases)}) OR (entity_type = 'bug' AND ${sqlIn('entity_id', bugs)})
      OR (entity_type = 'review' AND ${sqlIn('entity_id', revs)}) OR (entity_type = 'module_review' AND ${sqlIn('entity_id', mrs)})
      OR (entity_type = 'module' AND ${sqlIn('entity_id', mods)}) OR (entity_type = 'wiki_document' AND ${sqlIn('entity_id', wiki)})
      OR (entity_type = 'task_report' AND ${sqlIn('entity_id', tasks)}) OR (entity_type = 'user' AND ${sqlIn('entity_id', ids)})`
    report.crew_desk_links = await tx.$executeRaw`DELETE FROM crew_desk_links WHERE ${sqlIn('linked_by_id', ids)}`
    report.bugs = await tx.$executeRaw`DELETE FROM bugs WHERE ${sqlIn('bug_id', bugs)}`
    report.review_requests = await tx.$executeRaw`DELETE FROM review_requests WHERE ${sqlIn('review_request_id', revs)}`
    report.module_review_requests = await tx.$executeRaw`DELETE FROM module_review_requests WHERE ${sqlIn('module_review_request_id', mrs)}`
    report.test_cases = await tx.$executeRaw`DELETE FROM test_cases WHERE ${sqlIn('test_case_id', cases)}`
    report.history_by_fixtures = await tx.$executeRaw`DELETE FROM test_case_history WHERE ${sqlIn('changed_by_id', ids)}`
    report.modules = await tx.$executeRaw`DELETE FROM modules WHERE ${sqlIn('module_id', mods)}`
    report.wiki = await tx.$executeRaw`DELETE FROM wiki_documents WHERE ${sqlIn('author_id', ids)}`
    report.task_reports = await tx.$executeRaw`DELETE FROM task_reports WHERE ${sqlIn('reported_by_id', ids)}`
    report.refresh_tokens = await tx.$executeRaw`DELETE FROM refresh_tokens WHERE ${sqlIn('user_id', ids)}`
    report.login_attempts = await tx.$executeRaw`DELETE FROM login_attempts WHERE ${sqlIn('email', emails)}`
    report.activity_logs = await tx.$executeRaw`DELETE FROM activity_logs WHERE ${sqlIn('user_id', ids)}
      OR (entity_type = 'user' AND ${sqlIn('entity_id', ids)}) OR (entity_type = 'test_case' AND ${sqlIn('entity_id', cases)})
      OR (entity_type = 'bug' AND ${sqlIn('entity_id', bugs)}) OR (entity_type = 'module' AND ${sqlIn('entity_id', mods)})`
    report.users = await tx.$executeRaw`DELETE FROM users WHERE ${sqlIn('user_id', ids)}`
    report.role_permissions = await tx.$executeRaw`DELETE FROM role_permissions` // precondition was 0 rows
  }, { maxWait: 10_000, timeout: 120_000 })
  const left = await db.$queryRaw`SELECT
    (SELECT COUNT(*) FROM users WHERE email LIKE ${`${prefix}-%-${stamp}@tcms.test`}) AS users,
    (SELECT COUNT(*) FROM test_cases WHERE title LIKE ${`%${stamp}%`}) AS cases,
    (SELECT COUNT(*) FROM bugs WHERE title LIKE ${`%${stamp}%`}) AS bugs,
    (SELECT COUNT(*) FROM modules WHERE name LIKE ${`%${stamp}%`}) AS modules,
    (SELECT COUNT(*) FROM role_permissions) AS role_permissions`
  report.residue = Object.fromEntries(Object.entries(left[0]).map(([k, v]) => [k, Number(v)]))
  return report
}
