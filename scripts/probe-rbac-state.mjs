// One-off probe: role_permissions overrides + review data state.
// Sandbox-only diagnostic (no psql in embedded-postgres).
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  const overrides = await db.$queryRaw`
    SELECT role, action, enabled, updated_by_id, updated_at
    FROM role_permissions ORDER BY role, action`
  console.log('=== role_permissions overrides ===')
  console.log(JSON.stringify(overrides, null, 1))

  const users = await db.$queryRaw`
    SELECT user_id, email, role, is_active FROM users ORDER BY email`
  console.log('=== users ===')
  for (const u of users) console.log(`${u.email}  role=${u.role}  active=${u.is_active}`)

  const counts = await db.$queryRaw`
    SELECT
      (SELECT COUNT(*)::int FROM review_requests) AS review_requests,
      (SELECT COUNT(*)::int FROM review_requests WHERE status IN ('pending','in_progress')) AS open_reviews,
      (SELECT COUNT(*)::int FROM module_review_requests) AS module_reviews,
      (SELECT COUNT(*)::int FROM module_review_requests WHERE status IN ('pending','in_progress')) AS open_module_reviews,
      (SELECT COUNT(*)::int FROM test_cases) AS test_cases,
      (SELECT COUNT(*)::int FROM modules) AS modules`
  console.log('=== data counts ===')
  console.log(JSON.stringify(counts[0], null, 1))

  const reviewers = await db.$queryRaw`
    SELECT u.email AS reviewer_email, u.role AS reviewer_role, r.status, COUNT(*)::int AS n
    FROM review_requests r JOIN users u ON u.user_id = r.reviewer_id
    GROUP BY u.email, u.role, r.status ORDER BY u.email`
  console.log('=== review_requests by reviewer ===')
  for (const r of reviewers) console.log(`${r.reviewer_email} (${r.reviewer_role})  ${r.status}  x${r.n}`)

  const mrev = await db.$queryRaw`
    SELECT u.email AS reviewer_email, u.role AS reviewer_role, m.status, m.cycle
    FROM module_review_requests m JOIN users u ON u.user_id = m.reviewer_id`
  console.log('=== module_review_requests ===')
  for (const r of mrev) console.log(`${r.reviewer_email} (${r.reviewer_role})  ${r.status}  cycle=${r.cycle}`)
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
