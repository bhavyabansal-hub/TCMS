// Controller for /api/search — thin HTTP adapter.
// GET /api/search?q=...&limit=5 -> grouped global search results.
// Read-only and gated behind requireUser like every other endpoint.

import type { NextRequest } from 'next/server'
import { withApi, ok, getQueryParams } from '@/lib/api'
import { requireUser } from '@/lib/auth'
import { globalSearch } from './search.service'
import { validateSearchQuery } from './search.validation'

export async function GET(req: NextRequest) {
  return withApi(req, async () => {
    await requireUser()
    const q = getQueryParams(req)
    const { q: term, limit } = validateSearchQuery(q)
    return ok(await globalSearch(term, limit))
  })
}
