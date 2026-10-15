// Crew Desk MOCK server — stands in for https://api.crewdesk.shipgl.in in
// every automated test. Deliberately mimics the real API's quirks:
//   - comments are multipart/form-data ONLY (JSON is rejected with 400)
//   - the comment requires content, type=comment, user_id AND status
//     (the ticket's CURRENT status); sending status_id is rejected
//   - unknown tickets answer {"status":"error","success":false,"message":"Ticket not found"}
//   - a comment NEVER changes the ticket's status
//   - wrong/expired bearer token -> 401
// It ONLY defines test tickets; anything else is "Ticket not found".
//
// AUTH (two ways, like the real thing):
//   - Fixed token: every /api call with `Bearer $MOCK_CREWDESK_TOKEN` passes.
//   - Login:       POST /api/login {email, password} -> {token: <JWT>} with a
//                  1-hour exp claim + a mock epoch claim. Credentials come
//                  from MOCK_CREWDESK_LOGIN_EMAIL / MOCK_CREWDESK_LOGIN_PASSWORD.
//                  Wrong credentials -> 401 and a counted failure.
// TOKEN EPOCH: arming the `badtoken` fault bumps the epoch. JWTs issued before
// that instantly 401 (simulating expiry/rotation) while /api/login keeps
// working — so clients can prove their 401 -> re-login -> retry recovery.
//
// Fault injection for failure-path tests (control endpoints under /__mock,
// guarded by the same bearer token):
//   POST /__mock/config  {"mode":"ok"|"down"|"slow"|"badtoken"}
//   POST /__mock/reset   (clears comments + faults + stats)
//   GET  /__mock/comments | /__mock/tickets | /__mock/stats
//
// ALL emails/names here are FICTIONAL (@crewdesk.test) — real people's
// emails must never appear in code, tests or docs.
//
// PORT: 3010 (loopback only). Started by scripts/start-tcms.sh when
// CREWDESK_BASE_URL is not provided (or points at this mock).
import { createHmac } from 'node:crypto'
import {
  isProductionDeployment,
  printProductionGuardState,
} from '../../src/lib/server/startup-guard'

// PRODUCTION KILL-SWITCH (owner decision, task startup-guard-1 — STRONGER
// than the secret guard): this whole service is a TEST DOUBLE with hardcoded
// fictional data and well-known placeholder credentials. In a production
// deployment (TCMS_DEPLOY_ENV=production) it must NEVER run — regardless of
// what its mock secrets are — so it refuses unconditionally.
printProductionGuardState()
if (isProductionDeployment()) {
  console.error(
    '[TCMS] FATAL (tcms-crewdesk-mock): the Crew Desk MOCK service is a test ' +
      'double and must never run in a production deployment ' +
      '(TCMS_DEPLOY_ENV=production). Refusing to start.'
  )
  process.exit(1)
}

interface MockTicket {
  id: string
  title: string
  status: string
}

// The ONLY tickets this mock knows. 1355 is the designated test ticket
// (CREWDESK_TEST_TICKET_ID=1355); 4191 exists so the test-mode guard can be
// proven to REFUSE a second ticket. All MOCK ONLY.
const TICKETS: MockTicket[] = [
  { id: '1355', title: 'TCMS Testing ticket (MOCK)', status: 'Open' },
  { id: '4191', title: 'Crew Desk mock secondary ticket (MOCK ONLY)', status: 'Open' },
  { id: '4192', title: 'Crew Desk mock done ticket (MOCK ONLY)', status: 'Done' },
]

// Crew Desk user list used by the verification-only email check.
// FICTIONAL accounts only. 'Mixed.Case' proves lowercase matching; the
// external-only account is deliberately absent from TCMS.
const ASSIGNABLE = [
  { id: '7001', email: 'tcms.service@crewdesk.test', name: 'TCMS Service' },
  { id: '7002', email: 'dana.reyes@crewdesk.test', name: 'Dana Reyes' },
  { id: '7003', email: 'Mixed.Case@crewdesk.test', name: 'Mixed Case' },
  { id: '7004', email: 'external.only@crewdesk.test', name: 'External Only' },
]

