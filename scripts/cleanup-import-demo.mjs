// Sandbox-only: removes the CSV-import E2E demo cases so the demo DB stays clean.
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const rows = await db.$queryRaw`SELECT test_case_id FROM test_cases WHERE title LIKE 'Imported: %'`
  if (rows.length === 0) { console.log('CLEAN: no import demo cases found'); return }
  for (const id of rows.map((r) => r.test_case_id)) {
    await db.$executeRaw`DELETE FROM review_events WHERE review_request_id IN (SELECT review_request_id FROM review_requests WHERE test_case_id = ${id})`
    await db.$executeRaw`DELETE FROM review_requests WHERE test_case_id = ${id}`
    await db.$executeRaw`DELETE FROM test_case_history WHERE test_case_id = ${id}`
    await db.$executeRaw`DELETE FROM bug_test_case_links WHERE test_case_id = ${id}`
    await db.$executeRaw`DELETE FROM activity_logs WHERE entity_id = ${id}`
    await db.$executeRaw`DELETE FROM test_cases WHERE test_case_id = ${id}`
  }
  console.log(`CLEAN: removed ${rows.length} import demo cases`)
}
main().finally(() => db.$disconnect())
