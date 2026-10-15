// Sandbox maintenance: hard-delete self-test bugs (battery leftovers) and their
// referencing rows, child-first (notifications -> activity_logs -> bugs).
// Matches battery artifacts by title pattern: 'Verify notification *' / 'dbg *'.
// Usage:  node scripts/cleanup-selftest-bugs.mjs
// Requires DATABASE_URL in the environment.
import { PrismaClient, Prisma } from '@prisma/client'

const prisma = new PrismaClient()

const bigints = (obj) => JSON.parse(JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? Number(v) : v)))

async function main() {
  const bugs = await prisma.$queryRaw`
    SELECT bug_id, title FROM bugs
    WHERE title ILIKE 'verify notification %' OR title ILIKE 'dbg %'
    ORDER BY created_at`
  if (bugs.length === 0) {
    console.log('no self-test bugs found')
    return
  }
  const ids = bugs.map((b) => b.bug_id)

  const n = await prisma.$executeRaw`
    DELETE FROM notifications
    WHERE entity_type = 'bug' AND entity_id IN (${Prisma.join(ids)})`
  const a = await prisma.$executeRaw`
    DELETE FROM activity_logs
    WHERE entity_type = 'bug' AND entity_id IN (${Prisma.join(ids)})`
  const b = await prisma.$executeRaw`
    DELETE FROM bugs
    WHERE bug_id IN (${Prisma.join(ids)})`

  console.log(`DELETED bugs=${b} notification_refs=${n} activity_refs=${a}`)
  for (const bug of bugs) console.log(`  - ${bug.title}`)
  const remaining = bigints(
    await prisma.$queryRaw`SELECT COUNT(*)::int AS n FROM bugs WHERE title ILIKE 'verify notification %' OR title ILIKE 'dbg %'`
  )
  console.log('remaining self-test bugs:', JSON.stringify(remaining))
}

main()
  .catch((e) => {
    console.error('CLEANUP FAIL:', e.message)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
