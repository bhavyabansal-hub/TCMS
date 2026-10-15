/**
 * REQ-001 R9 — remove the QA-check test data from tcms_test, exactly as the owner approves.
 * SQL design: docs/requirements/REQ-001-qa-check-fixes/04-design.md section 2.2.
 *
 * DEFAULT = DRY RUN: SELECT only, writes nothing in the database, prints every candidate
 * row (groups A, B, C, D, E2, I + cascade children, crew_desk_links, entity notifications),
 * group J (listed only), group G (override count), and a count per table. With
 * --template=<file> it also writes the approval template (all keys) to that file.
 *
 * DELETE RUN: only with BOTH --delete AND --approved=<file> (the owner's approved template).
 * One transaction: lock + re-check the approved PK sets (parents, children, orphans) ->
 * any difference = ROLLBACK, exit 1; deletes in FK order with affected-row checks;
 * in-transaction residue = 0; COMMIT. No UPDATE, and no statement touches users,
 * activity_logs, role_permissions or refresh_tokens.
 *
 * Usage:
 *   node scripts/cleanup-req001-testdata.mjs [--group-i=<id,id>] [--template=<file>] [--include-b-no-qacheck]
 *   Group B rows without QACHECK text in tasks/notes are flagged B-NO-QACHECK and left out
 *   of the candidate list and template unless --include-b-no-qacheck is given.
 *   node scripts/cleanup-req001-testdata.mjs --delete --approved=<file>     (owner go only)
 * Exit: 0 ok, 1 FAIL/rollback, 2 NOT RUN (guard, lock, bad arguments).
 * Forbidden as tools or evidence: cleanup-import-demo.mjs, check-overrides.mjs (R9.AC12).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { GuardAbort, Prisma, openGuardedDb, sqlIn } from './lib/db-guard.mjs'
import { parseFlags } from './lib/suite-harness.mjs'
import {
  B_NO_QACHECK,
  DELETE_GROUPS,
  collectGroupJ,
  collectRoots,
  deriveChildren,
  parentsFromRoots,
  splitNoQacheck,
} from './lib/r9-candidates.mjs'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROOT_TABLES = ['modules', 'test_cases', 'bugs', 'wiki_documents', 'task_reports']
const CHILD_TABLES = [
  'submodules', 'module_review_requests', 'review_requests', 'review_events',
  'test_case_history', 'bug_test_case_links', 'crew_desk_links', 'notifications',
]
const iso = (d) => (d instanceof Date ? d.toISOString() : String(d ?? ''))
const pkList = (rows) => rows.map((r) => r.pk)

// ---------- dry run ----------

function printRows(table, rows, extra = () => '') {
  console.log(`  ${table} (${rows.length})`)
  for (const r of rows) {
    console.log(`    ${r.pk} | ${r.ident ?? ''} | ${iso(r.created_at)}${r.group ? ` | group ${r.group}` : ''}${extra(r)}`)
  }
}

function groupBFlag(r) {
  const base = ` | report_date=${iso(r.report_date)} | total_minutes=${Number(r.total_minutes)}`
  if (r.group !== 'B') return base
  return `${base} | B (owner decides)${r.flag ? ` | ${r.flag}` : ''} | tasks=${JSON.stringify(r.tasks)} | notes=${JSON.stringify(r.notes)}`
}

/** Key columns of child rows, so each line can be reconciled by hand. */
function childDetail(r) {
  const cols = ['test_case_id', 'module_review_id', 'module_id', 'status', 'user_id', 'entity_type', 'entity_id', 'review_request_id', 'bug_id', 'version']
  const parts = cols.filter((c) => r[c] !== undefined && r[c] !== null).map((c) => `${c}=${r[c]}`)
  return parts.length ? ` | ${parts.join(' ')}` : ''
}

