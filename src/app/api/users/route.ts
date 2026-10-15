// Controller for /api/users — thin HTTP adapter.
// Parses the request, delegates to validators + services, returns responses.
// NO business logic and NO SQL live here.

import type { NextRequest } from 'next/server'
import { withApi, ok, ApiError, getQueryParams, extractRequestMeta } from '@/lib/api'
import { requireUser } from '@/lib/auth'
import {
  createUser,
  deactivateUserAccount,
  listUserOptions,
  listUsersPaginated,
  updateUserFields,
} from './users.service'
import { validateCreateUserBody, validateUpdateUserBody } from './users.validation'

/** GET /api/users?action=options -> picker rows (any authenticated user)
 *  GET /api/users                -> paginated user list (manage_users only) */
export async function GET(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const q = getQueryParams(req)
    if (q.action === 'options') return ok(await listUserOptions())
    return ok(await listUsersPaginated(me, q))
  })
}

/** POST /api/users -> create (invite) a user */
export async function POST(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const body = await req.json().catch(() => ({}))
    const input = validateCreateUserBody(body)
    return ok(await createUser(me, input, extractRequestMeta(req)))
  })
}

/** PUT /api/users?id=... -> update user fields */
export async function PUT(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const { id } = getQueryParams(req)
    if (!id) throw ApiError.badRequest('Missing user id')
    const body = await req.json().catch(() => ({}))
    const input = validateUpdateUserBody(body)
    return ok(await updateUserFields(me, id, input, extractRequestMeta(req)))
  })
}

/** DELETE /api/users?id=... -> soft delete (isActive -> false) */
export async function DELETE(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const { id } = getQueryParams(req)
    if (!id) throw ApiError.badRequest('Missing user id')
    return ok(await deactivateUserAccount(me, id, extractRequestMeta(req)))
  })
}
