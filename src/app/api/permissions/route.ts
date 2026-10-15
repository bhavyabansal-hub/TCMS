// Controller for /api/permissions — thin HTTP adapter over the permission
// service. GET returns the effective matrix, PUT toggles one cell.
// NO business logic and NO SQL live here.

import type { NextRequest } from 'next/server'
import { withApi, ok, extractRequestMeta } from '@/lib/api'
import { requireUser } from '@/lib/auth'
import { getPermissionMatrix, togglePermission } from './permissions.service'
import { validateTogglePermissionBody } from './permissions.validation'

/** GET /api/permissions -> full effective role x action matrix */
export async function GET(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    return ok(await getPermissionMatrix(me))
  })
}

/** PUT /api/permissions -> toggle one { role, action, enabled } cell */
export async function PUT(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const body = await req.json().catch(() => ({}))
    return ok(await togglePermission(me, validateTogglePermissionBody(body), extractRequestMeta(req)))
  })
}
