// Users repository — raw SQL data access for user administration
// (filter/list/paginate, insert, partial update, soft delete).
// Cross-cutting user lookups (findUserById / findUserByEmail /
// findFirstActiveReviewer) live in src/lib/server/user.repository — import
// them from there, never duplicate them here.

import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { insertReturningId } from '@/lib/server/insert'
import type { UserSqlRow } from '@/types/sql-rows'

export interface UserFilters {
  role?: string
  isActive?: boolean
}

function buildWhere(filters: UserFilters): Prisma.Sql {
  const parts: Prisma.Sql[] = []
  if (filters.role) parts.push(Prisma.sql`role = ${filters.role}`)
  if (filters.isActive !== undefined) parts.push(Prisma.sql`is_active = ${filters.isActive}`)
  return parts.length ? Prisma.sql`WHERE ${Prisma.join(parts, ' AND ')}` : Prisma.empty
}

export async function countUsers(filters: UserFilters): Promise<number> {
  const rows = await db.$queryRaw<{ total: number | bigint }[]>`
    SELECT COUNT(*) AS total FROM users ${buildWhere(filters)}`
  return Number(rows[0]?.total ?? 0)
}

/** Legacy ordering kept: oldest accounts first (created_at ASC). */
export async function listUsers(
  filters: UserFilters,
  limit: number,
  offset: number
): Promise<UserSqlRow[]> {
  return db.$queryRaw<UserSqlRow[]>(Prisma.sql`
    SELECT * FROM users ${buildWhere(filters)}
    ORDER BY created_at ASC
    LIMIT ${limit} OFFSET ${offset}`)
}

export interface UserOptionRow {
  user_id: string
  full_name: string
  role: string
}

/** Picker rows for assignment/reviewer dropdowns — active users only,
 *  minimal columns (no emails / hashes / flags), alphabetical. */
export async function listUserOptionRows(): Promise<UserOptionRow[]> {
  return db.$queryRaw<UserOptionRow[]>`
    SELECT user_id, full_name, role
    FROM users
    WHERE is_active = true
    ORDER BY full_name ASC`
}

export interface UserInsert {
  email: string
  fullName: string
  passwordHash: string
  role: string
}

export async function insertUser(input: UserInsert): Promise<UserSqlRow> {
  // MySQL has no RETURNING: insert, take the new key from LAST_INSERT_ID(), then read back.
  const userId = await insertReturningId(Prisma.sql`
    INSERT INTO users (email, full_name, password_hash, role, created_at, updated_at)
    VALUES (${input.email}, ${input.fullName}, ${input.passwordHash}, ${input.role}, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`)
  const rows = await db.$queryRaw<UserSqlRow[]>`
    SELECT * FROM users WHERE user_id = ${userId} LIMIT 1`
  if (!rows[0]) throw new Error('Inserted user could not be read back')
  return rows[0]
}

export interface UserUpdateFields {
  fullName?: string
  role?: string
  isActive?: boolean
  avatarUrl?: string | null
}

/** Partial UPDATE — every write also bumps updated_at (raw SQL skips @updatedAt).
 *  MySQL: UPDATE has no RETURNING — write, then read the row back. */
export async function updateUser(userId: string, fields: UserUpdateFields): Promise<UserSqlRow> {
  const sets: Prisma.Sql[] = []
  if (fields.fullName !== undefined) sets.push(Prisma.sql`full_name = ${fields.fullName}`)
  if (fields.role !== undefined) sets.push(Prisma.sql`role = ${fields.role}`)
  if (fields.isActive !== undefined) sets.push(Prisma.sql`is_active = ${fields.isActive}`)
  if (fields.avatarUrl !== undefined) sets.push(Prisma.sql`avatar_url = ${fields.avatarUrl}`)
  sets.push(Prisma.sql`updated_at = UTC_TIMESTAMP(3)`)

  await db.$executeRaw`
    UPDATE users SET ${Prisma.join(sets)} WHERE user_id = ${userId}`
  const rows = await db.$queryRaw<UserSqlRow[]>`
    SELECT * FROM users WHERE user_id = ${userId} LIMIT 1`
  if (!rows[0]) throw new Error('Updated user could not be read back')
  return rows[0]
}

/** Soft delete — users are NEVER hard-deleted (FK restricts + audit history). */
export async function deactivateUser(userId: string): Promise<void> {
  await db.$executeRaw`
    UPDATE users SET is_active = false, updated_at = UTC_TIMESTAMP(3)
    WHERE user_id = ${userId}`
}
