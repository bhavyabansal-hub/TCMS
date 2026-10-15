// One-time (idempotent) ensure for the DEV-environment Crew Desk test user.
// Mirrors scripts/ensure-crewdesk-user.mjs (prod designee bhavya) but for the
// dev backend identity: tejas.singh@shipglobal.in = Crew Desk user 22 on
// https://dev.eng4.back.shipgl.in. Role `manager` holds manage_integrations
// by default, which the Integrations workspace requires.
// Safe to re-run: upserts by email, never touches an existing row's password.
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const db = new PrismaClient()
const EMAIL = 'tejas.singh@shipglobal.in'

const user = await db.user.upsert({
  where: { email: EMAIL },
  update: {}, // exists -> leave untouched (password may have been changed)
  create: {
    email: EMAIL,
    fullName: 'Tejas kumar singh',
    passwordHash: await bcrypt.hash('Tejas@12345', 10),
    role: 'manager',
    isActive: true,
  },
})

console.log(`[ensure-crewdesk-user-dev] ok: ${user.email} (${user.userId}, role=${user.role}, active=${user.isActive})`)
await db.$disconnect()