async function runDryRun(db, flags) {
  const groupIIds = flags['group-i'] ? String(flags['group-i']).split(',').map((s) => s.trim()).filter(Boolean) : []
  const badIds = groupIIds.filter((id) => !UUID_RE.test(id))
  if (badIds.length) {
    console.log(`NOT RUN: --group-i ids must be UUIDs (${badIds.join(', ')})`)
    return 2
  }
  console.log(`MODE=DRY RUN (no write) groups=${DELETE_GROUPS.join(',')} groupI=${groupIIds.length}`)
  const includeNoQacheck = flags['include-b-no-qacheck'] === true
  const { roots, excluded } = splitNoQacheck(await collectRoots(db, DELETE_GROUPS, { groupIIds }), { include: includeNoQacheck })
  const children = await deriveChildren(db, parentsFromRoots(roots))

  console.log('\n== ROOTS (delete candidates) ==')
  for (const table of ROOT_TABLES) printRows(table, roots[table], table === 'task_reports' ? groupBFlag : childDetail)

  console.log('\n== CASCADE CHILDREN + NO-FK ROWS ==')
  for (const table of CHILD_TABLES) printRows(table, children[table], childDetail)

  console.log('\n== FLAGS ==')
  if (children.orphanRisk.length === 0) console.log('  ORPHAN-RISK: none')
  for (const o of children.orphanRisk) console.log(`  ORPHAN-RISK ${o.table} ${o.pk} | ${o.ident} (in a candidate module subtree, not on the list)`)
  if (excluded.length === 0) console.log(`  ${B_NO_QACHECK}: none${includeNoQacheck ? ' (--include-b-no-qacheck given)' : ''}`)
  for (const r of excluded) {
    console.log(`  ${B_NO_QACHECK} task_reports ${r.pk} | ${r.ident} | report_date=${iso(r.report_date)} | total_minutes=${Number(r.total_minutes)} | tasks=${JSON.stringify(r.tasks)} | notes=${JSON.stringify(r.notes)} | NOT in the candidate list or template (add --include-b-no-qacheck to list it)`)
  }
  if (children.dEmpty.length === 0) console.log('  D-EMPTY: no kept module review is affected')
  for (const d of children.dEmpty) {
    console.log(`  ${d.remainingCaseReviews === 0 ? 'D-EMPTY' : 'D-KEPT'} module_review ${d.moduleReviewId} remaining case reviews after delete=${d.remainingCaseReviews}`)
  }

  console.log('\n== GROUP J (listed only; recovery = the suite --cleanup-stamp) ==')
  const groupJ = await collectGroupJ(db)
  if (groupJ.length === 0) console.log('  none')
  for (const u of groupJ) {
    console.log(`    J (use --cleanup-stamp) ${u.pk} | ${u.ident} | active=${Number(u.is_active)} | cases=${Number(u.cases)} bugs=${Number(u.bugs)} wiki=${Number(u.wiki_docs)} modules=${Number(u.modules)} task_reports=${Number(u.task_reports)}`)
  }

  console.log('\n== GROUP G (verify only) ==')
  const overrides = await db.$queryRaw`SELECT COUNT(*) AS n FROM role_permissions`
  console.log(`  role_permissions rows=${Number(overrides[0].n)} (0 = all 126 cells default)`)

  console.log('\n== COUNTS PER TABLE ==')
  for (const table of ROOT_TABLES) console.log(`  ${table}=${roots[table].length}`)
  for (const table of CHILD_TABLES) console.log(`  ${table}=${children[table].length}`)
  console.log(`  orphan_risk=${children.orphanRisk.length} group_j_users=${groupJ.length}`)

  if (flags.template) {
    const template = {
      generatedAt: new Date().toISOString(),
      note: 'Owner approval = this file with struck rows removed. Invalid while orphanRisk is non-empty.',
      groupIIds,
      orphanRisk: children.orphanRisk.map((o) => `${o.table}:${o.pk}`),
      tables: Object.fromEntries(ROOT_TABLES.map((t) => [t, pkList(roots[t])])),
      children: Object.fromEntries(CHILD_TABLES.map((t) => [t, pkList(children[t])])),
    }
    writeFileSync(String(flags.template), JSON.stringify(template, null, 2))
    console.log(`\nTEMPLATE written: ${flags.template}`)
  }
  console.log('\nDRY RUN COMPLETE: nothing was deleted')
  return 0
}

// ---------- delete run (owner go only) ----------

function readApproved(file) {
  const approved = JSON.parse(readFileSync(file, 'utf8'))
  for (const t of ROOT_TABLES) if (!Array.isArray(approved.tables?.[t])) throw new Error(`approved file: tables.${t} missing`)
  for (const t of CHILD_TABLES) if (!Array.isArray(approved.children?.[t])) throw new Error(`approved file: children.${t} missing`)
  if (approved.orphanRisk?.length) throw new Error('approved file still lists orphanRisk rows')
  return approved
}

