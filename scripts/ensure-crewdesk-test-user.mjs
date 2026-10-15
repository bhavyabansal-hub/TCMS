// Idempotent TCMS test-user upsert for Crew Desk live testing.
// Usage: node scripts/ensure-crewdesk-test-user.mjs <email> <fullName> <password> <role>
// Safe to re-run: upserts by email; an EXISTING user is left untouched
// (password/role may have been changed deliberately).
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const db = new PrismaClient()
const [email, fullName, password, role = 'manager'] = process.argv.slice(2)
if (!email || !fullName || !password) {
  console.error('usage: node scripts/ensure-crewdesk-test-user.mjs <email> <fullName> <password> [role]')
  process.exit(1)
}

const user = await db.user.upsert({
  where: { email },
  update: {},
  create: {
    email,
    fullName,
    passwordHash: await bcrypt.hash(password, 10),
    role,
    isActive: true,
  },
})

console.log(`[ensure-crewdesk-test-user] ok: ${user.email} (${user.userId}, role=${user.role}, active=${user.isActive})`)
await db.$disconnect()
