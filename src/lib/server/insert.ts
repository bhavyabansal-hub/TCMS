// INSERT + read back the new AUTO_INCREMENT key (Phase 5, numeric ids).
//
// MySQL has no RETURNING, and LAST_INSERT_ID() is PER CONNECTION: read on another
// pooled connection it would return some other row's id. So the INSERT and the
// SELECT LAST_INSERT_ID() always run on ONE connection — the caller's transaction,
// or a short transaction opened here. Proven by scripts/verify-numeric-ids.mjs
// (50 parallel creates, every returned id belongs to its own row).
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'

type Executor = Prisma.TransactionClient

async function insertOnConnection(client: Executor, statement: Prisma.Sql): Promise<string> {
  await client.$executeRaw(statement)
  const rows = await client.$queryRaw<{ id: bigint | number | string }[]>`SELECT LAST_INSERT_ID() AS id`
  const id = rows[0]?.id
  if (id === undefined || id === null || String(id) === '0') throw new Error('INSERT returned no AUTO_INCREMENT id')
  return String(id)
}

/** Runs one single-row INSERT and returns its new key as a digit string ("42").
 *  Pass the transaction client when inside a transaction; with the root `db`
 *  (or nothing) a transaction is opened just for this statement. */
export async function insertReturningId(statement: Prisma.Sql, client: Executor = db): Promise<string> {
  if (client === (db as unknown as Executor)) {
    return db.$transaction((tx) => insertOnConnection(tx, statement))
  }
  return insertOnConnection(client, statement)
}