// SQL review finding 3: both lists must be duplicate-free, same size, same members.
const sameSet = (a, b) =>
  a.length === b.length && new Set(a).size === a.length && new Set(b).size === b.length && new Set([...a, ...b]).size === a.length

class Rollback extends Error {}

const ROOT_LOCK_SQL = {
  modules: (ids) => ['module_id', 'SELECT module_id AS pk, path FROM modules', ids],
  test_cases: (ids) => ['test_case_id', 'SELECT test_case_id AS pk FROM test_cases', ids],
  bugs: (ids) => ['bug_id', 'SELECT bug_id AS pk FROM bugs', ids],
  wiki_documents: (ids) => ['wiki_document_id', 'SELECT wiki_document_id AS pk FROM wiki_documents', ids],
  task_reports: (ids) => ['task_report_id', 'SELECT task_report_id AS pk FROM task_reports', ids],
}

async function lockRoots(tx, approved) {
  const found = {}
  for (const t of ROOT_TABLES) {
    const [col, select, ids] = ROOT_LOCK_SQL[t](approved.tables[t])
    found[t] = ids.length ? await tx.$queryRaw`${Prisma.raw(select)} WHERE ${sqlIn(col, ids)} FOR UPDATE` : []
  }
  return found
}

async function deleteApproved(tx, approved) {
  const a = approved.tables
  const c = approved.children
  const removed = {}
  const expect = async (table, ids, run) => {
    if (ids.length === 0) { removed[table] = 0; return }
    const n = await run()
    removed[table] = n
    if (n !== ids.length) throw new Rollback(`${table}: deleted ${n}, approved ${ids.length}`)
  }
  await expect('notifications', c.notifications, () => tx.$executeRaw`DELETE FROM notifications WHERE ${sqlIn('notification_id', c.notifications)}`)
  await expect('crew_desk_links', c.crew_desk_links, () => tx.$executeRaw`DELETE FROM crew_desk_links WHERE ${sqlIn('link_id', c.crew_desk_links)}`)
  await expect('bugs', a.bugs, () => tx.$executeRaw`DELETE FROM bugs WHERE ${sqlIn('bug_id', a.bugs)}`)
  await expect('test_cases', a.test_cases, () => tx.$executeRaw`DELETE FROM test_cases WHERE ${sqlIn('test_case_id', a.test_cases)}`)
  await expect('wiki_documents', a.wiki_documents, () => tx.$executeRaw`DELETE FROM wiki_documents WHERE ${sqlIn('wiki_document_id', a.wiki_documents)}`)
  await expect('task_reports', a.task_reports, () => tx.$executeRaw`DELETE FROM task_reports WHERE ${sqlIn('task_report_id', a.task_reports)}`)
  await expect('modules', a.modules, () => tx.$executeRaw`DELETE FROM modules WHERE ${sqlIn('module_id', a.modules)}`)
  return removed
}

async function residueInTx(tx, approved) {
  const a = approved.tables
  const c = approved.children
  const count = async (sql) => Number((await tx.$queryRaw(sql))[0].n)
  const left = {
    modules: await count(Prisma.sql`SELECT COUNT(*) AS n FROM modules WHERE ${sqlIn('module_id', [...a.modules, ...c.submodules])}`),
    test_cases: await count(Prisma.sql`SELECT COUNT(*) AS n FROM test_cases WHERE ${sqlIn('test_case_id', a.test_cases)}`),
    bugs: await count(Prisma.sql`SELECT COUNT(*) AS n FROM bugs WHERE ${sqlIn('bug_id', a.bugs)}`),
    wiki_documents: await count(Prisma.sql`SELECT COUNT(*) AS n FROM wiki_documents WHERE ${sqlIn('wiki_document_id', a.wiki_documents)}`),
    task_reports: await count(Prisma.sql`SELECT COUNT(*) AS n FROM task_reports WHERE ${sqlIn('task_report_id', a.task_reports)}`),
    module_review_requests: await count(Prisma.sql`SELECT COUNT(*) AS n FROM module_review_requests WHERE ${sqlIn('module_review_request_id', c.module_review_requests)}`),
    review_requests: await count(Prisma.sql`SELECT COUNT(*) AS n FROM review_requests WHERE ${sqlIn('review_request_id', c.review_requests)}`),
    review_events: await count(Prisma.sql`SELECT COUNT(*) AS n FROM review_events WHERE ${sqlIn('review_event_id', c.review_events)}`),
    test_case_history: await count(Prisma.sql`SELECT COUNT(*) AS n FROM test_case_history WHERE ${sqlIn('history_id', c.test_case_history)}`),
    bug_test_case_links: await count(Prisma.sql`SELECT COUNT(*) AS n FROM bug_test_case_links WHERE ${sqlIn("CONCAT(bug_id, '/', test_case_id)", c.bug_test_case_links)}`),
    crew_desk_links: await count(Prisma.sql`SELECT COUNT(*) AS n FROM crew_desk_links WHERE ${sqlIn('link_id', c.crew_desk_links)}`),
    notifications: await count(Prisma.sql`SELECT COUNT(*) AS n FROM notifications WHERE ${sqlIn('notification_id', c.notifications)}`),
  }
  return left
}

