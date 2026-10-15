import { PrismaClient } from '/home/z/my-project/node_modules/@prisma/client/default.js'
process.env.DATABASE_URL = 'postgresql://tcms:tcms@localhost:5499/tcms'
const db = new PrismaClient()
const n = await db.$executeRawUnsafe("DELETE FROM test_cases WHERE title LIKE 'Bulk import case %'")
console.log('removed probe rows:', n)
await db.$disconnect()