const PORT = 3010
const TOKEN = process.env.MOCK_CREWDESK_TOKEN || 'mock-local-token'
const LOGIN_EMAIL = process.env.MOCK_CREWDESK_LOGIN_EMAIL || 'tcms.service@crewdesk.test'
const LOGIN_PASSWORD = process.env.MOCK_CREWDESK_LOGIN_PASSWORD || 'mock-login-secret'
const LOGIN_SECRET = process.env.MOCK_CREWDESK_JWT_SECRET || 'mock-only-secret-not-real'
const SLOW_MS = 12_000 // longer than the client timeout (8s) -> timeout error

let faultMode: 'ok' | 'down' | 'slow' | 'badtoken' = 'ok'
let tokenEpoch = 1
let commentSeq = 0
const comments: Array<Record<string, string>> = []
const stats = { loginAttempts: 0, loginSuccesses: 0, loginFailures: 0 }

const errorBody = (message: string, status = 400) =>
  Response.json({ status: 'error', success: false, message }, { status })
const okBody = (data: unknown, status = 200) =>
  Response.json({ status: 'success', success: true, data }, { status })

const b64url = (s: string) =>
  Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function hmac(data: string): string {
  return createHmac('sha256', LOGIN_SECRET).update(data).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function issueJwt(): string {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'HS256' }))
  const payload = b64url(
    JSON.stringify({ user_id: '7001', email: LOGIN_EMAIL, iat: now, exp: now + 3600, epoch: tokenEpoch })
  )
  return `${header}.${payload}.${hmac(`${header}.${payload}`)}`
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function authorized(req: Request): boolean {
  const header = req.headers.get('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return false
  const token = header.slice(7)
  const payload = decodeJwtPayload(token)
  if (payload) {
    // JWT path: signature (mock) + CURRENT epoch. A stale epoch = expired token.
    const sig = token.split('.')[2]
    const expected = hmac(token.split('.').slice(0, 2).join('.'))
    if (sig !== expected) return false
    return payload.epoch === tokenEpoch
  }
  // Fixed-token path: rejected whenever the badtoken fault is armed.
  if (faultMode === 'badtoken') return token === 'rotated-token'
  return token === TOKEN
}

function findTicket(id: string): MockTicket | undefined {
  return TICKETS.find((t) => t.id === id)
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname.replace(/\/+$/, '')

  // ----- control plane (same bearer, no fault modes apply) -----
  if (path.startsWith('/__mock')) {
    if (!req.headers.get('authorization')) return errorBody('Unauthorized', 401)
    if (path === '/__mock/config' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { mode?: string }
      const mode = body.mode
      if (mode === 'ok' || mode === 'down' || mode === 'slow' || mode === 'badtoken') {
        faultMode = mode
        if (mode === 'badtoken') tokenEpoch += 1 // invalidate issued JWTs
        return okBody({ mode })
      }
      return errorBody('mode must be ok | down | slow | badtoken')
    }
    if (path === '/__mock/reset' && req.method === 'POST') {
      faultMode = 'ok'
      commentSeq = 0
      comments.length = 0
      stats.loginAttempts = 0
      stats.loginSuccesses = 0
      stats.loginFailures = 0
      // NOTE: tokenEpoch is deliberately NOT bumped here — a reset must not
      // invalidate tokens issued before the test run. Only arming `badtoken`
      // rotates the epoch.
      return okBody({ reset: true })
    }
    if (path === '/__mock/comments') return okBody({ comments: [...comments], count: comments.length })
    if (path === '/__mock/tickets') return okBody({ tickets: TICKETS })
    if (path === '/__mock/stats') return okBody({ stats, epoch: tokenEpoch, faultMode })
    return errorBody('Not found', 404)
  }

  if (!path.startsWith('/api/')) return errorBody('Not found', 404)

  // ----- POST /api/login (auth mode (b); OUTSIDE fault modes on purpose —
  // a down Crew Desk cannot be logged into, but a rotated token must be) ----
  if (path === '/api/login' && req.method === 'POST') {
    if (faultMode === 'down') return new Response('Bad gateway', { status: 502 })
    if (faultMode === 'slow') await new Promise((resolve) => setTimeout(resolve, SLOW_MS))
    stats.loginAttempts += 1
    const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string }
    if (body.email !== LOGIN_EMAIL || body.password !== LOGIN_PASSWORD) {
      stats.loginFailures += 1
      return errorBody('Invalid email or password', 401)
    }
    stats.loginSuccesses += 1
    return okBody({ token: issueJwt(), tokenType: 'Bearer', expiresIn: 3600 })
  }

  // ----- fault modes (only affect the remaining /api plane) -----
  if (faultMode === 'down') {
    return new Response('Bad gateway', { status: 502 })
  }
  if (faultMode === 'slow') {
    await new Promise((resolve) => setTimeout(resolve, SLOW_MS))
  }

  if (!authorized(req)) return errorBody('Unauthorized', 401)

  // ----- GET /api/users/assignable (email-check source; NEVER returned to browsers by TCMS) -----
  if (path === '/api/users/assignable' && req.method === 'GET') {
    return okBody({ users: ASSIGNABLE })
  }

  // ----- GET /api/tickets/{id} -----
  const getTicketMatch = path.match(/^\/api\/tickets\/([^/]+)$/)
  if (getTicketMatch && req.method === 'GET') {
    const ticket = findTicket(decodeURIComponent(getTicketMatch[1]))
    if (!ticket) return errorBody('Ticket not found', 404)
    return okBody({ ticket: { id: ticket.id, title: ticket.title, status: ticket.status } })
  }

  // ----- POST /api/tickets/{id}/comments -----
  const commentMatch = path.match(/^\/api\/tickets\/([^/]+)\/comments$/)
  if (commentMatch && req.method === 'POST') {
    const ticket = findTicket(decodeURIComponent(commentMatch[1]))
    if (!ticket) return errorBody('Ticket not found', 404)

    const contentType = req.headers.get('content-type') ?? ''
    if (!contentType.startsWith('multipart/form-data')) {
      return errorBody('Unsupported Media Type: comments must be sent as multipart form-data (JSON is not accepted)')
    }

    const form = await req.formData()
    const content = String(form.get('content') ?? '')
    const type = String(form.get('type') ?? '')
    const userId = String(form.get('user_id') ?? '')
    const status = form.get('status')

    if (form.has('status_id')) {
      return errorBody('status_id must not be sent — comments may never change the ticket status')
    }
    if (!content.trim()) return errorBody('content is required')
    if (type !== 'comment') return errorBody('type must be "comment"')
    if (!userId.trim()) return errorBody('user_id is required')
    if (status === null || !String(status).trim()) return errorBody('status is required (send the ticket\'s current status)')

    // The ticket object above is NEVER mutated — a comment cannot move it.
    commentSeq += 1
    const comment = {
      id: `c-${1000 + commentSeq}`,
      ticket_id: ticket.id,
      content,
      type,
      user_id: userId,
      status: String(status),
    }
    comments.push(comment)
    return okBody({ comment }, 200)
  }

  return errorBody('Not found', 404)
}

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch(req) {
    return handle(req).catch((err) => {
      console.error('[crewdesk-mock] internal error:', err)
      return errorBody('Internal mock error', 500)
    })
  },
})

console.log(
  `[TCMS] Crew Desk MOCK running on http://127.0.0.1:${PORT} ` +
    `(fixed token: ${TOKEN ? 'set' : 'unset'}, login: ${LOGIN_EMAIL}, tickets: ${TICKETS.map((t) => t.id).join(', ')})`
)
