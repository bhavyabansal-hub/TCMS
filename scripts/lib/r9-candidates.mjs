// R9 candidate selection (04-design.md 2.2), shared by cleanup-req001-testdata.mjs and
// check-suite-residue.mjs --pattern. SELECT only. Raw SQL, parameterized; id lists via sqlIn.
import { Prisma } from '@prisma/client'
import { sqlIn } from './db-guard.mjs'

/** Groups whose roots are delete candidates (E, F, G, H are not roots; J is list-only). */
export const DELETE_GROUPS = ['A', 'B', 'C', 'D', 'E2', 'I']
export const ALL_GROUPS = [...DELETE_GROUPS, 'J']

const GROUP_B_EMAIL = 'qa1@tcms.com'
const GROUP_B_DATE = '2026-10-15'
const J_PATTERNS = ['wiki-%-%@tcms.test', 'permmatrix-%-%@tcms.test']

const emptyRoots = () => ({ modules: [], test_cases: [], bugs: [], wiki_documents: [], task_reports: [] })

const caseRows = (prefix) => (q) =>
  q.$queryRaw`SELECT test_case_id AS pk, title AS ident, module_id, status, created_at
    FROM test_cases WHERE title LIKE ${prefix} ORDER BY created_at`
const bugRows = (prefix) => (q) =>
  q.$queryRaw`SELECT bug_id AS pk, title AS ident, module_id, status, created_at
    FROM bugs WHERE title LIKE ${prefix} ORDER BY created_at`

/** Root rows of one group: { modules, test_cases, bugs, wiki_documents, task_reports }. */
export async function collectGroupRoots(q, group, { groupIIds = [] } = {}) {
  const roots = emptyRoots()
  if (group === 'A') {
    roots.modules = await q.$queryRaw`SELECT module_id AS pk, name AS ident, path, created_at
      FROM modules WHERE name LIKE 'QACHECK%' ORDER BY created_at`
    roots.test_cases = await caseRows('QACHECK%')(q)
    roots.bugs = await bugRows('QACHECK%')(q)
    roots.wiki_documents = await q.$queryRaw`SELECT wiki_document_id AS pk, title AS ident, author_id, created_at
      FROM wiki_documents WHERE title LIKE 'QACHECK%' ORDER BY created_at`
  } else if (group === 'B') {
    roots.task_reports = await q.$queryRaw`SELECT tr.task_report_id AS pk, u.email AS ident, tr.report_date,
        tr.total_minutes, tr.tasks, tr.notes, tr.created_at
      FROM task_reports tr JOIN users u ON u.user_id = tr.reported_by_id
      WHERE u.email = ${GROUP_B_EMAIL} AND DATE(tr.report_date) = ${GROUP_B_DATE}`
  } else if (group === 'C') {
    roots.test_cases = await caseRows('Imported: %')(q)
  } else if (group === 'D') {
    roots.test_cases = await caseRows('Perm-verify case %')(q)
  } else if (group === 'E2') {
    roots.bugs = await bugRows('Verify notification %')(q)
  } else if (group === 'I') {
    if (groupIIds.length) {
      roots.task_reports = await q.$queryRaw`SELECT task_report_id AS pk, reported_by_id AS ident, report_date,
          total_minutes, tasks, notes, created_at
        FROM task_reports WHERE ${sqlIn('task_report_id', groupIIds)}`
    }
  }
  return roots
}

/** Group J: leftover suite fixture users (listed only, never deleted by R9). */
export async function collectGroupJ(q) {
  const users = []
  for (const pattern of J_PATTERNS) {
    const rows = await q.$queryRaw`SELECT u.user_id AS pk, u.email AS ident, u.is_active, u.created_at,
        (SELECT COUNT(*) FROM test_cases t WHERE t.author_id = u.user_id) AS cases,
        (SELECT COUNT(*) FROM bugs b WHERE b.reported_by_id = u.user_id) AS bugs,
        (SELECT COUNT(*) FROM wiki_documents w WHERE w.author_id = u.user_id) AS wiki_docs,
        (SELECT COUNT(*) FROM modules m WHERE m.created_by_id = u.user_id) AS modules,
        (SELECT COUNT(*) FROM task_reports r WHERE r.reported_by_id = u.user_id) AS task_reports
      FROM users u WHERE u.email LIKE ${pattern} ORDER BY u.created_at`
    users.push(...rows)
  }
  return users
}

const pks = (rows) => rows.map((r) => r.pk)
const uniq = (list) => [...new Set(list)]

/**
 * Cascade children + explicit no-FK rows for the given parent ids.
 * @param q  db or transaction client
 * @param p  { moduleRoots: {pk,path}[], cases: string[], bugs: string[], taskReports: string[] }
 * @param opts.forUpdate lock the selected rows (delete run)
 */
