// Shared logic for scripts/create-first-vp.mjs and its test (backlog B1).
// Raw SQL only; values are bind parameters. No function here logs anything.
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'

export const BCRYPT_ROUNDS = 10 // same cost as hashPassword() in src/lib/auth.ts
export const MIN_PASSWORD_LENGTH = 12
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Normalizes and checks the CLI input. Returns { email, fullName } or { error }. */
export function validateIdentity(rawEmail, rawName) {
  const email = String(rawEmail ?? '').trim().toLowerCase()
  const fullName = String(rawName ?? '').trim()
  if (!EMAIL_RE.test(email) || email.length > 254) return { error: 'a valid --email is required' }
  if (fullName.length < 2 || fullName.length > 120) return { error: '--name must be 2-120 characters' }
  return { email, fullName }
}

/** Password rule: app rule (letter + number) with a stronger minimum for the first admin. */
export function checkPasswordStrength(password) {
  if (password.length < MIN_PASSWORD_LENGTH) return `password must be at least ${MIN_PASSWORD_LENGTH} characters`
  if (!/[a-zA-Z]/.test(password)) return 'password must contain a letter'
  if (!/[0-9]/.test(password)) return 'password must contain a number'
  return null
}

export async function countActiveVps(q) {
  const rows = await q.$queryRaw`SELECT COUNT(*) AS n FROM users WHERE role = 'vp' AND is_active = 1`
  return Number(rows[0].n)
}

export async function isEmailTaken(q, email) {
  const rows = await q.$queryRaw`SELECT COUNT(*) AS n FROM users WHERE email = ${email}`
  return Number(rows[0].n) > 0
}

/** Inserts the VP (bcrypt hash computed here) and returns the new user id. */
export async function insertVp(q, { email, fullName, password }) {
  const userId = randomUUID()
  const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS)
  await q.$executeRaw`
    INSERT INTO users (user_id, email, full_name, password_hash, role, is_active, created_at, updated_at)
    VALUES (${userId}, ${email}, ${fullName}, ${passwordHash}, 'vp', 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`
  return userId
}

/**
 * The whole create step inside one transaction: re-checks "no active VP" and the email
 * under a named lock so two parallel runs cannot both create a VP.
 * @returns {Promise<{ userId?: string, refused?: string }>}
 */
export async function createFirstVp(db, identity, password) {
  const got = await db.$queryRaw`SELECT GET_LOCK('tcms_first_vp', 10) AS got`
  if (Number(got[0].got) !== 1) return { refused: 'another create-first-vp run is in progress' }
  try {
    return await db.$transaction(async (tx) => {
      if ((await countActiveVps(tx)) > 0) return { refused: 'an active VP already exists' }
      if (await isEmailTaken(tx, identity.email)) return { refused: 'a user with this email already exists' }
      return { userId: await insertVp(tx, { ...identity, password }) }
    })
  } finally {
    await db.$queryRaw`SELECT RELEASE_LOCK('tcms_first_vp') AS released`
  }
}
