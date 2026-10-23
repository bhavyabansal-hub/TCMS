import { PrismaClient } from '@prisma/client'
import {
  DATABASE_URL,
  DB_CONNECTION_LIMIT,
  DB_CONNECTION_LIMIT_SET,
  DB_POOL_TIMEOUT_SECONDS,
  IS_PRODUCTION,
  LOG_SQL,
} from '@/lib/server/config'

// SINGLETON CONNECTION (design principle):
// exactly ONE PrismaClient instance exists per runtime. In development the
// instance is cached on globalThis so Next.js hot reload reuses the same
// connection pool instead of opening a new one per code change (which would
// exhaust MySQL's max_connections). In production there is a single
// module registry, so the module-level export is the singleton.
//
// POOL SIZING (load principle): the pool is bounded per process. The URL's own
// `connection_limit` / `pool_timeout` are kept; when missing, the defaults from
// config.ts apply (40 connections, 10 s wait), and TCMS_DB_CONNECTION_LIMIT
// overrides explicitly. A busy instance then queues and answers 503 "server
// busy" instead of opening unbounded connections.

/** DATABASE_URL with the pool parameters filled in (never logged). */
function withPoolDefaults(url: string): string {
  try {
    const parsed = new URL(url)
    if (DB_CONNECTION_LIMIT_SET || !parsed.searchParams.has('connection_limit')) {
      parsed.searchParams.set('connection_limit', String(DB_CONNECTION_LIMIT))
    }
    if (!parsed.searchParams.has('pool_timeout')) {
      parsed.searchParams.set('pool_timeout', String(DB_POOL_TIMEOUT_SECONDS))
    }
    return parsed.toString()
  } catch {
    return url // unparsable: let Prisma report it
  }
}

/** The effective pool settings, safe to log (numbers only). */
export function describePool(): { connectionLimit: number | null; poolTimeoutSeconds: number | null } {
  try {
    const parsed = new URL(withPoolDefaults(DATABASE_URL))
    return {
      connectionLimit: Number(parsed.searchParams.get('connection_limit')),
      poolTimeoutSeconds: Number(parsed.searchParams.get('pool_timeout')),
    }
  } catch {
    return { connectionLimit: null, poolTimeoutSeconds: null }
  }
}

// READABLE NUMERIC IDS (Phase 5): keys are INT UNSIGNED in MySQL, but the whole app
// (services, API, UI, URLs) handles ids as digit strings ("42"). This one hook turns
// every number in a column named `id` or `*_id` of every raw-query row into a string,
// so a row id always compares equal to an id from a URL, the session or a request body.
// Writes need nothing: MySQL compares and stores '42' in an INT column as 42.
function idsAsStrings(row: unknown): unknown {
  if (!row || typeof row !== 'object') return row
  const record = row as Record<string, unknown>
  for (const key of Object.keys(record)) {
    const value = record[key]
    if ((key === 'id' || key.endsWith('_id')) && (typeof value === 'number' || typeof value === 'bigint')) {
      record[key] = String(value)
    }
  }
  return record
}

function createClient(): PrismaClient {
  const base = new PrismaClient({
    ...(DATABASE_URL ? { datasources: { db: { url: withPoolDefaults(DATABASE_URL) } } } : {}),
    // LOAD: 'query' logging writes one stdout line per SQL statement — useful
    // for debugging, but pure I/O overhead and log noise, so it is OFF unless
    // TCMS_LOG_SQL=true (any environment).
    log: LOG_SQL ? ['query', 'error'] : ['error'],
  })
  const extended = base.$extends({
    query: {
      async $queryRaw({ args, query }) {
        const rows = await query(args)
        return Array.isArray(rows) ? rows.map(idsAsStrings) : rows
      },
    },
  })
  // Typed as the plain client: the extension changes values, not the API surface.
  return extended as unknown as PrismaClient
}

const globalForPrisma = globalThis as unknown as {
  tcmsDb: PrismaClient | undefined
  prisma: PrismaClient | undefined
}

// Dev hot reload keeps the client on globalThis. A client left there by an older code
// version (key `prisma`, without the id hook) is closed once and replaced.
if (globalForPrisma.prisma && !globalForPrisma.tcmsDb) {
  void globalForPrisma.prisma.$disconnect().catch(() => undefined)
  globalForPrisma.prisma = undefined
}

export const db = globalForPrisma.tcmsDb ?? createClient()

if (!IS_PRODUCTION) globalForPrisma.tcmsDb = db
