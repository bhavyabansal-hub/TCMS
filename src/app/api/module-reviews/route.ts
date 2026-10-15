// Controller for /api/module-reviews — thin HTTP adapter.
// Parses the request, delegates to validators + services, returns responses.
// NO business logic and NO SQL live here.

import type { NextRequest } from 'next/server'
import { withApi, ok, ApiError, getQueryParams, extractRequestMeta } from '@/lib/api'
import { requireUser } from '@/lib/auth'
import {
  approveAllCaseReviews,
  bulkCaseReviewVerdict,
  changeModuleReviewer,
  getMyModuleReviewQueue,
  getModuleReviewDetail,
  listAllModuleReviews,
} from './module-reviews.service'
import {
  validateApproveAllBody,
  validateBulkVerdictBody,
  validateChangeReviewerBody,
} from './module-reviews.validation'

/** GET /api/module-reviews?id=...       -> single module review with case reviews
 *  GET /api/module-reviews?action=queue -> my pending module reviews
 *  GET /api/module-reviews?action=all   -> all module reviews (admin/team_lead) */
export async function GET(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const q = getQueryParams(req)
    if (q.id && !q.action) return ok(await getModuleReviewDetail(me, q.id))
    if (q.action === 'queue') return ok(await getMyModuleReviewQueue(me))
    if (q.action === 'all') return ok(await listAllModuleReviews(me))
    throw ApiError.badRequest('Unknown action')
  })
}

/** POST /api/module-reviews?id=...&action=approve-all      -> legacy bulk approve
 *  POST /api/module-reviews?id=...&action=bulk-verdict     -> one verdict (approved/
 *                                                             failed/needs_revision) for
 *                                                             every open case review
 *  POST /api/module-reviews?id=...&action=change-reviewer  -> reassign module + open
 *                                                             case reviews to a new user */
export async function POST(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const { id, action } = getQueryParams(req)
    if (!id) throw ApiError.badRequest('Missing module review id')
    const body = await req.json().catch(() => ({}))
    if (action === 'approve-all') {
      const input = validateApproveAllBody(body)
      return ok(await approveAllCaseReviews(me, id, input, extractRequestMeta(req)))
    }
    if (action === 'bulk-verdict') {
      const input = validateBulkVerdictBody(body)
      return ok(await bulkCaseReviewVerdict(me, id, input, extractRequestMeta(req)))
    }
    if (action === 'change-reviewer') {
      const input = validateChangeReviewerBody(body)
      return ok(await changeModuleReviewer(me, id, input, extractRequestMeta(req)))
    }
    throw ApiError.badRequest('Unknown action')
  })
}
