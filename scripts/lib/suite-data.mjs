// ID-scoped data helpers for the REQ-001 writing suites and check-suite-residue.mjs:
// collect the entities a run created (by fixture user ids, before cascades erase them),
// count residue per table, and the FK-ordered cleanup statements (04-design.md 2.3).
// Raw SQL only, parameterized; writes via $executeRaw.
import { Prisma } from '@prisma/client'
import { sqlIn } from './db-guard.mjs'

export const ENTITY_KINDS = ['modules', 'cases', 'reviews', 'moduleReviews', 'bugs', 'taskReports', 'wikiDocs']

const uniq = (list) => [...new Set(list.filter(Boolean))]
const ids = (rows, key) => rows.map((r) => r[key])

/** Empty entity bag. */
export function emptyEntities() {
  return Object.fromEntries(ENTITY_KINDS.map((k) => [k, []]))
}

/** Union of two entity bags. */
export function mergeEntities(a, b) {
  const merged = emptyEntities()
  for (const k of ENTITY_KINDS) merged[k] = uniq([...(a?.[k] ?? []), ...(b?.[k] ?? [])])
  return merged
}

/**
 * Reads, by SQL, every entity owned/created by the fixture users (plus `known` ids
 * collected from responses). Must run before any delete: cascades erase review ids.
 */
export async function collectEntities(db, fixtureIds, known = emptyEntities()) {
  const f = fixtureIds
  const modules = uniq([
    ...known.modules,
    ...ids(await db.$queryRaw`SELECT module_id FROM modules WHERE ${sqlIn('created_by_id', f)} OR ${sqlIn('owner_id', f)}`, 'module_id'),
  ])
  const cases = uniq([
    ...known.cases,
    ...ids(await db.$queryRaw`SELECT test_case_id FROM test_cases WHERE ${sqlIn('author_id', f)} OR ${sqlIn('module_id', modules)}`, 'test_case_id'),
  ])
  const reviews = uniq([
    ...known.reviews,
    ...ids(
      await db.$queryRaw`SELECT review_request_id FROM review_requests
        WHERE ${sqlIn('test_case_id', cases)} OR ${sqlIn('reviewer_id', f)} OR ${sqlIn('requester_id', f)}`,
      'review_request_id'
    ),
  ])
  const moduleReviews = uniq([
    ...known.moduleReviews,
    ...ids(
      await db.$queryRaw`SELECT module_review_request_id FROM module_review_requests
        WHERE ${sqlIn('module_id', modules)} OR ${sqlIn('reviewer_id', f)} OR ${sqlIn('requester_id', f)}`,
      'module_review_request_id'
    ),
  ])
  const bugs = uniq([
    ...known.bugs,
    ...ids(await db.$queryRaw`SELECT bug_id FROM bugs WHERE ${sqlIn('reported_by_id', f)} OR ${sqlIn('module_id', modules)}`, 'bug_id'),
  ])
  const taskReports = uniq([
    ...known.taskReports,
    ...ids(await db.$queryRaw`SELECT task_report_id FROM task_reports WHERE ${sqlIn('reported_by_id', f)}`, 'task_report_id'),
  ])
  const wikiDocs = uniq([
    ...known.wikiDocs,
    ...ids(await db.$queryRaw`SELECT wiki_document_id FROM wiki_documents WHERE ${sqlIn('author_id', f)}`, 'wiki_document_id'),
  ])
  return { modules, cases, reviews, moduleReviews, bugs, taskReports, wikiDocs }
}

/** Notifications pointing at the run's entities (covers demo recipients, Q14/Q19). */
function notificationEntityFilter(e) {
  return Prisma.sql`(
       (entity_type = 'test_case'     AND ${sqlIn('entity_id', e.cases)})
    OR (entity_type = 'review'        AND ${sqlIn('entity_id', e.reviews)})
    OR (entity_type = 'module_review' AND ${sqlIn('entity_id', e.moduleReviews)})
    OR (entity_type = 'bug'           AND ${sqlIn('entity_id', e.bugs)})
    OR (entity_type = 'task_report'   AND ${sqlIn('entity_id', e.taskReports)}))`
}

