// One-off ops helper: clear brute-force lockouts left by failed test phases.
import { PrismaClient } from '/home/z/my-project/node_modules/@prisma/client/default.js'
const db = new PrismaClient()
const r = await db.$executeRawUnsafe("DELETE FROM login_attempts")
console.log('login_attempts cleared:', r)
await db.$disconnect()
