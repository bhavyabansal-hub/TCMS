// Shared id generator for MySQL repositories.
// PostgreSQL generated PKs in the DB (gen_random_uuid()). MySQL 8.4 has no
// RETURNING, so INSERTs supply the uuid from the app; the column's
// DEFAULT (uuid()) remains as a safety net for any raw INSERT that omits it.
import { randomUUID } from 'node:crypto'

export function newId(): string {
  return randomUUID()
}
