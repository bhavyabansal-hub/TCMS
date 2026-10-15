// Sandbox-only: clears the login lock for one email (used by verify-rbac.sh).
// Usage: node scripts/clear-login-lock.mjs <email>
import { PrismaClient } from '@prisma/client'

const email = process.argv[2]
if (!email) {
  console.error('usage: node scripts/clear-login-lock.mjs <email>')
  process.exit(1)
}

const db = new PrismaClient()
try {
  const n = await db.$executeRaw`DELETE FROM login_attempts WHERE email = ${email}`
  console.log(`lock cleared for ${email}: ${n} row(s)`)
} finally {
  await db.$disconnect()
}