async function runDelete(guard, approvedFile) {
  const { db } = guard
  const approved = readApproved(approvedFile)
  console.log(`MODE=DELETE approved=${approvedFile}`)
  let fail = 0
  const report = (name, ok, detail = '') => {
    if (!ok) fail++
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  }
  await db.$executeRaw`SET SESSION innodb_lock_wait_timeout = 5`
  guard.setBusy(true)
  try {
    await db.$transaction(
      async (tx) => {
        // 1. approved roots still exist exactly (PK set equality)
        const found = await lockRoots(tx, approved)
        for (const t of ROOT_TABLES) {
          const ok = sameSet(pkList(found[t]), approved.tables[t])
          report(`re-check ${t}`, ok, `found=${found[t].length} approved=${approved.tables[t].length}`)
        }
        // 2. children + orphans re-derived from the APPROVED parent ids (not the patterns)
        const children = await deriveChildren(
          tx,
          {
            moduleRoots: found.modules.map((m) => ({ pk: m.pk, path: m.path })),
            cases: approved.tables.test_cases,
            bugs: approved.tables.bugs,
            taskReports: approved.tables.task_reports,
          },
          { forUpdate: true }
        )
        for (const t of CHILD_TABLES) {
          const ok = sameSet(pkList(children[t]), approved.children[t])
          report(`re-check ${t}`, ok, `found=${children[t].length} approved=${approved.children[t].length}`)
        }
        report('re-check orphan guard', children.orphanRisk.length === 0, `orphans=${children.orphanRisk.length}`)
        if (fail > 0) throw new Rollback('approved list differs from the database')

        // 3. deletes in FK order (cases before modules, R9.AC2c)
        const removed = await deleteApproved(tx, approved)
        for (const [t, n] of Object.entries(removed)) report(`delete ${t}`, true, `${n} removed`)

        // 4. in-transaction residue = 0 for every approved PK (parents and children)
        const left = await residueInTx(tx, approved)
        for (const [t, n] of Object.entries(left)) report(`residue ${t}=0`, n === 0, `left=${n}`)
        if (fail > 0) throw new Rollback('residue after delete is not 0')
      },
      { maxWait: 10_000, timeout: 120_000 }
    )
    console.log('COMMIT: approved rows deleted')
    return 0
  } catch (err) {
    console.log(`ROLLBACK: ${err.message}. Nothing was deleted; no retry.`)
    return 1
  } finally {
    guard.setBusy(false)
  }
}

// ---------- entry ----------

async function main() {
  const flags = parseFlags(process.argv.slice(2))
  const isDelete = flags.delete === true
  if (isDelete && !flags.approved) {
    console.log('NOT RUN: --delete needs --approved=<owner-approved file>')
    return 2
  }
  if (!isDelete && flags.approved) {
    console.log('NOT RUN: --approved is only valid together with --delete')
    return 2
  }
  let guard
  try {
    guard = await openGuardedDb()
  } catch (err) {
    if (err instanceof GuardAbort) {
      console.log(`NOT RUN: ${err.message}`)
      return 2
    }
    throw err
  }
  try {
    return isDelete ? await runDelete(guard, String(flags.approved)) : await runDryRun(guard.db, flags)
  } finally {
    await guard.release()
  }
}

main().then(
  (code) => { process.exitCode = code },
  (err) => { console.error(`CLEANUP ERROR: ${err.message}`); process.exitCode = 1 }
)
