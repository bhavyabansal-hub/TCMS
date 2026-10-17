// Notifications WebSocket mini-service.
//
// SECURITY (audit 2026-10-09) — previously ANY socket could claim ANY
// userId (the client sent token:'dev' and the token was never checked), so
// anyone reaching this port could eavesdrop on (or inject notifications
// into) any user's stream. Now:
//   1. Socket auth REQUIRES a short-lived HMAC ticket issued by the app
//      (GET /api/auth?path=ws-ticket, 60s TTL, audience 'tcms-ws').
//      Verification uses the exact same HMAC-SHA256 code as the app
//      (node:crypto, no dependencies) and the shared WS_NOTIFY_SECRET.
//   2. POST /notify (the app's broadcast endpoint) requires the
//      x-notify-secret header to match WS_NOTIFY_SECRET.
//   3. Fail closed: with no secret configured, no socket is ever joined
//      and every broadcast is refused.

import { createServer, IncomingMessage } from 'http'
import { readFileSync } from 'fs'
import { Server, Socket } from 'socket.io'
import { createHmac, timingSafeEqual } from 'crypto'
import {
  assertWsServiceStartup,
  isProductionDeployment,
} from '../../src/lib/server/startup-guard'

const PORT = Number(process.env.WS_PORT || 3003)
// Internal port for the server-to-server broadcast endpoint (POST /notify).
// Needed because the sandbox gateway convention attaches socket.io with path
// '/', which makes engine.io intercept every request on PORT — including
// POSTs meant for the custom handler. The broadcast endpoint therefore gets
// its own loopback-only listener; the public PORT stays purely for socket
// clients (in production the path is '/socket.io/' by default, but the
// loopback split stays: the broadcast endpoint is never proxy-facing).
const NOTIFY_PORT = Number(process.env.NOTIFY_PORT || 3004)
const AUDIENCE = 'tcms-ws'

// ---------- Path / CORS resolution ----------
// DEPLOYMENT SWITCH (task startup-guard-1): TCMS_DEPLOY_ENV=production is the
// explicit production declaration IT sets on the real server. It deliberately
// REPLACED the old NODE_ENV key: a plain `bun index.ts` sets no NODE_ENV, so
// the previous key never fired on a real server (the CORS guard was dead code
// there and the path defaulted to the sandbox '/'). The sandbox sets no
// TCMS_DEPLOY_ENV — its behavior is unchanged.
const DEPLOY_PROD = isProductionDeployment()
// Socket.io path — production default '/socket.io/': a REAL path a reverse
// proxy can route (nginx/Apache/IIS recipes in
// docs/deploy/reverse-proxy-websocket.md), so production needs NO extra env.
// Non-production default '/' is the sandbox platform-gateway convention
// (proxied by ?XTransformPort= query param).
const SOCKET_PATH = process.env.WS_SOCKET_PATH || (DEPLOY_PROD ? '/socket.io/' : '/')

// Browser origins allowed to open socket connections (comma-separated list).
// PRODUCTION REFUSES TO START when WS_CORS_ORIGIN is unset or contains '*'
// — fail-closed, same spirit as WS_NOTIFY_SECRET: an open CORS policy on a
// socket endpoint would let any website open sockets against this service.
const CORS_RAW = (process.env.WS_CORS_ORIGIN ?? '').trim()
const CORS_ORIGINS = CORS_RAW
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

// ---------- Shared secret resolution ----------
// The app and this service MUST agree on WS_NOTIFY_SECRET. Resolution order:
// process.env -> the repo's .env (two levels up; this service runs with cwd
// = mini-services/notifications). Fail closed when missing.

function readSecretFromEnvFile(): string {
  try {
    const envText = readFileSync(new URL('../../.env', import.meta.url), 'utf8')
    const line = envText.split('\n').find((l) => l.startsWith('WS_NOTIFY_SECRET='))
    if (line) return line.slice('WS_NOTIFY_SECRET='.length).trim()
  } catch {
    /* fall through */
  }
  return ''
}

// Resolve the shared secret BEFORE the startup guard runs, so the guard sees
// exactly the value this service will use (env first, then the repo .env —
// the historical resolution order, preserved).
if (!process.env.WS_NOTIFY_SECRET) {
  const fromEnvFile = readSecretFromEnvFile()
  if (fromEnvFile) process.env.WS_NOTIFY_SECRET = fromEnvFile
}
const SECRET = process.env.WS_NOTIFY_SECRET ?? ''

// ---------- PRODUCTION STARTUP GUARD (task startup-guard-1) ----------
// Prints the one-line boot state — 'production guard ACTIVE' or
// 'production guard OFF (sandbox mode)' — and, in production, REFUSES to
// start (exit 1, before any listener opens) when WS_NOTIFY_SECRET is
// missing, shorter than 32 characters, or a known placeholder. The reason
// names the variable, never the value. Contract:
// src/lib/server/startup-guard.ts.
assertWsServiceStartup()

// CORS refusal — fail-closed (rationale in the CORS block above), keyed on
// the TCMS_DEPLOY_ENV switch rather than NODE_ENV (see DEPLOY_PROD note).
if (DEPLOY_PROD && (CORS_ORIGINS.length === 0 || CORS_ORIGINS.includes('*'))) {
  console.error(
    `[TCMS] FATAL: WS_CORS_ORIGIN must list explicit origin(s) in production ` +
      `(got: ${CORS_RAW === '' ? '<unset>' : `'${CORS_RAW}'`}).\n` +
      `[TCMS] Refusing to start. Example: WS_CORS_ORIGIN=https://tcms.yourcompany.com`
  )
  process.exit(1)
}