/**
 * Residue queries per table, keyed on fixture ids (f), fixture e-mails (emails)
 * and collected entity ids (e). Each returns the primary keys still present.
 */
function residueQueries(f, emails, e) {
  return {
    users: Prisma.sql`SELECT user_id AS pk FROM users WHERE ${sqlIn('user_id', f)} OR ${sqlIn('email', emails)}`,
    modules: Prisma.sql`SELECT module_id AS pk FROM modules
      WHERE ${sqlIn('module_id', e.modules)} OR ${sqlIn('created_by_id', f)} OR ${sqlIn('owner_id', f)}`,
    test_cases: Prisma.sql`SELECT test_case_id AS pk FROM test_cases WHERE ${sqlIn('test_case_id', e.cases)} OR ${sqlIn('author_id', f)}`,
    test_case_history: Prisma.sql`SELECT history_id AS pk FROM test_case_history
      WHERE ${sqlIn('test_case_id', e.cases)} OR ${sqlIn('changed_by_id', f)}`,
    review_requests: Prisma.sql`SELECT review_request_id AS pk FROM review_requests
      WHERE ${sqlIn('review_request_id', e.reviews)} OR ${sqlIn('test_case_id', e.cases)}
         OR ${sqlIn('reviewer_id', f)} OR ${sqlIn('requester_id', f)}`,
    review_events: Prisma.sql`SELECT review_event_id AS pk FROM review_events
      WHERE ${sqlIn('review_request_id', e.reviews)} OR ${sqlIn('reviewer_id', f)}`,
    module_review_requests: Prisma.sql`SELECT module_review_request_id AS pk FROM module_review_requests
      WHERE ${sqlIn('module_review_request_id', e.moduleReviews)} OR ${sqlIn('module_id', e.modules)}
         OR ${sqlIn('reviewer_id', f)} OR ${sqlIn('requester_id', f)}`,
    bugs: Prisma.sql`SELECT bug_id AS pk FROM bugs WHERE ${sqlIn('bug_id', e.bugs)} OR ${sqlIn('reported_by_id', f)}`,
    bug_test_case_links: Prisma.sql`SELECT CONCAT(bug_id, '/', test_case_id) AS pk FROM bug_test_case_links
      WHERE ${sqlIn('bug_id', e.bugs)} OR ${sqlIn('test_case_id', e.cases)}`,
    wiki_documents: Prisma.sql`SELECT wiki_document_id AS pk FROM wiki_documents
      WHERE ${sqlIn('wiki_document_id', e.wikiDocs)} OR ${sqlIn('author_id', f)}`,
    task_reports: Prisma.sql`SELECT task_report_id AS pk FROM task_reports
      WHERE ${sqlIn('task_report_id', e.taskReports)} OR ${sqlIn('reported_by_id', f)}`,
    role_permissions: Prisma.sql`SELECT CONCAT(role, ':', action) AS pk FROM role_permissions WHERE ${sqlIn('updated_by_id', f)}`,
    activity_logs: Prisma.sql`SELECT activity_log_id AS pk FROM activity_logs WHERE ${sqlIn('user_id', f)}`,
    refresh_tokens: Prisma.sql`SELECT refresh_token_id AS pk FROM refresh_tokens WHERE ${sqlIn('user_id', f)}`,
    notifications: Prisma.sql`SELECT notification_id AS pk FROM notifications
      WHERE ${sqlIn('user_id', f)} OR ${notificationEntityFilter(e)}`,
    login_attempts: Prisma.sql`SELECT email AS pk FROM login_attempts WHERE ${sqlIn('email', emails)}`,
  }
}

/** Residue per requested table: { table: pk[] }. Read-only. */
export async function countResidue(db, { fixtureIds, emails, entities }, tables) {
  const queries = residueQueries(fixtureIds, emails, entities ?? emptyEntities())
  const result = {}
  for (const table of tables) {
    const rows = await db.$queryRaw(queries[table])
    result[table] = rows.map((r) => String(r.pk))
  }
  return result
}

