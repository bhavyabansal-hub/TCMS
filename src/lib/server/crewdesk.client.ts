// Crew Desk API client — THE single file that talks to Crew Desk.
//
// SECURITY / SAFETY CONTRACT (product rule — "no means no"):
//   1. ONE shared service account does everything; nobody needs a personal
//      token or Crew Desk account. Credentials live ONLY in server env and
//      are never hard-coded, never logged, never returned to the browser.
//      Error messages carry at most the HTTP status, never headers.
//   2. CREWDESK_MODE defaults to "test". ONLY the exact value "live" enables
//      other tickets; "manual" makes NO Crew Desk calls at all; a missing or
//      unrecognized value stays in test mode. In test mode postTicketComment()
//      REFUSES — before any network byte is sent — to post a comment to any
//      ticket other than the single designated test ticket
//      (CREWDESK_TEST_TICKET_ID; designated 1355 for the current dev setup).
//   3. Comments are posted as multipart/form-data ONLY (the Crew Desk
//      endpoint ignores/rejects JSON). Fields: content, type=comment,
//      user_id = CREWDESK_USER_ID (the shared service account's id), status =
//      the ticket's CURRENT status. `status_id` is deliberately never sent so
//      a comment can never move the ticket. The logged-in human's own Crew
//      Desk id is NEVER sent.
//
// SIGN-IN (replaceable via env):
//   (a) CREWDESK_TOKEN — a fixed bearer token, or
//   (b) CREWDESK_LOGIN_EMAIL + CREWDESK_LOGIN_PASSWORD — password login that
//       returns a JWT kept IN MEMORY ONLY. It is refreshed before expiry
//       (JWT `exp` claim) and once more after any 401. After 3 failed logins
//       the client stops trying for 15 minutes and reports a friendly
//       message, so a misconfiguration cannot lock the service account out.
//       Passwords and tokens are never logged anywhere.
//
// STRUCTURE: getTicket / listAssignableUsers / postTicketComment plus a tiny
// error taxonomy. Real-endpoint changes land in THIS file only.

// All settings come from the central env inventory (src/lib/server/config.ts)
// — the single place process.env is read in this codebase.
import {
  CREWDESK_AUTH,
  CREWDESK_BASE_URL,
  CREWDESK_LOGIN_EMAIL,
  CREWDESK_LOGIN_PASSWORD,
  CREWDESK_LOGIN_PATH,
  CREWDESK_MODE,
  CREWDESK_TEST_TICKET_ID,
  CREWDESK_TIMEOUT_MS,
  CREWDESK_TOKEN,
  CREWDESK_USER_ID,
} from '@/lib/server/config'

// The one and only ticket a test-mode comment may ever touch. Default is the
// owner-designated 1355 (from config); a deployment may re-designate exactly
// ONE test ticket via CREWDESK_TEST_TICKET_ID — the blast radius can never
// exceed a single ticket.
export function testAllowedTicketId(): string {
  return CREWDESK_TEST_TICKET_ID
}

export type CrewDeskErrorCode =
  | 'config' // credentials / base URL not usable or not configured
  | 'mode_guard' // test-mode refusal for a non-test ticket (nothing was sent)
  | 'email_check' // verification-only email check did not pass (nothing was sent)
  | 'not_found' // {"status":"error","success":false,"message":"Ticket not found"}
  | 'unauthorized' // 401/403 — expired/invalid credentials, or login backoff active
  | 'timeout' // no response within CREWDESK_TIMEOUT_MS
  | 'unreachable' // DNS/socket/abort before a response
  | 'http' // non-2xx, non-auth HTTP failure
  | 'unexpected' // 2xx but body shape we cannot interpret (fail safe)

export class CrewDeskError extends Error {
  readonly code: CrewDeskErrorCode
  readonly httpStatus?: number

