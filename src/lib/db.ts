import { PrismaClient } from '@prisma/client'
import { IS_PRODUCTION } from '@/lib/server/config'

// SINGLETON CONNECTION (design principle):
// exactly ONE PrismaClient instance exists per runtime. In development the
// instance is cached on globalThis so Next.js hot reload reuses the same
// connection pool instead of opening a new one per code change (which would
// exhaust MySQL's max_connections). In production there is a single
// module registry, so the module-level export is the singleton.
//
// POOL SIZING (load principle): Prisma derives the per-process pool from the
// connection string — scripts/start-tcms.sh ships a default DATABASE_URL with
// `connection_limit=40&pool_timeout=10` (sized from the 50-VU load test: 20
// starved the hot read paths on a 2-core box) so a busy instance waits and
// errors cleanly instead of opening unbounded connections.

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    // LOAD: 'query' logging writes one stdout line per SQL statement — useful
    // for local debugging, but pure I/O overhead (and log noise) under
    // production load, so production keeps only error logging.
    log: IS_PRODUCTION ? ['error'] : ['query', 'error'],
  })

if (!IS_PRODUCTION) globalForPrisma.prisma = db
