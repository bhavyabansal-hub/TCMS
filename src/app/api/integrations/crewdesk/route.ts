// Controller for /api/integrations/crewdesk — thin HTTP adapter.
// Parses the request, delegates to validators + services, returns responses.
// NO business logic and NO Crew Desk HTTP here (that lives in the service,
// the identity check and the single-file client). All endpoints require a
// session; mutations pass the CSRF funnel via withApi() -> assertSameOrigin().

import type { NextRequest } from 'next/server'
import { withApi, ok, getQueryParams, ApiError } from '@/lib/api'
import { requireUser } from '@/lib/auth'
import {
  buildCommentForLink,
  checkMyCrewDeskEmail,
  createCrewDeskLink,
  crewDeskInfo,
  listCrewDeskLinks,
  lookupCrewDeskTicket,
  previewCrewDeskComment,
  retryCrewDeskLink,
} from './crewdesk.service'
import {
  parseLinkCreate,
  parseLookup,
  parseManualCreate,
  validateRetryLinkId,
} from './crewdesk.validation'
import { crewDeskMode } from '@/lib/server/crewdesk.client'
import { PUBLIC_ORIGIN } from '@/lib/server/config'

/**
 * Public origin for comment URLs (module page links) — proxy-aware.
 * Priority:
 *   1. TCMS_PUBLIC_ORIGIN env — explicit pin for production deployments.
 *   2. The browser's Origin header — behind gateways that REWRITE Host/
 *      x-forwarded-host (e.g. the preview proxy swaps in an internal
 *      ws-*.fcapp.run host), Origin is the only header that still carries
 *      the real public URL the link must point at. Link-building calls are
 *      always POSTs, so browsers always send it.
 *   3. x-forwarded-host / Host fallback — direct or honest-proxy setups.
 */
function getPublicOrigin(req: NextRequest): string {
  // Explicit pin wins (TCMS_PUBLIC_ORIGIN via the central config).
  if (PUBLIC_ORIGIN) return PUBLIC_ORIGIN
  const origin = req.headers.get('origin')
  if (origin && origin !== 'null') return origin.replace(/\/+$/, '')
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? 'localhost:3000'
  const proto = req.headers.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https')
  return `${proto}://${host}`
}

/** Client-declared public origin (window.location.origin) for the GET
 *  copy/preview endpoints — browsers do NOT attach an Origin header to GET,
 *  so behind rewriting proxies the header fallback lands on the internal
 *  host and the copied module link is wrong. The browser's own address bar
 *  is ground truth for copy-paste text. Strictly validated: http/https,
 *  host[:port] only — no path, query, or whitespace — and it can never
 *  override a TCMS_PUBLIC_ORIGIN pin. */
function sanitizeClientOrigin(raw: string | undefined): string | null {
  if (!raw) return null
  const v = raw.trim().replace(/\/+$/, '')
  return /^https?:\/\/[A-Za-z0-9.\-]+(:\d{1,5})?$/.test(v) ? v : null
}

/** Effective origin for copy-text building on GET endpoints: pin > explicit
 *  client origin > headers. */
function resolveCopyOrigin(req: NextRequest, clientOrigin: string | undefined): string {
  if (PUBLIC_ORIGIN) return PUBLIC_ORIGIN
  return sanitizeClientOrigin(clientOrigin) ?? getPublicOrigin(req)
}

async function readJsonBody(req: NextRequest): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}

/** GET /api/integrations/crewdesk                    -> link history (paginated)
 *  GET /api/integrations/crewdesk?path=config        -> safe mode/auth summary
 *  GET /api/integrations/crewdesk?path=email-check   -> the verification badge
 *  GET /api/integrations/crewdesk?path=comment&linkId -> rebuild copyable comment text
 *  GET ?path=preview-comment&moduleId=&note= -> pre-link comment text (no side effects)
 *  Both copy-text endpoints accept &origin=<window.location.origin> because
 *  GET requests carry no Origin header and the proxy fallback host is wrong. */
export async function GET(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const { path, linkId, moduleId, note, origin } = getQueryParams(req)
    if (path === 'config') return ok(crewDeskInfo(me))
    if (path === 'email-check') return ok(await checkMyCrewDeskEmail(me))
    if (path === 'comment') return ok(await buildCommentForLink(me, validateRetryLinkId(linkId), resolveCopyOrigin(req, origin)))
    if (path === 'preview-comment') {
      if (!moduleId) throw ApiError.badRequest('moduleId is required')
      return ok(await previewCrewDeskComment(me, moduleId, note ?? null, resolveCopyOrigin(req, origin)))
    }
    if (path) throw ApiError.badRequest(`Unknown path "${path}"`)
    return ok(await listCrewDeskLinks(me, getQueryParams(req)))
  })
}

/** POST /api/integrations/crewdesk?path=lookup            -> preview ticket (title+status)
 *  POST /api/integrations/crewdesk?path=retry&linkId=...  -> retry a failed link
 *  POST /api/integrations/crewdesk                        -> create link (or manual copy) */
export async function POST(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const { path, linkId } = getQueryParams(req)
    if (path === 'lookup') {
      const { ticketId } = parseLookup(await readJsonBody(req))
      return ok(await lookupCrewDeskTicket(me, ticketId))
    }
    if (path === 'retry') {
      return ok(await retryCrewDeskLink(me, validateRetryLinkId(linkId), getPublicOrigin(req)))
    }
    if (path) throw ApiError.badRequest(`Unknown path "${path}"`)
    const raw = await readJsonBody(req)
    // Manual mode makes no Crew Desk calls, so the ticket id is optional there.
    const body = crewDeskMode() === 'manual' ? parseManualCreate(raw) : parseLinkCreate(raw)
    return ok(await createCrewDeskLink(me, body, getPublicOrigin(req)), 201)
  })
}
