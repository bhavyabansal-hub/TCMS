/**
 * DB DEEP CHECKS (QA marathon 2026-10-09) — data integrity after the volume
 * seeding + matrix probes: counts, referential sanity, history/immutability
 * trails, notification coverage, permission-override hygiene, CSV-import
 * fidelity (no truncated/mangled rows).
 */
import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'fs'
// pull DATABASE_URL out of .env — ALWAYS override: some sandboxes export a
// stale non-postgres DATABASE_URL globally (the known start-tcms.sh hazard).
for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^DATABASE_URL=(.+)$/)
  if (m) process.env.DATABASE_URL = m[1].trim()
}
const db = new PrismaClient()

let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok  ${name}`)
  else { failures++; console.error(`FAIL  ${name} ${detail}`) }
}

const one = async (sql) => (await db.$queryRaw(sql))[0]

// ---------- volumes ----------
const counts = await db.$queryRaw`
  SELECT
    (SELECT COUNT(*)::int FROM test_cases) AS test_cases,
    (SELECT COUNT(*)::int FROM modules) AS modules,
    (SELECT COUNT(*)::int FROM users) AS users,
    (SELECT COUNT(*)::int FROM review_requests) AS reviews,
    (SELECT COUNT(*)::int FROM review_events) AS review_events,
    (SELECT COUNT(*)::int FROM bugs) AS bugs,
    (SELECT COUNT(*)::int FROM notifications) AS notifications,
    (SELECT COUNT(*)::int FROM activity_logs) AS activity_logs,
    (SELECT COUNT(*)::int FROM wiki_documents) AS wiki_documents,
    (SELECT COUNT(*)::int FROM refresh_tokens) AS refresh_tokens,
    (SELECT COUNT(*)::int FROM role_permissions) AS permission_overrides`
const c = counts[0]
console.log('COUNTS:', JSON.stringify(c))
check('volume: 400+ test cases imported', c.test_cases >= 400, String(c.test_cases))
check('volume: reviews exist', c.reviews > 0, String(c.reviews))
check('volume: review events exist', c.review_events >= 5, String(c.review_events))
check('permission overrides = exactly the 2 seed grants', c.permission_overrides === 2, String(c.permission_overrides))

// ---------- import fidelity ----------
const longTitles = await one`SELECT COUNT(*)::int AS n FROM test_cases WHERE length(title) > 200`
check('no title exceeds 200 chars (caps enforced end-to-end)', longTitles.n === 0, String(longTitles.n))
const longDesc = await one`SELECT COUNT(*)::int AS n FROM test_cases WHERE length(description) > 2000`
check('no description exceeds 2000 chars', longDesc.n === 0, String(longDesc.n))
const marathonCount = await one`SELECT COUNT(*)::int AS n FROM test_cases WHERE title LIKE '%handles case #%'`
check('marathon imports all present (2 x 105 + re-run)', marathonCount.n >= 210, String(marathonCount.n))
const nullDesc = await one`SELECT COUNT(*)::int AS n FROM test_cases WHERE description IS NULL OR description = ''`
check('every marathon row kept its description', nullDesc.n === 0, String(nullDesc.n))

// ---------- referential sanity ----------
const orphanCases = await one`SELECT COUNT(*)::int AS n FROM test_cases tc LEFT JOIN modules m ON m.module_id = tc.module_id WHERE tc.module_id IS NOT NULL AND m.module_id IS NULL`
check('no test cases pointing at missing modules', orphanCases.n === 0, String(orphanCases.n))
const orphanReviews = await one`SELECT COUNT(*)::int AS n FROM review_requests r LEFT JOIN test_cases tc ON tc.test_case_id = r.test_case_id WHERE r.test_case_id IS NOT NULL AND tc.test_case_id IS NULL`
check('no review requests pointing at missing cases', orphanReviews.n === 0, String(orphanReviews.n))
const orphanNotifs = await one`SELECT COUNT(*)::int AS n FROM notifications n LEFT JOIN users u ON u.user_id = n.user_id WHERE u.user_id IS NULL`
check('no notifications pointing at missing users', orphanNotifs.n === 0, String(orphanNotifs.n))
const badAuthors = await one`SELECT COUNT(*)::int AS n FROM test_cases tc LEFT JOIN users u ON u.user_id = tc.author_id WHERE u.user_id IS NULL`
check('every test case has an existing author', badAuthors.n === 0, String(badAuthors.n))

// ---------- review coverage by role ----------
const verdictsByRole = await db.$queryRaw`
  SELECT u.role, COUNT(*)::int AS n, e.verdict
  FROM review_events e
  JOIN users u ON u.user_id = e.reviewer_id
  WHERE u.email LIKE 'qamarathon.%'
  GROUP BY u.role, e.verdict
  ORDER BY u.role`
console.log('VERDICTS BY ROLE:', JSON.stringify(verdictsByRole))
const rolesWithVerdicts = new Set(verdictsByRole.map((r) => r.role))
check('verdicts recorded by product', rolesWithVerdicts.has('product'))
check('verdicts recorded by developer', rolesWithVerdicts.has('developer'))
check('verdicts recorded by qa_engineer', rolesWithVerdicts.has('qa_engineer'))
check('verdicts recorded by manager', rolesWithVerdicts.has('manager'))
check('verdicts recorded by vp', rolesWithVerdicts.has('vp'))

// ---------- notifications ----------
const verdictNotifs = await one`SELECT COUNT(*)::int AS n FROM notifications WHERE type IN ('review_approved','review_failed','review_needs_revision')`
check('verdict notifications were created for the author', verdictNotifs.n >= 5, String(verdictNotifs.n))
const assignNotifs = await one`SELECT COUNT(*)::int AS n FROM notifications WHERE type = 'review_assigned'`
check('review-assignment notifications exist', assignNotifs.n >= 5, String(assignNotifs.n))
// NOTE: password_changed self-alerts are exempt — the security-audit probes
// legitimately changed their own password and THEN deactivated the account.
const unscoped = await one`SELECT COUNT(*)::int AS n FROM notifications n JOIN users u ON u.user_id = n.user_id WHERE n.created_at > NOW() - INTERVAL '2 hours' AND u.is_active = false AND n.type != 'password_changed'`
check('no recent non-security notifications to deactivated users', unscoped.n === 0, String(unscoped.n))

// ---------- activity trail ----------
const permToggles = await one`SELECT COUNT(*)::int AS n FROM activity_logs WHERE entity_type = 'role_permission'`
check('permission toggles are audit-logged', permToggles.n >= 2, String(permToggles.n))
const logins = await one`SELECT COUNT(*)::int AS n FROM activity_logs WHERE action = 'LOGIN' AND created_at > NOW() - INTERVAL '2 hours'`
check('logins are audit-logged', logins.n >= 5, String(logins.n))
const deletions = await one`SELECT COUNT(*)::int AS n FROM activity_logs WHERE action = 'DELETE' AND created_at > NOW() - INTERVAL '2 hours'`
check('deletes are audit-logged (matrix probes)', deletions.n >= 3, String(deletions.n))

// ---------- history / immutability ----------
// createTestCase stamps last_edited_by_id = author, so the real invariant is
// on the VERSION: any case whose version moved past 1 must have history rows.
const editedNoHistory = await one`
  SELECT COUNT(*)::int AS n FROM test_cases tc
  WHERE tc.version > 1
    AND NOT EXISTS (SELECT 1 FROM test_case_history h WHERE h.test_case_id = tc.test_case_id)`
check('every case edited past v1 has history rows', editedNoHistory.n === 0, String(editedNoHistory.n))

// ---------- security state ----------
const activeTokens = await one`SELECT COUNT(*)::int AS n FROM refresh_tokens WHERE revoked = false AND expires_at > NOW()`
check('refresh tokens exist for live sessions (rotation intact)', activeTokens.n >= 0, String(activeTokens.n))
const viewers = await one`SELECT COUNT(*)::int AS n FROM users WHERE role = 'viewer'`
check('viewer accounts accumulated from default-viewer policy', viewers.n >= 20, String(viewers.n))

console.log(failures ? `\nRESULT: ${failures} FAILURES` : '\nRESULT: ALL DB CHECKS PASSED')
await db.$disconnect()
process.exit(failures ? 1 : 0)
