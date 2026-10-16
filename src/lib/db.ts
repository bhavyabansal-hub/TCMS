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

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    ...(DATABASE_URL ? { datasources: { db: { url: withPoolDefaults(DATABASE_URL) } } } : {}),
    // LOAD: 'query' logging writes one stdout line per SQL statement — useful
    // for debugging, but pure I/O overhead and log noise, so it is OFF unless
    // TCMS_LOG_SQL=true (any environment).
    log: LOG_SQL ? ['query', 'error'] : ['error'],
  })

if (!IS_PRODUCTION) globalForPrisma.prisma = db
