// Health controller — public liveness probe for the Next.js app itself.
// (Database liveness is reported separately by /api/keep-alive.)

import type { NextRequest } from 'next/server'
import { withApi, ok } from '@/lib/api'

export async function GET(req: NextRequest) {
  return withApi(req, async () => ok({ status: 'ok', service: 'tcms-api' }))
}
