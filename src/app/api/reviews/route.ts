// Controller for /api/reviews — thin HTTP adapter.
// Parses the request, delegates to validators + services, returns responses.
// NO business logic and NO SQL live here.

import type { NextRequest } from 'next/server'
import { withApi, ok, ApiError, getQueryParams, extractRequestMeta } from '@/lib/api'
import { requireUser } from '@/lib/auth'
import {
  forwardReview,
  getReviewDetail,
  listReviewQueue,
  listReviewsPaginated,
  submitVerdict,
} from './reviews.service'
import { validateForwardBody, validateVerdictBody } from './reviews.validation'

/** GET /api/reviews?id=...      -> single review (with testCase + events)
 *  GET /api/reviews?action=queue -> my pending/in_progress reviews
 *  GET /api/reviews              -> paginated list (status/reviewerId/testCaseId) */
export async function GET(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const q = getQueryParams(req)
    if (q.id && !q.action) return ok(await getReviewDetail(me, q.id))
    if (q.action === 'queue') return ok(await listReviewQueue(me))
    return ok(await listReviewsPaginated(me, q))
  })
}

/** POST /api/reviews?id=...&action=forward -> re-assign the review to another user
 *  POST /api/reviews?id=...                -> submit a verdict for the review */
export async function POST(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const { id, action } = getQueryParams(req)
    if (!id) throw ApiError.badRequest('Missing review id')
    const body = await req.json().catch(() => ({}))
    if (action === 'forward') {
      const input = validateForwardBody(body)
      return ok(await forwardReview(me, id, input, extractRequestMeta(req)))
    }
    const input = validateVerdictBody(body)
    return ok(await submitVerdict(me, id, input, extractRequestMeta(req)))
  })
}
