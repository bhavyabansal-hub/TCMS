// One-time cleanup: remove crew_desk_links rows whose module no longer exists.
// Module deletion now removes its links explicitly (modules.repository), so
// orphans should never accumulate again — this heals the existing table.
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()

async function main() {
  const before = await db.$queryRaw`SELECT count(*)::int AS total FROM crew_desk_links`
  const deleted = await db.$executeRaw`
    DELETE FROM crew_desk_links l
    WHERE NOT EXISTS (SELECT 1 FROM modules m WHERE m.module_id = l.module_id)`
  const after = await db.$queryRaw`SELECT count(*)::int AS total FROM crew_desk_links`
  console.log(`crew_desk_links: ${before[0].total} rows before, deleted ${deleted} orphans, ${after[0].total} rows remain`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
