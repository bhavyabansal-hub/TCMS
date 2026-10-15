import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const links = await p.$queryRaw`SELECT * FROM "crew_desk_links" ORDER BY created_at DESC LIMIT 10`
console.log(JSON.stringify(links, null, 1))
await p.$disconnect()
