// Controller for /api/seed — thin HTTP adapter.
// Demo-data generator: idempotent (no-ops when any user exists).
//
// SECURITY: the endpoint is DISABLED unless the deployment explicitly opts in
// with TCMS_ENABLE_SEED=true in .env. A fresh production deployment must never
// be seedable by a stranger hitting the URL; local/dev environments that want
// the bootstrap flip the flag deliberately. When the database already has
// users the service no-ops regardless (defense in depth).

import type { NextRequest } from 'next/server'
import { withApi, ok, forbidden } from '@/lib/api'
import { ENABLE_SEED } from '@/lib/server/config'
import { seedDemoData } from './seed.service'
import { validateSeedRequest } from './seed.validation'

/** GET /api/seed -> same as POST (browser-address-bar friendly). */
export async function GET(req: NextRequest) {
  return POST(req)
}

/** POST /api/seed -> seed demo data (no body, no query params). */
export async function POST(req: NextRequest) {
  return withApi(req, async () => {
    if (!ENABLE_SEED) {
      return forbidden('Seeding is disabled on this deployment (set TCMS_ENABLE_SEED=true in .env to allow it).')
    }
    validateSeedRequest()
    return ok(await seedDemoData())
  })
}
