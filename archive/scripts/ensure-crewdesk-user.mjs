// One-time (idempotent) ensure for the designated Crew Desk test user.
// Safe to re-run: upserts by email, never touches existing rows otherwise.
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const db = new PrismaClient()
const EMAIL = 'bhavya.bansal@shipglobal.in'

const user = await db.user.upsert({
  where: { email: EMAIL },
  update: {}, // exists -> leave untouched (password may have been changed)
  create: {
    email: EMAIL,
    fullName: 'Bhavya Bansal',
    passwordHash: await bcrypt.hash('Bhavya@12345', 10),
    role: 'qa_engineer',
    isActive: true,
  },
})

console.log(`[ensure-crewdesk-user] ok: ${user.email} (${user.userId}, role=${user.role}, active=${user.isActive})`)
await db.$disconnect()
