// httpOnly session-cookie helpers — the ONLY place that writes auth cookies.
//
// SECURITY MODEL (why it is built this way):
//   - Tokens live EXCLUSIVELY in httpOnly cookies after login/register/refresh.
//     JavaScript can never read them, so a successful XSS cannot exfiltrate the
//     session — the strongest practical mitigation for a SPA.
//   - `tcms-access`  : the JWT access token. SameSite=Lax, path=/, Secure on
//     https. NOTE: the cookie's Max-Age deliberately matches the REFRESH
//     window (7d), not the 15m JWT expiry. An expired-JWT cookie is harmless
//     (the server always verifies signature + exp) — but keeping the cookie
//     present lets the edge proxy (src/proxy.ts) distinguish "no session at
//     all" from "session that just needs a silent refresh", so a hard refresh
//     after 15 idle minutes lands on the app and heals instead of flashing
//     the login page.
//   - `tcms-refresh` : the rotating refresh token. SameSite=Lax (Lax already
//     prevents cross-site POSTs from attaching it; Strict would break the
//     email-link top-navigation UX), path=/api/auth so it is ONLY sent to the
//     auth endpoints, never with ordinary API/page traffic.
//   - CSRF: three independent layers — (1) SameSite=Lax blocks cross-site
//     POSTs from carrying the session; (2) withApi() enforces assertSameOrigin()
//     (Origin/Host match on every state-changing request); (3) the SPA sends
//     an `X-Requested-With: tcms` custom header that cross-site JS cannot set
//     without a CORS preflight (which the API never approves). See
//     assertSameOrigin in src/lib/api.ts.
//   - TTLs mirror src/lib/auth.ts (ACCESS_TOKEN_TTL / REFRESH_TOKEN_TTL_DAYS).

import { NextResponse } from 'next/server'
import { IS_PRODUCTION_DEPLOYMENT, REFRESH_TOKEN_DAYS } from '@/lib/server/config'

export const ACCESS_COOKIE = 'tcms-access'
export const REFRESH_COOKIE = 'tcms-refresh'

const REFRESH_TOKEN_TTL_SECONDS = REFRESH_TOKEN_DAYS * 24 * 60 * 60
/** Cookie Max-Age = refresh window; see SECURITY MODEL note above. */
const ACCESS_COOKIE_MAX_AGE_SECONDS = REFRESH_TOKEN_TTL_SECONDS

/** True when the cookies must carry Secure: always on the real server
 *  (TCMS_DEPLOY_ENV=production — a spoofed x-forwarded-proto cannot drop it),
 *  otherwise when the request arrived over https (directly or via the proxy). */
export function isSecureRequest(req: Request): boolean {
  if (IS_PRODUCTION_DEPLOYMENT) return true
  const proto = req.headers.get('x-forwarded-proto')
  if (proto) return proto.split(',')[0].trim() === 'https'
  return new URL(req.url).protocol === 'https:'
}

interface SessionTokens {
  accessToken: string
  refreshToken: string
}

/**
 * Builds the login/register response: tokens are moved OUT of the JSON body
 * into httpOnly cookies, so the client never sees them.
 */
export function sessionResponse(
  req: Request,
  session: { user: unknown; permissions: string[] } & SessionTokens
): NextResponse {
  const res = NextResponse.json({ user: session.user, permissions: session.permissions })
  applySessionCookies(req, res, session)
  return res
}

/** Builds the refresh response: fresh cookie pair, no tokens in the body. */
export function refreshedResponse(req: Request, tokens: SessionTokens): NextResponse {
  const res = NextResponse.json({ success: true })
  applySessionCookies(req, res, tokens)
  return res
}

/** Builds the logout response: clears both cookies (max-age=0). */
export function clearedAuthResponse(req: Request): NextResponse {
  const res = NextResponse.json({ success: true })
  clearSessionCookies(req, res)
  return res
}

/** Writes both httpOnly session cookies onto an existing response. */
export function applySessionCookies(req: Request, res: NextResponse, tokens: SessionTokens): void {
  const secure = isSecureRequest(req)
  res.cookies.set(ACCESS_COOKIE, tokens.accessToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: ACCESS_COOKIE_MAX_AGE_SECONDS,
  })
  res.cookies.set(REFRESH_COOKIE, tokens.refreshToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/api/auth',
    maxAge: REFRESH_TOKEN_TTL_SECONDS,
  })
}

/** Expires both session cookies (logout / hard session end). */
export function clearSessionCookies(req: Request, res: NextResponse): void {
  const secure = isSecureRequest(req)
  res.cookies.set(ACCESS_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: 0,
  })
  res.cookies.set(REFRESH_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/api/auth',
    maxAge: 0,
  })
}

/** Refresh token from the httpOnly cookie (controllers pass it to the service). */
export function readRefreshCookie(req: Request): string | null {
  const raw = req.headers.get('cookie')
  if (!raw) return null
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === REFRESH_COOKIE) return decodeURIComponent(rest.join('='))
  }
  return null
}
