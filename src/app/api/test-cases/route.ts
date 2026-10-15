// Controller for /api/test-cases — thin HTTP adapter.
// Parses the request, delegates to validators + services, returns responses.
// NO business logic and NO SQL live here.

import type { NextRequest } from 'next/server'
import { withApi, ok, ApiError, getQueryParams, extractRequestMeta } from '@/lib/api'
import { requireUser } from '@/lib/auth'
import {
  createTestCase,
  deleteTestCasePermanently,
  deleteTestCasesPermanently,
  getTestCase,
  getTestCaseHistory,
  getTestCaseReviews,
  getTestCasesImportTemplate,
  importTestCasesFromCsv,
  listTestCasesPaginated,
  submitTestCaseForReview,
  updateTestCaseFields,
} from './test-cases.service'
import {
  validateBulkDeleteBody,
  validateCreateTestCaseBody,
  validateImportTestCasesBody,
  validateSubmitReviewBody,
  validateUpdateTestCaseBody,
} from './test-cases.validation'

/** GET /api/test-cases                            -> paginated list (filters + search)
 *  GET /api/test-cases?action=import-template     -> sample CSV for the Import tab
 *  GET /api/test-cases?id=...                     -> single test case
 *  GET /api/test-cases?id=...&action=history      -> version history
 *  GET /api/test-cases?id=...&action=reviews      -> review cycles */
export async function GET(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const q = getQueryParams(req)
    if (q.action === 'import-template') return ok(await getTestCasesImportTemplate(me))
    if (q.id && q.action === 'history') return ok(await getTestCaseHistory(q.id))
    if (q.id && q.action === 'reviews') return ok(await getTestCaseReviews(q.id))
    if (q.id) return ok(await getTestCase(q.id))
    return ok(await listTestCasesPaginated(q))
  })
}

/** POST /api/test-cases                 -> create draft test case
 *  POST /api/test-cases?action=import   -> bulk create from a CSV file */
export async function POST(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const body = await req.json().catch(() => ({}))
    if (getQueryParams(req).action === 'import') {
      const input = validateImportTestCasesBody(body)
      return ok(await importTestCasesFromCsv(me, input, extractRequestMeta(req)))
    }
    const input = validateCreateTestCaseBody(body)
    return ok(await createTestCase(me, input, extractRequestMeta(req)))
  })
}

/** PUT /api/test-cases?id=...&action=submit-review -> start a review cycle
 *  PUT /api/test-cases?id=...                      -> update (version + snapshot) */
export async function PUT(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const { id, action } = getQueryParams(req)
    if (!id) throw ApiError.badRequest('Missing test case id')
    const body = await req.json().catch(() => ({}))
    if (action === 'submit-review') {
      const input = validateSubmitReviewBody(body)
      return ok(await submitTestCaseForReview(me, id, input, extractRequestMeta(req)))
    }
    const input = validateUpdateTestCaseBody(body)
    return ok(await updateTestCaseFields(me, id, input, extractRequestMeta(req)))
  })
}

/** DELETE /api/test-cases?id=...                  -> PERMANENT delete (row removed; history,
 *                                                    review requests/events and bug links
 *                                                    cascade with it)
 *  DELETE /api/test-cases?action=bulk-delete       -> PERMANENT delete of many at once
 *                                                    (body: { ids: [...] }) */
export async function DELETE(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const { id, action } = getQueryParams(req)
    if (action === 'bulk-delete') {
      const body = await req.json().catch(() => ({}))
      const input = validateBulkDeleteBody(body)
      return ok(await deleteTestCasesPermanently(me, input.ids, extractRequestMeta(req)))
    }
    if (!id) throw ApiError.badRequest('Missing test case id')
    return ok(await deleteTestCasePermanently(me, id, extractRequestMeta(req)))
  })
}
