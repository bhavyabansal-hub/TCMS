// Remove TCMS CrewDeskLink row(s) for a dev test ticket so the link flow can
// be re-run cleanly (e.g. after a test comment carried a localhost URL).
// Scope guard: only touches rows whose ticketId matches the argument below.
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()
const TICKET = process.argv[2] || '1355'

const rows = await db.crewDeskLink.findMany({ where: { ticketId: TICKET } })
for (const r of rows) {
  console.log(`[cleanup] removing link ${r.linkId} (module ${r.moduleId}, comment ${r.crewdeskCommentId}, status ${r.status})`)
}
const res = await db.crewDeskLink.deleteMany({ where: { ticketId: TICKET } })
console.log(`[cleanup] deleted ${res.count} link row(s) for ticket ${TICKET}`)
await db.$disconnect()
