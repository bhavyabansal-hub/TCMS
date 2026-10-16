// Readiness controller — public probe: 200 when the app AND the database answer,
// 503 otherwise. No input, so no validator (same as the liveness probe GET /api).

import type { NextRequest } from 'next/server'
import { ok, withApi } from '@/lib/api'
import { checkReadiness } from './ready.service'

export async function GET(req: NextRequest) {
  return withApi(req, async () => ok(await checkReadiness()))
}
