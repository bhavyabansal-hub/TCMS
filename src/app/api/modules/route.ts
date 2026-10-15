// Controller for /api/modules — thin HTTP adapter.
// Parses the request, delegates to validators + services, returns responses.
// NO business logic and NO SQL live here.

import type { NextRequest } from 'next/server'
import { withApi, ok, ApiError, getQueryParams, extractRequestMeta } from '@/lib/api'
import { requireUser } from '@/lib/auth'
import {
  createModule,
  deleteModuleById,
  getModuleDetail,
  listModuleTree,
  submitModuleForReview,
  updateModuleFields,
} from './modules.service'
import {
  validateCreateModuleBody,
  validateSubmitModuleReviewBody,
  validateUpdateModuleBody,
} from './modules.validation'

/** GET /api/modules      -> { tree, flat } module tree
 *  GET /api/modules?id=… -> module detail (+ test cases, submodules, permissions)
 *      &caseOffset=N      -> page offset for the paged test-case lists */
export async function GET(req: NextRequest) {
  return withApi(req, async () => {
    await requireUser()
    const { id, caseOffset } = getQueryParams(req)
    if (id) {
      const offset = Number.parseInt(caseOffset ?? '', 10)
      return ok(await getModuleDetail(id, { caseOffset: Number.isFinite(offset) ? offset : 0 }))
    }
    return ok(await listModuleTree())
  })
}

/** POST /api/modules -> create module (creator becomes owner) */
export async function POST(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const body = await req.json().catch(() => ({}))
    const input = validateCreateModuleBody(body)
    return ok(await createModule(me, input, extractRequestMeta(req)))
  })
}

/** PUT /api/modules?id=…&action=submit-review -> module-level review submission
 *  PUT /api/modules?id=…                      -> update name/description/owner */
export async function PUT(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const { id, action } = getQueryParams(req)
    if (!id) throw ApiError.badRequest('Missing module id')
    const body = await req.json().catch(() => ({}))
    if (action === 'submit-review') {
      const input = validateSubmitModuleReviewBody(body)
      return ok(await submitModuleForReview(me, id, input, extractRequestMeta(req)))
    }
    const input = validateUpdateModuleBody(body)
    return ok(await updateModuleFields(me, id, input, extractRequestMeta(req)))
  })
}

/** DELETE /api/modules?id=… -> hard delete (creator or team_lead/admin only) */
export async function DELETE(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const { id } = getQueryParams(req)
    if (!id) throw ApiError.badRequest('Missing module id')
    return ok(await deleteModuleById(me, id, extractRequestMeta(req)))
  })
}