  constructor(code: CrewDeskErrorCode, message: string, httpStatus?: number) {
    super(message)
    this.name = 'CrewDeskError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

// ---------- Configuration (read lazily, never logged raw) ----------

export type CrewDeskMode = 'manual' | 'test' | 'live'
export type CrewDeskAuthMode = 'token' | 'login' | 'none'

export interface CrewDeskConfig {
  baseUrl: string
  mode: CrewDeskMode
  authMode: CrewDeskAuthMode
  timeoutMs: number
}

export function crewDeskMode(): CrewDeskMode {
  const raw = CREWDESK_MODE
  if (raw === 'live') return 'live'
  if (raw === 'manual') return 'manual'
  return 'test' // missing/unrecognized stays in the guarded mode
}

export function crewDeskAuthMode(): CrewDeskAuthMode {
  // No CREWDESK_BASE_URL in .env = the integration is off (no built-in address).
  if (!CREWDESK_BASE_URL) return 'none'
  if (CREWDESK_AUTH === 'token' || CREWDESK_AUTH === 'login') return CREWDESK_AUTH
  // Auto: a fixed token wins; otherwise password login when both parts exist.
  if (CREWDESK_TOKEN) return 'token'
  if (CREWDESK_LOGIN_EMAIL && CREWDESK_LOGIN_PASSWORD) return 'login'
  return 'none'
}

export function crewDeskConfig(): CrewDeskConfig {
  return {
    baseUrl: CREWDESK_BASE_URL,
    mode: crewDeskMode(),
    authMode: crewDeskAuthMode(),
    timeoutMs: CREWDESK_TIMEOUT_MS,
  }
}

/** Safe to log / return to the UI — contains no secret material. */
export function crewDeskConfigSummary(): CrewDeskConfig {
  return crewDeskConfig()
}
// NOTE: credentialExpiresAt() below is likewise safe to expose (an ISO date
// only) — the token itself never leaves the server.

// ---------- JWT helpers (UNSIGNED decode, display/expiry only) ----------

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
}

function jwtClaim(payload: Record<string, unknown> | null, key: string): string | null {
  const v = payload?.[key]
  if (typeof v === 'string' && v.trim()) return v.trim()
  if (typeof v === 'number') return String(v)
  return null
}

/** JWT `exp` in ms epoch, or null when absent/unparseable. */
function jwtExpiresAt(token: string): number | null {
  const exp = decodeJwtPayload(token)?.exp
  return typeof exp === 'number' && exp > 0 ? exp * 1000 : null
}

/**
 * ISO expiry timestamp of the FIXED token credential (token mode only) —
 * display-only, non-secret. Lets the UI warn BEFORE an hourly dev token dies
 * mid-test. Login mode is excluded: it refreshes its own JWT automatically.
 */
export function credentialExpiresAt(): string | null {
  if (crewDeskAuthMode() !== 'token' || !CREWDESK_TOKEN) return null
  const exp = jwtExpiresAt(CREWDESK_TOKEN)
  return exp ? new Date(exp).toISOString() : null
}

// ---------- Shared service account identity ----------

export interface CrewDeskAccount {
  userId: string
  email: string | null
}

/**
 * The Crew Desk user id sent with EVERY comment. Source of truth is the
 * CREWDESK_USER_ID setting; when it is missing we fall back to the user_id
 * claim of the credential itself (fixed JWT, or the login-issued JWT) and
 * warn. The logged-in human's own Crew Desk id is never used here.
 */
export function sharedAccountUserId(): string | null {
  if (CREWDESK_USER_ID) return CREWDESK_USER_ID
  if (CREWDESK_TOKEN) return jwtClaim(decodeJwtPayload(CREWDESK_TOKEN), 'user_id')
  // Login mode: the in-memory JWT issued by the login endpoint carries the
  // service account's user_id claim — the documented fallback. Returns null
  // only before the first successful login (nothing is cached on disk).
  if (loginState.token) return jwtClaim(decodeJwtPayload(loginState.token), 'user_id')
  return null
}

/**
 * Decoded (UNSIGNED, display-only) identity of the shared service account.
 * Token mode reads CREWDESK_TOKEN; login mode reports the configured login
 * email (the JWT only exists after the first login and is never cached on
 * disk). Never exposes secret material.
 */
export function crewDeskAccount(): CrewDeskAccount | null {
  const authMode = crewDeskAuthMode()
  if (authMode === 'login') {
    return { userId: sharedAccountUserId() ?? '', email: CREWDESK_LOGIN_EMAIL || null }
  }
  if (!CREWDESK_TOKEN) return null
  const payload = decodeJwtPayload(CREWDESK_TOKEN)
  const userId = sharedAccountUserId() ?? jwtClaim(payload, 'user_id')
  if (!userId) return null
  return { userId, email: jwtClaim(payload, 'email') }
}

/**
 * Startup consistency check: if the credential is a JWT carrying user_id and
 * CREWDESK_USER_ID is set, warn loudly when they disagree (the comment would
 * be posted under a different identity than configured). Never logs the
 * token itself. Called at module load (token mode) and after every login.
 */
function warnOnUserIdMismatch(tokenUserId: string | null, source: string): void {
  if (!CREWDESK_USER_ID || !tokenUserId) return
  if (CREWDESK_USER_ID !== tokenUserId) {
    console.warn(
      `[crewdesk] WARNING: CREWDESK_USER_ID=${CREWDESK_USER_ID} does not match the user_id claim of the ${source} token (${tokenUserId}). ` +
        'Comments will be posted with CREWDESK_USER_ID. Fix the setting or the token to keep identities consistent.'
    )
  }
}

// Run the check for the fixed-token path as early as this module loads.
if (crewDeskAuthMode() === 'token' && CREWDESK_TOKEN) {
  warnOnUserIdMismatch(jwtClaim(decodeJwtPayload(CREWDESK_TOKEN), 'user_id'), 'CREWDESK_TOKEN')
}

// ---------- Login mode (b): in-memory token with expiry + backoff ----------

const LOGIN_PATH = CREWDESK_LOGIN_PATH
const LOGIN_MAX_FAILURES = 3
const LOGIN_BACKOFF_MS = 15 * 60 * 1000 // 15 minutes
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000 // re-login 5 min before exp

interface LoginState {
  token: string | null
  expiresAt: number | null // ms epoch
  failures: number
  blockedUntil: number | null // ms epoch
  inflight: Promise<string> | null // serialize concurrent logins
}
const loginState: LoginState = { token: null, expiresAt: null, failures: 0, blockedUntil: null, inflight: null }

export const LOGIN_BLOCKED_MESSAGE = 'Crew Desk login failed, contact admin'

/** Manual test hook — forget the cached login token (NOT the password). */
export function forgetCachedToken(): void {
  loginState.token = null
  loginState.expiresAt = null
}

async function loginOnce(): Promise<string> {
  const { baseUrl, timeoutMs } = crewDeskConfig()
  const email = CREWDESK_LOGIN_EMAIL
  const password = CREWDESK_LOGIN_PASSWORD
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(`${baseUrl}${LOGIN_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: controller.signal,
      cache: 'no-store',
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new CrewDeskError('timeout', `Crew Desk did not respond within ${timeoutMs / 1000}s (login). It may be slow or down — try again.`)
    }
    throw new CrewDeskError('unreachable', 'Crew Desk is unreachable right now (login). Try again later.')
  } finally {
    clearTimeout(timer)
  }

  const text = await res.text().catch(() => '')
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  if (!res.ok) {
    // Count the failure toward the lockout, whatever the HTTP reason.
    throw new CrewDeskError(res.status === 401 || res.status === 403 ? 'unauthorized' : 'http', LOGIN_BLOCKED_MESSAGE, res.status)
  }
  const data = (json as { data?: Record<string, unknown> } | null)?.data ?? (json as Record<string, unknown> | null)
  const token = typeof data?.token === 'string' ? data.token : typeof data?.access_token === 'string' ? data.access_token : null
  if (!token) {
    throw new CrewDeskError('unexpected', 'Crew Desk login answered but returned no token.', res.status)
  }
  // Cache in memory only, with the JWT's own expiry when readable.
  loginState.token = token
  loginState.expiresAt = jwtExpiresAt(token)
  warnOnUserIdMismatch(jwtClaim(decodeJwtPayload(token), 'user_id'), 'login-issued')
  return token
}

async function acquireLoginToken(): Promise<string> {
  const now = Date.now()
  if (loginState.blockedUntil && loginState.blockedUntil > now) {
    throw new CrewDeskError('unauthorized', LOGIN_BLOCKED_MESSAGE)
  }
  if (
    loginState.token &&
    (!loginState.expiresAt || loginState.expiresAt - TOKEN_REFRESH_MARGIN_MS > now)
  ) {
    return loginState.token
  }
  // Serialize concurrent logins (several requests may wake up at once).
  if (!loginState.inflight) {
    loginState.inflight = (async () => {
      try {
        const token = await loginOnce()
        loginState.failures = 0
        loginState.blockedUntil = null
        return token
      } catch (err) {
        loginState.failures += 1
        loginState.token = null
        loginState.expiresAt = null
        if (loginState.failures >= LOGIN_MAX_FAILURES) {
          loginState.blockedUntil = Date.now() + LOGIN_BACKOFF_MS
          loginState.failures = 0
          console.warn(`[crewdesk] ${LOGIN_MAX_FAILURES} consecutive logins failed — pausing login attempts for ${LOGIN_BACKOFF_MS / 60000} minutes.`)
        }
        if (err instanceof CrewDeskError) {
          throw new CrewDeskError(err.code === 'unexpected' ? 'unexpected' : 'unauthorized', LOGIN_BLOCKED_MESSAGE, err.httpStatus)
        }
        throw new CrewDeskError('unauthorized', LOGIN_BLOCKED_MESSAGE)
      } finally {
        loginState.inflight = null
      }
    })()
  }
  return loginState.inflight
}

// ---------- Shared internals ----------

function authHeaders(): Record<string, string> {
  const authMode = crewDeskAuthMode()
  if (authMode === 'token') {
    if (!CREWDESK_TOKEN) {
      throw new CrewDeskError('config', 'Crew Desk integration is not configured (missing token). Ask an admin to set CREWDESK_TOKEN.')
    }
    return { Authorization: `Bearer ${CREWDESK_TOKEN}` }
  }
  throw new CrewDeskError('config', 'Crew Desk integration is not configured (no credentials). Ask an admin to set CREWDESK_BASE_URL and CREWDESK_TOKEN (or the login variables) in .env.')
}

async function requestJson(
  path: string,
  init: { method: 'GET' | 'POST'; body?: BodyInit; headers?: Record<string, string> },
  opts: { retried401?: boolean } = {}
): Promise<unknown> {
  const { baseUrl, timeoutMs, authMode } = crewDeskConfig()
  if (authMode === 'none') {
    throw new CrewDeskError('config', 'Crew Desk integration is not configured. Ask an admin to set CREWDESK_BASE_URL and CREWDESK_TOKEN (or the login variables) in .env.')
  }
  if (authMode === 'login') {
    // Proactive: refresh before expiry; reactive: one retry after a 401 below.
    const token = await acquireLoginToken()
    if (!loginState.token) return requestJson(path, init, opts) // defensive
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...init.headers }
    return sendJson(path, init, headers, baseUrl, timeoutMs, authMode, opts)
  }
  return sendJson(path, init, authHeaders(), baseUrl, timeoutMs, authMode, opts)
}

async function sendJson(
  path: string,
  init: { method: 'GET' | 'POST'; body?: BodyInit; headers?: Record<string, string> },
  headers: Record<string, string>,
  baseUrl: string,
  timeoutMs: number,
  authMode: CrewDeskAuthMode,
  opts: { retried401?: boolean }
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: init.method,
      headers: { ...headers, ...init.headers },
      body: init.body,
      signal: controller.signal,
      cache: 'no-store',
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new CrewDeskError('timeout', `Crew Desk did not respond within ${timeoutMs / 1000}s. It may be slow or down — try again.`)
    }
    throw new CrewDeskError('unreachable', 'Crew Desk is unreachable right now. Try again later.')
  } finally {
    clearTimeout(timer)
  }

  const text = await res.text().catch(() => '')
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }

  if (res.status === 401 || res.status === 403) {
    // Login mode: the cached token may have expired/rotated server-side —
    // force ONE fresh login and retry the request ONCE.
    if (authMode === 'login' && !opts.retried401) {
      forgetCachedToken()
      const fresh = await acquireLoginToken()
      return sendJson(
        path,
        init,
        { Authorization: `Bearer ${fresh}`, ...init.headers },
        baseUrl,
        timeoutMs,
        authMode,
        { retried401: true }
      )
    }
    throw new CrewDeskError('unauthorized', 'Crew Desk rejected the request (credentials expired or invalid). Ask an admin to refresh the Crew Desk credentials.', res.status)
  }
  if (!res.ok) {
    const msg = errorMessage(json)
    // The Crew Desk error envelope is authoritative: {"status":"error",
    // "success":false,"message":"Ticket not found"} — classify by its message
    // regardless of the HTTP status it rode in on.
    if (msg && /not found/i.test(msg)) {
      throw new CrewDeskError('not_found', msg, res.status)
    }
    // Edge/proxy outages (502/503/504) mean Crew Desk itself is down/unreachable.
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new CrewDeskError('unreachable', `Crew Desk is unreachable right now (HTTP ${res.status}). Try again later.`, res.status)
    }
    throw new CrewDeskError('http', msg ?? `Crew Desk returned HTTP ${res.status}.`, res.status)
  }
  return json
}

/** Extracts {"status":"error","success":false,"message":"..."} style messages. */
function errorMessage(json: unknown): string | null {
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>
    if (typeof obj.message === 'string') return obj.message
  }
  return null
}

function isCrewDeskErrorEnvelope(json: unknown): boolean {
  if (!json || typeof json !== 'object') return false
  const obj = json as Record<string, unknown>
  return obj.status === 'error' && obj.success === false
}

function dataOf(json: unknown): Record<string, unknown> | null {
  if (!json || typeof json !== 'object') return null
  const obj = json as Record<string, unknown>
  if (obj.data && typeof obj.data === 'object') return obj.data as Record<string, unknown>
  return obj
}

// ---------- 1. Get ticket — THE single point of change ----------

export interface CrewDeskTicket {
  id: string
  title: string
  /** Human-readable status for DISPLAY (e.g. "In Progress"). */
  status: string
  /** Machine status for POSTING (e.g. "in-progress"). The comments endpoint
   *  validates the `status` form field against slugs — display names and
   *  numeric ids are both rejected with {"message":"Invalid status"} — so
   *  callers post statusSlug ?? status. Null when the response carries no
   *  slug (older deployments); the poster then falls back to the display
   *  status, which produces a recoverable failed row at worst. */
  statusSlug: string | null
}

export async function getTicket(ticketId: string): Promise<CrewDeskTicket> {
  const json = await requestJson(`/api/tickets/${encodeURIComponent(ticketId)}`, { method: 'GET' })

  if (isCrewDeskErrorEnvelope(json)) {
    throw new CrewDeskError('not_found', errorMessage(json) ?? 'Ticket not found')
  }

  const data = dataOf(json)
  const ticket = (data?.ticket ?? data) as Record<string, unknown> | undefined
  const id = str(ticket?.id ?? ticket?.ticket_id ?? ticketId)
  const title = str(ticket?.title ?? ticket?.subject ?? ticket?.name)
  // Display status prefers the human name; a ticket object carries MANY
  // status-ish fields (status_id, status_name, status_slug, status_category)
  // and only status_name reads as text (the dev backend has no `status` key).
  const status = str(ticket?.status_name ?? ticket?.status ?? ticket?.current_status)
  const statusSlug = str(ticket?.status_slug) || null

  // Fail safe: if we cannot confidently read title + status we must NOT post
  // a comment (the comment echoes the ticket's current status — guessing
  // could move the ticket).
  if (!title || !status) {
    throw new CrewDeskError('unexpected', 'Crew Desk answered, but the ticket response shape was not recognized. Comment not sent (getTicket needs the confirmed endpoint).')
  }
  return { id, title, status, statusSlug }
}

// ---------- 2. List assignable users (verification-only email check source) ----------

export interface CrewDeskUserRef {
  id: string
  /** Lowercased + trimmed by the client — matching is case-insensitive. */
  email: string
  name: string
}

/**
 * GET /api/users/assignable through the shared credentials. The FULL list is
 * consumed ONLY inside this module's callers (the identity check caches it in
 * memory and persists at most ONE matched id) — it is never returned to the
 * browser and never stored.
 */
export async function listAssignableUsers(): Promise<CrewDeskUserRef[]> {
  const json = await requestJson('/api/users/assignable', { method: 'GET' })
  if (isCrewDeskErrorEnvelope(json)) {
    throw new CrewDeskError('http', errorMessage(json) ?? 'Crew Desk refused the user list request.')
  }
  const data = dataOf(json)
  const raw = (data?.users ?? data?.data ?? data) as unknown
  if (!Array.isArray(raw)) {
    throw new CrewDeskError('unexpected', 'Crew Desk answered, but the user list shape was not recognized.')
  }
  const users: CrewDeskUserRef[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const u = item as Record<string, unknown>
    const id = str(u.id ?? u.user_id ?? u.userId)
    const email = str(u.email ?? u.user_email).toLowerCase()
    const name = str(u.name ?? u.full_name ?? u.user_name)
    if (id && email) users.push({ id, email, name })
  }
  return users
}

// ---------- 3. Post comment (form-data ONLY; never changes ticket status) ----------

export interface PostedComment {
  commentId: string
}

export interface PostCommentInput {
  ticketId: string
  /** Plain text; include the bare module URL so Crew Desk renders it clickable. */
  content: string
  /** The ticket's CURRENT status as the machine SLUG (e.g. "in-progress") —
   *  echoed back so the status cannot change. Verified against the dev
   *  backend 2026-10-09: slugs are accepted; display names ("In Progress")
   *  and numeric ids ("4") both fail with "Invalid status". */
  ticketStatus: string
}

export async function postTicketComment(input: PostCommentInput): Promise<PostedComment> {
  // SAFETY GUARD — runs before any network I/O. In test mode only the
  // designated test ticket may ever receive a comment. CREWDESK_MODE must be
  // exactly "live" (set deliberately on the production server) to widen this.
  const allowedTicket = testAllowedTicketId()
  if (crewDeskMode() !== 'live' && input.ticketId !== allowedTicket) {
    throw new CrewDeskError(
      'mode_guard',
      `Blocked by safety policy: CREWDESK_MODE=test allows Crew Desk comments only on ticket ${allowedTicket}. Nothing was sent.`,
    )
  }

  // Comment author: ALWAYS the shared service account. CREWDESK_USER_ID is
  // the source of truth; the credential's own user_id claim is the fallback
  // (with a startup warning when both exist and disagree). The logged-in
  // human's Crew Desk id is never sent.
  const authorId = sharedAccountUserId()
  if (!authorId) {
    throw new CrewDeskError('config', 'Cannot determine the shared comment author: set CREWDESK_USER_ID (or provide a JWT credential with a user_id claim).')
  }

  // multipart/form-data ONLY — the real endpoint does not accept JSON.
  const form = new FormData()
  form.append('content', input.content)
  form.append('type', 'comment')
  form.append('user_id', authorId)
  form.append('status', input.ticketStatus)
  // NOTE: `status` must be the status SLUG (see PostCommentInput) and no
  // `status_id` field is ever sent — the ticket stays exactly where it is.

  const json = await requestJson(`/api/tickets/${encodeURIComponent(input.ticketId)}/comments`, {
    method: 'POST',
    // Do NOT set Content-Type manually — fetch adds the multipart boundary.
    body: form,
  })

  if (isCrewDeskErrorEnvelope(json)) {
    throw new CrewDeskError('http', errorMessage(json) ?? 'Crew Desk rejected the comment.')
  }

  const data = dataOf(json)
  const comment = (data?.comment ?? data) as Record<string, unknown> | undefined
  const commentId = str(
    comment?.id ?? comment?.comment_id ?? data?.comment_id ?? comment?.commentId ?? data?.id
  )
  if (!commentId) {
    throw new CrewDeskError('unexpected', 'Crew Desk accepted the request but did not return a comment id.')
  }
  return { commentId }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''
}
