// Stamped fixture users for the REQ-001 writing suites (R6, R7), created by raw SQL
// (REQ-001 design (git history) 2.3, BE-R2): UTC_TIMESTAMP(3), notify_email = 0, notify_telegram = 0,
// passwords generated in memory and never printed. No ORM model call.
import { randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { Prisma } from '@prisma/client'
import { insertReturningId } from './db-guard.mjs'

/** Exact fixture e-mail: `<prefix>-<key>-<stamp>@tcms.test` (group J pattern `<prefix>-%-%@tcms.test`). */
export function fixtureEmail(prefix, key, stamp) {
  return `${prefix}-${key}-${stamp}@tcms.test`
}

/** In-memory password that satisfies the register policy (letter + digit, >= 6). */
function generatePassword() {
  return `Fx${randomBytes(18).toString('base64url')}9`
}

/**
 * Inserts one user per spec. Returns the specs enriched with userId + password.
 * @param {import('@prisma/client').PrismaClient} db guarded client
 * @param {{ key: string, email: string, name: string, role: string }[]} specs
 */
export async function createFixtureUsers(db, specs) {
  const created = []
  for (const spec of specs) {
    const password = generatePassword()
    const passwordHash = await bcrypt.hash(password, 10)
    const userId = await insertReturningId(db, Prisma.sql`
      INSERT INTO users (email, full_name, password_hash, role, is_active,
                         notify_email, notify_telegram, notify_inapp, created_at, updated_at)
      VALUES (${spec.email}, ${spec.name}, ${passwordHash}, ${spec.role}, 1,
              0, 0, 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`)
    created.push({ ...spec, userId, password })
  }
  return created
}

/** Looks up existing users by exact e-mail (recovery mode: no in-memory ids). */
export async function findUsersByEmails(db, emails) {
  if (emails.length === 0) return []
  return db.$queryRaw`
    SELECT user_id, email, role FROM users WHERE email IN (${Prisma.join(emails)})`
}