export async function deriveChildren(q, p, { forUpdate = false } = {}) {
  const lock = forUpdate ? Prisma.sql`FOR UPDATE` : Prisma.empty
  const subtree = []
  for (const root of p.moduleRoots) {
    const prefix = `${root.path ?? ''}.${root.pk}`
    const rows = await q.$queryRaw`SELECT module_id AS pk, name AS ident, path, created_at FROM modules
      WHERE module_id = ${root.pk} OR path = ${prefix} OR path LIKE ${`${prefix}.%`} ${lock}`
    subtree.push(...rows)
  }
  const subtreeIds = uniq(pks(subtree))
  const rootIds = p.moduleRoots.map((r) => r.pk)
  const submodules = subtree.filter((m) => !rootIds.includes(m.pk))

  const subtreeCases = await q.$queryRaw`SELECT test_case_id AS pk, title AS ident FROM test_cases
    WHERE ${sqlIn('module_id', subtreeIds)} ${lock}`
  const subtreeBugs = await q.$queryRaw`SELECT bug_id AS pk, title AS ident FROM bugs
    WHERE ${sqlIn('module_id', subtreeIds)} ${lock}`
  const orphanRisk = [
    ...subtreeCases.filter((r) => !p.cases.includes(r.pk)).map((r) => ({ table: 'test_cases', ...r })),
    ...subtreeBugs.filter((r) => !p.bugs.includes(r.pk)).map((r) => ({ table: 'bugs', ...r })),
  ]

  const moduleReviews = await q.$queryRaw`SELECT module_review_request_id AS pk, module_id, status, created_at
    FROM module_review_requests WHERE ${sqlIn('module_id', subtreeIds)} ${lock}`
  const moduleReviewIds = pks(moduleReviews)
  const reviews = await q.$queryRaw`SELECT review_request_id AS pk, test_case_id, module_review_id, status, created_at
    FROM review_requests WHERE ${sqlIn('test_case_id', p.cases)} OR ${sqlIn('module_review_id', moduleReviewIds)} ${lock}`
  const reviewIds = pks(reviews)
  const events = await q.$queryRaw`SELECT review_event_id AS pk, review_request_id, created_at
    FROM review_events WHERE ${sqlIn('review_request_id', reviewIds)} ${lock}`
  const history = await q.$queryRaw`SELECT history_id AS pk, test_case_id, version, created_at
    FROM test_case_history WHERE ${sqlIn('test_case_id', p.cases)} ${lock}`
  const links = await q.$queryRaw`SELECT CONCAT(bug_id, '/', test_case_id) AS pk, bug_id, test_case_id, created_at
    FROM bug_test_case_links WHERE ${sqlIn('bug_id', p.bugs)} OR ${sqlIn('test_case_id', p.cases)} ${lock}`
  const crewDeskLinks = await q.$queryRaw`SELECT link_id AS pk, module_id, ticket_id AS ident, created_at
    FROM crew_desk_links WHERE ${sqlIn('module_id', subtreeIds)} ${lock}`
  const notifications = await q.$queryRaw`SELECT notification_id AS pk, user_id, type AS ident, entity_type, entity_id, created_at
    FROM notifications
    WHERE (entity_type = 'test_case'     AND ${sqlIn('entity_id', p.cases)})
       OR (entity_type = 'review'        AND ${sqlIn('entity_id', reviewIds)})
       OR (entity_type = 'module_review' AND ${sqlIn('entity_id', moduleReviewIds)})
       OR (entity_type = 'bug'           AND ${sqlIn('entity_id', p.bugs)})
       OR (entity_type = 'task_report'   AND ${sqlIn('entity_id', p.taskReports)}) ${lock}`

  // D-EMPTY: a kept module review (outside the subtree) whose case reviews would all go.
  const keptModuleReviewIds = uniq(
    reviews.map((r) => r.module_review_id).filter((id) => id && !moduleReviewIds.includes(id))
  )
  const dEmpty = []
  for (const mrId of keptModuleReviewIds) {
    const left = await q.$queryRaw`SELECT COUNT(*) AS n FROM review_requests
      WHERE module_review_id = ${mrId} AND NOT (${sqlIn('test_case_id', p.cases)})`
    dEmpty.push({ moduleReviewId: mrId, remainingCaseReviews: Number(left[0].n) })
  }

  return {
    submodules,
    module_review_requests: moduleReviews,
    review_requests: reviews,
    review_events: events,
    test_case_history: history,
    bug_test_case_links: links,
    crew_desk_links: crewDeskLinks,
    notifications,
    orphanRisk,
    dEmpty,
  }
}

/** Roots of several groups merged per table (dedup by pk, first group wins for labelling). */
export async function collectRoots(q, groups, opts) {
  const merged = emptyRoots()
  const seen = new Set()
  for (const group of groups) {
    const roots = await collectGroupRoots(q, group, opts)
    for (const [table, rows] of Object.entries(roots)) {
      for (const row of rows) {
        const key = `${table}:${row.pk}`
        if (seen.has(key)) continue
        seen.add(key)
        merged[table].push({ ...row, group })
      }
    }
  }
  return merged
}

/** Parent-id bag for deriveChildren from merged roots. */
export function parentsFromRoots(roots) {
  return {
    moduleRoots: roots.modules.map((m) => ({ pk: m.pk, path: m.path })),
    cases: pks(roots.test_cases),
    bugs: pks(roots.bugs),
    taskReports: pks(roots.task_reports),
  }
}
