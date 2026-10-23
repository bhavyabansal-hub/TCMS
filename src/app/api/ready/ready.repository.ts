// Readiness repository — the one query that proves the database answers.

import { db } from '@/lib/db'

/** Round-trip to MySQL on the app's own pool; resolves when the server answers. */
export async function pingDatabase(): Promise<void> {
  await db.$queryRaw`SELECT 1 AS ok`
}
