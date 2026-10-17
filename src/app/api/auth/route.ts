// Controller for /api/auth — thin HTTP adapter over the auth service.
// Actions are addressed via query param: POST ?path=login|register|refresh|logout,
// PUT ?path=password, plus GET (profile) and PUT (profile update).
//
// ACCOUNT CREATION POLICY (owner decision 2026-10-08; switch added 2026-10-14):
// self-signup is gated by TCMS_ALLOW_SIGNUP (fail-closed — 403 unless the
// server env is exactly 'true', enforced in auth.service.ts) and creates the
// LEAST-privileged role ('viewer'); admins promote users through the Users
// API (POST /api/users, manage_users permission). Production keeps the flag
// false and seeds its first VP via /api/seed instead of public registration.
// Validation runs BEFORE the service; the service enforces uniqueness.
//
// UI TWIN: the "/login" Create-account tab is hidden unless
// NEXT_PUBLIC_ALLOW_SIGNUP='true' was set AT BUILD TIME (auth-screen.tsx).
// Both flags must be flipped together + app rebuilt — see .env.example.
//
// COOKIE SESSION CONTRACT: the access/refresh tokens produced by the service
// are moved into httpOnly cookies (src/lib/server/auth-cookies.ts) and are
// NEVER returned in the response body. The refresh token is read back from
// its cookie (or, for API consumers, an explicit body field) on refresh/logout.

import type { NextRequest } from 'next/server'
import { withApi, ok, ApiError, getQueryParams, extractRequestMeta } from '@/lib/api'
import { requireUser } from '@/lib/auth'
import {
  ACCESS_COOKIE,
  applySessionCookies,
  clearedAuthResponse,
  readRefreshCookie,
  refreshedResponse,
  sessionResponse,
} from '@/lib/server/auth-cookies'
import {
  changePassword,
  getProfile,
  issueWsTicket,
  loginUser,
  logoutSession,
  refreshSession,
  registerUser,
  updateProfile,
} from './auth.service'
import {
  validateLogoutBody,
  validatePasswordChangeBody,
  validateProfileUpdateBody,
  validateRefreshBody,
  validateLoginBody,
  validateRegisterBody,
} from './auth.validation'

/** Access token sent by API consumers in the Authorization header (logout revokes it). */
function bearerToken(req: NextRequest): string | null {
  const authz = req.headers.get('authorization')
  return authz?.startsWith('Bearer ') ? authz.slice('Bearer '.length).trim() || null : null
}

/** POST /api/auth?path=login|refresh|logout */
export async function POST(req: NextRequest) {
  return withApi(req, async () => {
    const { path } = getQueryParams(req)
    const action = path || (req.headers.get('x-action') ?? '')
    const body = await req.json().catch(() => ({}))

    switch (action) {
      case 'login':
        return sessionResponse(req, await loginUser(validateLoginBody(body), extractRequestMeta(req)))
      case 'register':
        // Self-signup: validated body -> service (deployment switch 403,
        // uniqueness + least-privilege role) -> session cookies, exactly like
        // login when the switch is on.
        return sessionResponse(req, await registerUser(validateRegisterBody(body), extractRequestMeta(req)))
      case 'refresh': {
        // Cookie first (the SPA path); body field kept for API consumers.
        const refreshToken =
          validateRefreshBody(body).refreshToken ?? readRefreshCookie(req)
        if (!refreshToken) throw ApiError.unauthorized('Missing refresh token')
        return refreshedResponse(req, await refreshSession(refreshToken))
      }
      case 'logout': {
        const refreshToken =
          validateLogoutBody(body).refreshToken ?? readRefreshCookie(req) ?? undefined
        await logoutSession(refreshToken, req.cookies.get(ACCESS_COOKIE)?.value ?? bearerToken(req))
        // Clears both cookies regardless — never leave stale session state.
        return clearedAuthResponse(req)
      }
      default:
        throw ApiError.badRequest('Unknown action')
    }
  })
}

/** GET /api/auth -> current user profile + effective permissions
 *  GET /api/auth?path=ws-ticket -> short-lived notifications-WS ticket (auth required) */
export async function GET(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const { path } = getQueryParams(req)
    if (path === 'ws-ticket') return ok(issueWsTicket(me.userId))
    return ok(await getProfile(me.userId))
  })
}

/** PUT /api/auth?path=password -> change password
 *  PUT /api/auth                -> update profile */
export async function PUT(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const body = await req.json().catch(() => ({}))
    const { path } = getQueryParams(req)
    if (path === 'password') {
      // Every older session ends; this browser keeps working with a fresh cookie pair.
      const { accessToken, refreshToken } = await changePassword(me, validatePasswordChangeBody(body), extractRequestMeta(req))
      const res = ok({ success: true })
      applySessionCookies(req, res, { accessToken, refreshToken })
      return res
    }
    return ok(await updateProfile(me, validateProfileUpdateBody(body), extractRequestMeta(req)))
  })
}
