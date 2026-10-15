// Sandbox-only: removes E2E-verification test cases (and children) so the
// demo database stays clean. NOT part of the deliverable project.
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  const rows = await db.$queryRaw`
    SELECT test_case_id FROM test_cases WHERE title LIKE 'E2E JSONB verification case%'`
  if (rows.length === 0) {
    console.log('CLEAN: no E2E cases found')
    return
  }
  // children first, then the case itself (raw SQL, parameterized)
  for (const id of rows.map((r) => r.test_case_id)) {
    await db.$executeRaw`DELETE FROM review_events WHERE review_request_id IN (SELECT review_request_id FROM review_requests WHERE test_case_id = ${id})`
    await db.$executeRaw`DELETE FROM review_requests WHERE test_case_id = ${id}`
    await db.$executeRaw`DELETE FROM test_case_history WHERE test_case_id = ${id}`
    await db.$executeRaw`DELETE FROM bug_test_case_links WHERE test_case_id = ${id}`
    await db.$executeRaw`DELETE FROM test_cases WHERE test_case_id = ${id}`
  }
  console.log(`CLEAN: removed ${rows.length} E2E test cases`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
