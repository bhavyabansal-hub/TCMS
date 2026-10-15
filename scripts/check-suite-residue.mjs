/**
 * REQ-001 R10.AC13 — read-only residue checker (SELECT only; DB guard + GET_LOCK first).
 *
 * Modes:
 *   --suite=wiki|matrix --stamp=<n> [--manifest=<path>]
 *        rows left by one suite run, keyed on the exact fixture e-mails, fixture ids and
 *        the manifest's collected entity ids (default manifest path = the suite's own).
 *   --pattern=A|B|C|D|E2|I|J [--group-i=<id,id>]
 *        R9 candidate rows of one group (same SELECTs as cleanup-req001-testdata.mjs).
 *   --table-counts
 *        exact COUNT(*) per table (R9.AC1 backup evidence).
 * Output: `RESIDUE <table>=<n>` (+ primary keys) and `RESIDUE TOTAL=<n>`.
 * Exit: 0 total 0, 1 total > 0, 2 NOT RUN (guard, lock, bad arguments).
 * A "0" counts only after a positive control showed non-zero (P5).
 */
import { existsSync } from 'node:fs'
import { GuardAbort, Prisma, openGuardedDb } from './lib/db-guard.mjs'
import { findUsersByEmails, fixtureEmail } from './lib/fixture-users.mjs'
import { manifestPath, parseFlags, readManifest } from './lib/suite-harness.mjs'
import { ALL_RESIDUE_TABLES, collectEntities, countResidue, emptyEntities, mergeEntities } from './lib/suite-data.mjs'
import { ALL_GROUPS, collectGroupJ, collectRoots, deriveChildren, parentsFromRoots } from './lib/r9-candidates.mjs'

const SUITES = {
  wiki: {
    prefix: 'wiki',
    keys: ['vp', 'mgr', 'prod', 'qa', 'dev', 'viewer'],
    tables: ['users', 'wiki_documents', 'activity_logs', 'notifications', 'refresh_tokens', 'login_attempts', 'role_permissions'],
  },
  matrix: {
    prefix: 'permmatrix',
    keys: ['vp', 'mgr', 'prod', 'dev', 'qa', 'viewer', 'signup'],
    tables: ALL_RESIDUE_TABLES,
  },
}
const ALL_TABLES = [
  'users', 'refresh_tokens', 'modules', 'role_permissions', 'login_attempts', 'test_cases',
  'test_case_history', 'module_review_requests', 'review_requests', 'review_events', 'bugs',
  'bug_test_case_links', 'task_reports', 'notifications', 'activity_logs', 'crew_desk_links', 'wiki_documents',
]

function printResidue(result) {
  let total = 0
  for (const [table, pks] of Object.entries(result)) {
    total += pks.length
    console.log(`RESIDUE ${table}=${pks.length}${pks.length ? `  ${pks.join(',')}` : ''}`)
  }
  console.log(`RESIDUE TOTAL=${total}`)
  return total === 0 ? 0 : 1
}

async function checkSuite(db, flags) {
  const suite = SUITES[flags.suite]
  const stamp = String(flags.stamp ?? '')
  if (!suite || !/^\d{13}$/.test(stamp)) {
    console.log('NOT RUN: --suite=wiki|matrix and a 13-digit --stamp are required')
    return 2
  }
  const emails = suite.keys.map((k) => fixtureEmail(suite.prefix, k, stamp))
  const file = flags.manifest ? String(flags.manifest) : manifestPath(flags.suite, stamp)
  const manifest = existsSync(file) ? readManifest(file) : null
  console.log(`CHECK suite=${flags.suite} stamp=${stamp} manifest=${manifest ? file : 'none (e-mails + SQL only)'}`)
  const found = await findUsersByEmails(db, emails)
  const fixtureIds = [...new Set([...(manifest?.fixtureIds ?? []), ...found.map((r) => r.user_id)])]
  const entities = mergeEntities(manifest?.entities ?? emptyEntities(), await collectEntities(db, fixtureIds))
  return printResidue(await countResidue(db, { fixtureIds, emails, entities }, suite.tables))
}

async function checkPattern(db, flags) {
  const group = String(flags.pattern)
  if (!ALL_GROUPS.includes(group)) {
    console.log(`NOT RUN: --pattern must be one of ${ALL_GROUPS.join(', ')}`)
    return 2
  }
  console.log(`CHECK pattern=${group}`)
  if (group === 'J') {
    const users = await collectGroupJ(db)
    return printResidue({ users: users.map((u) => `${u.pk}(${u.ident})`) })
  }
  const groupIIds = flags['group-i'] ? String(flags['group-i']).split(',').filter(Boolean) : []
  const roots = await collectRoots(db, [group], { groupIIds })
  const children = await deriveChildren(db, parentsFromRoots(roots))
  const result = {}
  for (const [table, rows] of Object.entries(roots)) result[table] = rows.map((r) => r.pk)
  for (const table of ['submodules', 'module_review_requests', 'review_requests', 'review_events', 'test_case_history', 'bug_test_case_links', 'crew_desk_links', 'notifications']) {
    result[table] = children[table].map((r) => r.pk)
  }
  return printResidue(result)
}

async function printTableCounts(db) {
  console.log('CHECK table-counts')
  for (const table of ALL_TABLES) {
    const rows = await db.$queryRaw`SELECT COUNT(*) AS n FROM ${Prisma.raw(table)}`
    console.log(`COUNT ${table}=${Number(rows[0].n)}`)
  }
  const overrides = await db.$queryRaw`SELECT role, action, enabled, updated_by_id, updated_at FROM role_permissions ORDER BY role, action`
  for (const r of overrides) {
    console.log(`OVERRIDE ${r.role}/${r.action} enabled=${Number(r.enabled)} updated_by_id=${r.updated_by_id ?? 'null'} updated_at=${r.updated_at?.toISOString?.() ?? r.updated_at}`)
  }
  return 0
}

async function main() {
  const flags = parseFlags(process.argv.slice(2))
  const modes = ['suite', 'pattern', 'table-counts'].filter((m) => flags[m])
  if (modes.length !== 1) {
    console.log('NOT RUN: choose exactly one of --suite, --pattern, --table-counts')
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
    if (flags.suite) return await checkSuite(guard.db, flags)
    if (flags.pattern) return await checkPattern(guard.db, flags)
    return await printTableCounts(guard.db)
  } finally {
    await guard.release()
  }
}

main().then(
  (code) => { process.exitCode = code },
  (err) => { console.error(`CHECK ERROR: ${err.message}`); process.exitCode = 1 }
)
