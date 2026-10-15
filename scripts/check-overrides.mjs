// Sandbox-only: shows current role_permissions override rows.
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const rows = await db.$queryRaw`SELECT role, action, enabled, source FROM role_permissions ORDER BY role, action`
console.log('override rows:', JSON.stringify(rows))
await db.$disconnect()