// ---------- Ticket verification (mirrors src/lib/server/ws-ticket.ts) ----------

function hmac(data: string): string {
  return createHmac('sha256', SECRET).update(data).digest('base64url')
}

function verifyWsTicket(token: string | undefined): string | null {
  if (!token || !SECRET) return null
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = hmac(body)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (payload.aud !== AUDIENCE) return null
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null
    if (!payload.sub) return null
    return String(payload.sub)
  } catch {
    return null
  }
}

// ---------- Loopback broadcast endpoint (secret-checked) ----------

function handleNotifyRequest(req: IncomingMessage, res: any) {
  // Loopback-only, server-to-server endpoint; the secret header proves the caller
  // is the app. No CORS headers: browsers must never be able to call it.
  if (req.method === 'POST' && (req.url ?? '').split('?')[0] === '/notify') {
    if (!SECRET || req.headers['x-notify-secret'] !== SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized broadcaster' }))
      return
    }
    let body = ''
    req.on('data', (chunk) => (body += chunk.toString()))
    req.on('end', () => {
      try {
        const payload = JSON.parse(body)
        // Broadcast to the target user's sockets
        const { userId, ...rest } = payload
        io.to(`user:${userId}`).emit('notification', rest)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid JSON' }))
      }
    })
    return
  }
  res.writeHead(404)
  res.end('Not found')
}

// Public socket server. engine.io (path '/') intercepts every request on
// this port — that is intentional: PORT serves socket clients only. The
// HTTP broadcast endpoint lives on NOTIFY_PORT below.
const httpServer = createServer((req, res) => {
  res.writeHead(404)
  res.end('Not found')
})

const io = new Server(httpServer, {
  path: SOCKET_PATH,
  // Explicit origins from WS_CORS_ORIGIN; in non-production (sandbox) the
  // permissive gateway default applies. In production an unset/'*' value
  // never reaches here — the startup guard above has already exited.
  cors: CORS_ORIGINS.length
    ? { origin: CORS_ORIGINS, methods: ['GET', 'POST'] }
    : DEPLOY_PROD
      ? undefined
      : { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

// Loopback broadcast endpoint — see NOTIFY_PORT note above.
const notifyServer = createServer(handleNotifyRequest)

const socketsByUser = new Map<string, Set<string>>()

io.on('connection', (socket: Socket) => {
  console.log(`[WS] socket connected: ${socket.id}`)

  // Client sends { userId, token } after connect. The token MUST be a valid,
  // unexpired ticket for EXACTLY the claimed userId (signature-checked).
  socket.on('auth', (payload: { userId?: string; token?: string }) => {
    const claimed = payload?.userId
    const subject = verifyWsTicket(payload?.token)
    if (!subject || !claimed || subject !== claimed) {
      socket.emit('auth-error', { message: 'Invalid or expired ticket' })
      // Owner rule (2026-10-14): rejected sockets are DISCONNECTED, not left
      // attached. A rejected socket has no room and can never gain one —
      // every retry faces the same verification — so dropping it is pure
      // hygiene and stops clients from holding dead connections. The client
      // hook auto-reconnects and presents a FRESH ticket on the next connect.
      socket.disconnect()
      return
    }
    socket.join(`user:${subject}`)
    if (!socketsByUser.has(subject)) socketsByUser.set(subject, new Set())
    socketsByUser.get(subject)!.add(socket.id)
    socket.data.userId = subject
    socket.emit('auth-ok', { userId: subject })
    console.log(`[WS] user ${subject} authenticated on socket ${socket.id}`)
  })

  socket.on('ping', () => {
    socket.emit('pong', { ts: Date.now() })
  })

  socket.on('disconnect', () => {
    const userId = socket.data.userId as string | undefined
    if (userId) {
      const set = socketsByUser.get(userId)
      if (set) {
        set.delete(socket.id)
        if (set.size === 0) socketsByUser.delete(userId)
      }
    }
    console.log(`[WS] socket disconnected: ${socket.id}`)
  })

  socket.on('error', (err: unknown) => {
    console.error(`[WS] socket error (${socket.id}):`, err)
  })
})

httpServer.listen(PORT, () => {
  console.log(
    `[TCMS] Notifications WebSocket service running on port ${PORT} ` +
      `(path '${SOCKET_PATH}', cors ${DEPLOY_PROD ? CORS_ORIGINS.join(' | ') : '*'}, ` +
      `ticket auth ${SECRET ? 'ENABLED' : 'FAIL-CLOSED: WS_NOTIFY_SECRET missing'})`
  )
})

notifyServer.listen(NOTIFY_PORT, '127.0.0.1', () => {
  console.log(
    `[TCMS] Notify broadcast endpoint listening on 127.0.0.1:${NOTIFY_PORT} ` +
      `(secret ${SECRET ? 'required' : 'MISSING — broadcasts refused'})`
  )
})

process.on('SIGTERM', () => {
  console.log('[TCMS] SIGTERM received, shutting down...')
  notifyServer.close()
  httpServer.close(() => process.exit(0))
})
process.on('SIGINT', () => {
  console.log('[TCMS] SIGINT received, shutting down...')
  notifyServer.close()
  httpServer.close(() => process.exit(0))
})