export const ALL_RESIDUE_TABLES = [
  'users', 'modules', 'test_cases', 'test_case_history', 'review_requests', 'review_events',
  'module_review_requests', 'bugs', 'bug_test_case_links', 'wiki_documents', 'task_reports',
  'role_permissions', 'activity_logs', 'refresh_tokens', 'notifications', 'login_attempts',
]

// ---------- cleanup statements (each returns the affected-row count) ----------

export function deleteNotificationsByEntity(db, e) {
  return db.$executeRaw`DELETE FROM notifications WHERE ${notificationEntityFilter(e)}`
}

export function deleteBugsByIds(db, bugIds) {
  return db.$executeRaw`DELETE FROM bugs WHERE ${sqlIn('bug_id', bugIds)}`
}

export function deleteTestCaseById(db, testCaseId) {
  return db.$executeRaw`DELETE FROM test_cases WHERE test_case_id = ${testCaseId}`
}

export async function deleteReviewsByParticipants(db, f) {
  const reviews = await db.$executeRaw`DELETE FROM review_requests WHERE ${sqlIn('reviewer_id', f)} OR ${sqlIn('requester_id', f)}`
  const moduleReviews = await db.$executeRaw`DELETE FROM module_review_requests
    WHERE ${sqlIn('reviewer_id', f)} OR ${sqlIn('requester_id', f)}`
  return reviews + moduleReviews
}

export function deleteWikiDocById(db, wikiDocumentId) {
  return db.$executeRaw`DELETE FROM wiki_documents WHERE wiki_document_id = ${wikiDocumentId}`
}

/** Rows still pointing at the modules (SET NULL trap: cases/bugs must go first). */
export async function countModuleDependents(db, moduleIds) {
  const cases = await db.$queryRaw`SELECT COUNT(*) AS n FROM test_cases WHERE ${sqlIn('module_id', moduleIds)}`
  const bugs = await db.$queryRaw`SELECT COUNT(*) AS n FROM bugs WHERE ${sqlIn('module_id', moduleIds)}`
  return Number(cases[0].n) + Number(bugs[0].n)
}

export function deleteModulesByIds(db, moduleIds) {
  return db.$executeRaw`DELETE FROM modules WHERE ${sqlIn('module_id', moduleIds)}`
}

/**
 * Restores the touched matrix cells (S2 rule): a row written by a fixture is deleted
 * (the precondition proved the cell had no row before the run); no row = already default;
 * a row written by anyone else is left untouched and reported.
 * @returns {Promise<{ deleted: number, foreign: string[] }>}
 */
export async function restoreTouchedCells(db, cells, fixtureIds) {
  let deleted = 0
  const foreign = []
  for (const { role, action } of cells) {
    const rows = await db.$queryRaw`SELECT updated_by_id FROM role_permissions WHERE role = ${role} AND action = ${action}`
    if (rows.length === 0) continue
    if (fixtureIds.includes(rows[0].updated_by_id)) {
      deleted += await db.$executeRaw`DELETE FROM role_permissions
        WHERE role = ${role} AND action = ${action} AND ${sqlIn('updated_by_id', fixtureIds)}`
    } else {
      foreign.push(`${role}/${action} (updated_by_id=${rows[0].updated_by_id ?? 'null'})`)
    }
  }
  return { deleted, foreign }
}

export function deleteActivityLogsByUsers(db, f) {
  return db.$executeRaw`DELETE FROM activity_logs WHERE ${sqlIn('user_id', f)}`
}

export function deleteLoginAttemptsByEmails(db, emails) {
  return db.$executeRaw`DELETE FROM login_attempts WHERE ${sqlIn('email', emails)}`
}

/** Deletes users one by one so a RESTRICT failure on one does not keep the others. */
export async function deleteUsersByIds(db, f) {
  let deleted = 0
  const failed = []
  for (const userId of f) {
    try {
      deleted += await db.$executeRaw`DELETE FROM users WHERE user_id = ${userId}`
    } catch (err) {
      failed.push(`${userId} (${err.meta?.code ?? err.code ?? 'error'})`)
    }
  }
  return { deleted, failed }
}
