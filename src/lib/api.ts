import { NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { logger } from './logger'
import { EXTRA_ALLOWED_HOSTS, READ_ONLY, SLOW_REQUEST_MS } from '@/lib/server/config'
import { READ_ONLY_MESSAGE, isBlockedInReadOnly } from '@/lib/server/read-only'
import type { RequestMeta } from './activity'
import { mapDatabaseError, mysqlErrno } from '@/lib/server/db-errors'

// Standard API response helpers — the ONLY way routes produce responses.
//
// Success          -> ok(data) | paginate(...)
// Expected failure -> throw new ApiError(status, message, details?)
// Unknown failure  -> caught by withApi() and converted to a 500 envelope.
//
// Error envelope is always: { error: string, details?: unknown }

export interface PaginatedResponse<T> {
  data: T[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

/** Typed business error thrown by services; mapped to an HTTP status by withApi(). */
export class ApiError extends Error {
  readonly status: number
  readonly details?: unknown

  constructor(status: number, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.details = details
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError(400, message, details)
  }
  static unauthorized(message = 'Unauthorized') {
    return new ApiError(401, message)
  }
  static forbidden(message = 'Forbidden') {
    return new ApiError(403, message)
  }
  static notFound(message = 'Not found') {
    return new ApiError(404, message)
  }
  static conflict(message: string, details?: unknown) {
    return new ApiError(409, message, details)
  }
  /** 409 for a guarded update that lost the race (src/lib/server/optimistic-lock.ts). */
  static staleEdit() {
    return new ApiError(409, STALE_EDIT_MESSAGE)
  }
}

export const STALE_EDIT_MESSAGE = 'This item was changed by someone else — reload'

export function errorBody(message: string, details?: unknown) {
  return details === undefined ? { error: message } : { error: message, details }
}

// CACHE-FRESHNESS GUARANTEE: API answers are per-user, per-moment data — the
// browser (and any intermediate proxy) must never reuse them. Without this,
// a stale dashboard/list can survive a deploy and LOOK like corrupted data.
// Static hashed assets under /_next/static keep their immutable caching.
export const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, must-revalidate' } as const

export function ok<T>(data: T, status = 200) {
  return NextResponse.json(data, { status, headers: NO_STORE_HEADERS })
}

export function badRequest(message: string, details?: unknown) {
  return NextResponse.json(errorBody(message, details), { status: 400, headers: NO_STORE_HEADERS })
}

export function unauthorized(message = 'Unauthorized') {
  return NextResponse.json(errorBody(message), { status: 401, headers: NO_STORE_HEADERS })
}

export function forbidden(message = 'Forbidden') {
  return NextResponse.json(errorBody(message), { status: 403, headers: NO_STORE_HEADERS })
}

export function notFound(message: string) {
  return NextResponse.json(errorBody(message), { status: 404, headers: NO_STORE_HEADERS })
}

export function paginate<T>(
  data: T[],
  total: number,
  page: number,
  pageSize: number
): PaginatedResponse<T> {
  return {
    data,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  }
}

export function getQueryParams(req: Request) {
  const url = new URL(req.url)
  return Object.fromEntries(url.searchParams.entries())
}

/**
 * Extracts the client metadata (IP + user agent) a service may attach to an
 * activity log. Controllers call this and hand the plain object to services so
 * that the service layer never touches HTTP request types (coding standard #10).
 */
export function extractRequestMeta(req: Request): RequestMeta {
  return {
    ip: req.headers.get('x-forwarded-for') ?? null,
    userAgent: req.headers.get('user-agent') ?? null,
  }
}

/** Parses ?page=&pageSize= with sane bounds. Repositories use `.offset` for SQL. */
export function getPagination(q: Record<string, string>, defaultPageSize = 20) {
  const page = Math.max(1, parseInt(q.page ?? '1', 10) || 1)
  const pageSize = Math.min(100, Math.max(1, parseInt(q.pageSize ?? String(defaultPageSize), 10) || defaultPageSize))
  return { page, pageSize, offset: (page - 1) * pageSize }
}

/**
 * Normalizes a host candidate for origin comparison: accepts either a bare
 * `host[:port]` or an absolute URL, lowercases, and strips default ports
 * (443/https, 80/http) so `example.com:443` matches `example.com` — the exact
 * mismatch browsers vs. proxies produce when one side keeps the default port.
 */
function normalizeHost(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  let hostPort = trimmed
  try {
    // Only treat the value as an absolute URL when it REALLY has a scheme:
    // `new URL('localhost:3000')` parses "localhost" as a SCHEME (non-special
    // scheme:path form) and yields an EMPTY .host — which silently turned
    // every bare `host:port` candidate (Host header, x-forwarded-host) into
    // "" and disabled origin matching entirely (everything fell through to
    // the X-Requested-With marker, flooding the log with CSRF warnings).
    if (trimmed.includes('://')) hostPort = new URL(trimmed).host
  } catch {
    /* keep as bare host */
  }
  try {
    const parsed = new URL(`https://${hostPort}`)
    const isDefaultPort =
      (parsed.protocol === 'https:' && parsed.port === '443') ||
      (parsed.protocol === 'http:' && parsed.port === '80')
    return (isDefaultPort ? parsed.hostname : parsed.host).toLowerCase()
  } catch {
    return hostPort.toLowerCase()
  }
}

/**
 * CSRF defense for state-changing requests (defense layers 2 + 3 — layer 1 is
 * SameSite=Lax on the session cookies, see src/lib/server/auth-cookies.ts):
 *   1. If the browser sent an Origin header and it matches one of the hosts
 *      this deployment trusts — x-forwarded-host (any entry of a proxy chain),
 *      Host, or an explicit TCMS_EXTRA_ALLOWED_HOSTS list (comma-separated,
 *      for deployments behind gateways that rewrite the Host header) — allow.
 *   2. Otherwise the request must carry our custom `X-Requested-With: tcms`
 *      header, which the SPA adds on every call. Cross-site JS cannot set a
 *      custom header without a successful CORS preflight — and this API never
 *      approves one — so its presence proves the call is first-party. This
 *      also keeps deployments working behind proxies that rewrite Host /
 *      x-forwarded-host to an internal name (preview gateways, etc.) even
 *      when no extra allow-list is configured: the marker is the proof.
 * Safe methods (GET/HEAD/OPTIONS) are skipped: they must never mutate state.
 */
export function assertSameOrigin(req: Request): void {
  const method = req.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return

  // Robust to duplicate headers: undici joins repeats with ", ", so take the
  // first value and compare case-insensitively.
  const marker = (req.headers.get('x-requested-with') ?? '').split(',')[0].trim().toLowerCase()
  const firstParty = marker === 'tcms'

  const origin = req.headers.get('origin')
  if (origin) {
    // `null` (sandboxed iframe / cross-origin redirect) is never trustworthy.
    const originHost = origin === 'null' ? null : normalizeHost(origin)
    const forwardedHost = req.headers.get('x-forwarded-host') ?? ''
    const trustedCandidates = [
      ...forwardedHost.split(','),
      req.headers.get('host') ?? '',
      ...EXTRA_ALLOWED_HOSTS.split(','),
    ]
    if (originHost && trustedCandidates.some((c) => normalizeHost(c) === originHost)) return
    if (firstParty) {
      // Origin present but unverifiable: a gateway rewrote Host /
      // x-forwarded-host to an internal name. The custom marker already
      // proves the call is first-party (cross-site JS cannot set it), so
      // allow — but log for observability so proxy changes stay visible.
      logger.warn(
        `CSRF: Origin unmatched, allowed via X-Requested-With marker. origin=${origin} ` +
          `host=${req.headers.get('host') ?? '-'} ` +
          `x-forwarded-host=${forwardedHost || '-'}`
      )
      return
    }
    // Diagnosability: log exactly what the server saw so a gateway that
    // rewrites Host/x-forwarded-host can be identified from the log alone.
    logger.warn(
      `CSRF: blocked POST with unmatched Origin. origin=${origin} ` +
        `host=${req.headers.get('host') ?? '-'} ` +
        `x-forwarded-host=${forwardedHost || '-'}`
    )
    throw new ApiError(403, 'Cross-site request blocked')
  }

  if (firstParty) return
  throw new ApiError(403, 'Missing CSRF verification header')
}

/**
 * Wraps a controller handler with the standard error boundary + request log.
 * Every exported route handler should look like:
 *
 *   export async function GET(req: NextRequest) {
 *     return withApi(req, async () => { ... })
 *   }
 */
export async function withApi(
  req: Request,
  handler: () => Promise<NextResponse>
): Promise<NextResponse> {
  const startedAt = Date.now()
  const url = new URL(req.url)
  try {
    assertSameOrigin(req)
    // Maintenance mode (TCMS_READ_ONLY=true): writes answer 503 before any work.
    if (READ_ONLY && isBlockedInReadOnly(req.method, url.pathname, url.searchParams)) {
      throw new ApiError(503, READ_ONLY_MESSAGE)
    }
    const res = await handler()
    // LOAD: a fast successful read is a debug line (shown in dev, not in production);
    // writes stay info, slow requests warn, errors are logged below.
    const durationMs = Date.now() - startedAt
    const line = `${req.method} ${url.pathname}${url.search} -> ${res.status}`
    if (durationMs >= SLOW_REQUEST_MS) logger.warn(`${line} (slow)`, { durationMs })
    else if (req.method === 'GET') logger.debug(line, { durationMs })
    else logger.info(line, { durationMs })
    // Belt-and-braces: even a handler that forgot the header can never
    // produce a cacheable API response (see NO_STORE_HEADERS / ok()).
    res.headers.set('Cache-Control', 'no-store, must-revalidate')
    return res
  } catch (err) {
    if (err instanceof ApiError) {
      logger.warn(`${req.method} ${url.pathname}${url.search} -> ${err.status}: ${err.message}`)
      return NextResponse.json(errorBody(err.message, err.details), { status: err.status, headers: NO_STORE_HEADERS })
    }
    if (err instanceof ZodError) {
      logger.warn(`${req.method} ${url.pathname}${url.search} -> 400: validation failed`)
      return badRequest('Invalid input', flattenZodError(err))
    }
    // Database failures get a clean status + fixed message (never SQL text);
    // the original error stays in the server log only.
    const dbError = mapDatabaseError(err)
    if (dbError) {
      const line = `${req.method} ${url.pathname}${url.search} -> ${dbError.status}: db ${dbError.kind}`
      if (dbError.status === 503) logger.error(line, err)
      else logger.warn(line, { errno: mysqlErrno(err), detail: String((err as Error).message ?? '').slice(-300) })
      return NextResponse.json(errorBody(dbError.message), { status: dbError.status, headers: NO_STORE_HEADERS })
    }
    logger.error(`${req.method} ${url.pathname}${url.search} -> 500`, err)
    return NextResponse.json(errorBody('Internal server error'), { status: 500, headers: NO_STORE_HEADERS })
  }
}

/** Normalizes a ZodError into the shared `{ error, details }` details shape. */
export function flattenZodError(err: ZodError) {
  return err.flatten()
}
