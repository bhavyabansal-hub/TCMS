// Readiness controller — public probe: 200 when the app AND the database answer,
// 503 otherwise (src/app/api/ready/ready.service.ts).

import type { NextRequest } from 'next/server'
import { getQueryParams, ok, withApi } from '@/lib/api'
import { checkReadiness } from './ready.service'
import { validateReadyQuery } from './ready.validation'

export async function GET(req: NextRequest) {
  return withApi(req, async () => {
    validateReadyQuery(getQueryParams(req))
    return ok(await checkReadiness())
  })
}
