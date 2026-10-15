// Edge proxy (Next 16's successor to `middleware.ts`) — cheap FIRST-LINE gate
// for page routes.
//
// What it does: blocks anonymous page requests before any app-shell JS is
// downloaded, redirecting them to /login?next=<original>. It only checks
// that the `tcms-access` session cookie EXISTS — it never parses or verifies
// the JWT here (Edge runtime; verification stays server-side).
//
// What it is NOT: the security boundary. Every API request is still fully
// authenticated/authorized in-handler (requireUser / requirePermission in
// src/lib/auth.ts), and the client AuthGate re-validates the session on
// boot. This layer is pure defense-in-depth + a UX win (no flash of the
// app shell for signed-out visitors).
//
// Cookie lifecycle note: both session cookies (`tcms-access` / `tcms-refresh`)
// are httpOnly and written by the SERVER on login/register/refresh and cleared
// on logout (src/lib/server/auth-cookies.ts) — JavaScript can neither read nor
// forge them. Their presence is a reliable proxy for "has some session state".

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const ACCESS_COOKIE = 'tcms-access'

export function proxy(req: NextRequest) {
  if (req.cookies.get(ACCESS_COOKIE)?.value) {
    // CACHE-FRESHNESS: page HTML (and RSC payloads) must never be reused from
    // a cache across deploys — otherwise a rebuilt app can look "stuck" on an
    // old screen no matter how many times the user refreshes.
    const res = NextResponse.next()
    res.headers.set('Cache-Control', 'no-store, must-revalidate')
    return res
  }

  const login = new URL('/login', req.url)
  // Always a same-origin relative path by construction; routes.ts
  // safeNextPath() re-sanitizes it on the client before navigating.
  login.searchParams.set('next', req.nextUrl.pathname + req.nextUrl.search)
  const redirect = NextResponse.redirect(login)
  redirect.headers.set('Cache-Control', 'no-store')
  return redirect
}

export const config = {
  // Protected page routes only — /api/**, static assets and the root redirect
  // stay out of the middleware entirely (API routes enforce their own auth
  // per-handler and set their own no-cache headers; /login is dynamic anyway).
  matcher: [
    '/dashboard/:path*',
    '/modules/:path*',
    '/test-cases/:path*',
    '/reviews/:path*',
    '/module-reviews/:path*',
    '/bugs/:path*',
    '/tasks/:path*',
    '/reports/:path*',
    '/activity-log/:path*',
    '/notifications/:path*',
    '/settings/:path*',
    '/integrations/:path*',
    // AUDIT FIX (2026-10-09): /wiki was the only app page missing from the
    // edge gate — anonymous deep links loaded the whole app shell before the
    // client AuthGate bounced them.
    '/wiki/:path*',
  ],
}
