// MySQL / Prisma error → clean API error (backlog B3). Pure module (no imports), so
// withApi can use it and scripts/verify-db-errors.mjs can test it with real errors.
//
// Rule: the client only ever gets the fixed human message below — never SQL text,
// table/column names or the driver message. The original error is logged server-side.
//
// Prisma shapes (duck-typed, no class import):
//   raw SQL failure        → PrismaClientKnownRequestError code 'P2010', meta.code = MySQL errno
//                            (also "Code: `1062`" inside the message)
//   model-style failures   → P2002 unique, P2003 foreign key, P2000 value too long
//   pool exhausted         → P2024
//   server unreachable     → PrismaClientInitializationError / P1001 / P1002 / P1017

export interface MappedDbError {
  status: 400 | 409 | 503
  message: string
  /** Short machine label for the server log (never sent to the client). */
  kind: string
}

const MYSQL_ERRNO: Record<string, MappedDbError> = {
  '1062': { status: 409, kind: 'duplicate_key', message: 'This record already exists — one of its values must be unique.' },
  '1451': { status: 409, kind: 'fk_in_use', message: 'This item is still used by other records and cannot be removed.' },
  '1452': { status: 400, kind: 'fk_missing', message: 'A referenced item does not exist — check the selected module, user or test case.' },
  '1406': { status: 400, kind: 'too_long', message: 'A value is too long for its field.' },
  '1048': { status: 400, kind: 'not_null', message: 'A required value is missing.' },
  '1264': { status: 400, kind: 'out_of_range', message: 'A value is out of range.' },
  '1366': { status: 400, kind: 'bad_value', message: 'A value has the wrong format.' },
  '1292': { status: 400, kind: 'bad_value', message: 'A value has the wrong format.' },
  '3140': { status: 400, kind: 'bad_json', message: 'A value has the wrong format.' },
  '1213': { status: 409, kind: 'deadlock', message: 'Someone else is saving the same item right now — try again.' },
  '1205': { status: 409, kind: 'lock_timeout', message: 'Someone else is saving the same item right now — try again.' },
  '2002': { status: 503, kind: 'db_down', message: 'The database is unavailable — try again shortly.' },
  '2003': { status: 503, kind: 'db_down', message: 'The database is unavailable — try again shortly.' },
  '2006': { status: 503, kind: 'db_down', message: 'The database is unavailable — try again shortly.' },
  '2013': { status: 503, kind: 'db_down', message: 'The database is unavailable — try again shortly.' },
}

const PRISMA_CODE: Record<string, MappedDbError> = {
  P2002: MYSQL_ERRNO['1062'],
  P2003: MYSQL_ERRNO['1452'],
  P2000: MYSQL_ERRNO['1406'],
  P2024: { status: 503, kind: 'pool_timeout', message: 'The server is busy — try again in a moment.' },
  P1001: MYSQL_ERRNO['2003'],
  P1002: MYSQL_ERRNO['2003'],
  P1017: MYSQL_ERRNO['2013'],
}

interface ErrorLike {
  name?: unknown
  code?: unknown
  errorCode?: unknown
  meta?: { code?: unknown } | null
  message?: unknown
}

/** MySQL errno of a Prisma raw-query error, or null. */
export function mysqlErrno(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null
  const e = err as ErrorLike
  if (e.meta && e.meta.code != null) return String(e.meta.code)
  const m = /Code: `(\d{4})`/.exec(String(e.message ?? ''))
  return m ? m[1] : null
}

/** Mapped error for a database failure, or null when `err` is not one. */
export function mapDatabaseError(err: unknown): MappedDbError | null {
  if (!err || typeof err !== 'object') return null
  const e = err as ErrorLike
  const name = String(e.name ?? '')
  if (!name.startsWith('PrismaClient')) return null
  const errno = mysqlErrno(err)
  if (errno && MYSQL_ERRNO[errno]) return MYSQL_ERRNO[errno]
  const code = String(e.code ?? e.errorCode ?? '')
  if (PRISMA_CODE[code]) return PRISMA_CODE[code]
  if (name === 'PrismaClientInitializationError') return MYSQL_ERRNO['2003']
  return null
}

export function isDuplicateKeyError(err: unknown): boolean {
  return mapDatabaseError(err)?.kind === 'duplicate_key'
}
