// Controller for /api/bugs — thin HTTP adapter.
// Parses the request, delegates to validators + services, returns responses.
// NO business logic and NO SQL live here.

import type { NextRequest } from 'next/server'
import { withApi, ok, ApiError, getQueryParams, extractRequestMeta } from '@/lib/api'
import { requireUser } from '@/lib/auth'
import {
  createBug,
  deleteBug,
  getBug,
  getBugTestCaseLinks,
  linkTestCaseToBug,
  listBugsPaginated,
  updateBugFields,
} from './bugs.service'
import {
  validateCreateBugBody,
  validateLinkTestCaseBody,
  validateUpdateBugBody,
} from './bugs.validation'

/** GET /api/bugs                     -> paginated list (filters + search)
 *  GET /api/bugs?id=...              -> single bug (with its test-case links)
 *  GET /api/bugs?id=...&action=links -> the test cases linked to this bug */
export async function GET(req: NextRequest) {
  return withApi(req, async () => {
    await requireUser()
    const q = getQueryParams(req)
    if (q.id && q.action === 'links') return ok(await getBugTestCaseLinks(q.id))
    if (q.id) return ok(await getBug(q.id))
    return ok(await listBugsPaginated(q))
  })
}

/** POST /api/bugs -> create bug (reported by the current user) */
export async function POST(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const body = await req.json().catch(() => ({}))
    const input = validateCreateBugBody(body)
    return ok(await createBug(me, input, extractRequestMeta(req)))
  })
}

/** PUT /api/bugs?id=...&action=link-tc -> link one test case (idempotent)
 *  PUT /api/bugs?id=...                 -> update bug (testCaseIds in the
 *                                          body REPLACE the links) */
export async function PUT(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const { id, action } = getQueryParams(req)
    if (!id) throw ApiError.badRequest('Missing bug id')
    const body = await req.json().catch(() => ({}))
    if (action === 'link-tc') {
      return ok(await linkTestCaseToBug(me, id, validateLinkTestCaseBody(body)))
    }
    const input = validateUpdateBugBody(body)
    return ok(await updateBugFields(me, id, input, extractRequestMeta(req)))
  })
}

/** DELETE /api/bugs?id=... -> HARD delete (admin only — the only one in the app) */
export async function DELETE(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const { id } = getQueryParams(req)
    return ok(await deleteBug(me, id, extractRequestMeta(req)))
  })
}
