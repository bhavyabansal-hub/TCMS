// STEP 0 diagnostic (owner task: "fix realtime reconnect after a service outage").
// Proves or disproves the suspected stale-ticket root cause with REAL reason
// codes. NO product code is changed by this script.
//
// Mirrors src/hooks/use-notification-socket.ts behavior exactly:
//   io(url, { path, transports:['websocket','polling'], reconnection:true,
//             reconnectionAttempts:Infinity, reconnectionDelay:1000,
//             reconnectionDelayMax:10000 })
//   connect    -> fetch fresh ticket from app -> emit 'auth' { userId, token }
//   auth-error -> fetch fresh ticket -> emit 'auth'   (hook's retry)
//   disconnect -> manual backoff timer min(30000, 1000*2^n) -> socket.connect()
//
// Modes:
//   --phase expired   Deterministic replay of the SUSPECTED bug: the first auth
//                     presents an EXPIRED (valid-signature) ticket — exactly
//                     what a client reconnecting >60s later would present IF it
//                     reused its first ticket. Logs the client disconnect REASON
//                     the server's rejection produces, and whether the hook's
//                     current logic recovers on this socket with a fresh ticket.
//   --phase outage    Long-running logger: connect, then survive an externally
//                     driven service stop/start (orchestrator kills/restarts
//                     :3003); proves whether the client re-authenticates and
//                     re-joins the room (live /notify received) with no reload.
//
// Connects DIRECTLY to :3003 (path '/') — identical server-side auth flow; the
// sandbox gateway is transport only and not under test. Never prints secrets.
//
// Usage: node scripts/ws-outage-diag.mjs --phase expired
//        node scripts/ws-outage-diag.mjs --phase outage --hold-ms 150000

import { io } from 'socket.io-client'
import { readFileSync } from 'fs'
import { createHmac } from 'crypto'

const args = process.argv.slice(2)
const phase = args.includes('--phase') ? args[args.indexOf('--phase') + 1] : 'expired'
const holdMs = Number(args.includes('--hold-ms') ? args[args.indexOf('--hold-ms') + 1] : 150000)

const WS_URL = 'http://localhost:3003'
const WS_PATH = '/'
const APP = 'http://localhost:3000'

const secret =
  (readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .find((l) => l.startsWith('WS_NOTIFY_SECRET=')) || '')
    .slice('WS_NOTIFY_SECRET='.length).trim()
if (!secret) { console.error('FATAL: WS_NOTIFY_SECRET not resolvable'); process.exit(2) }

const T0 = Date.now()
const ts = () => `t+${(Math.round((Date.now() - T0) / 100) / 10).toFixed(1)}s`
const log = (...a) => console.log(ts(), ...a)

// ---------- app session (cookie auth, same as the browser) ----------
const loginRes = await fetch(`${APP}/api/auth?path=login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms' },
  body: JSON.stringify({ email: 'admin@tcms.com', password: 'Admin@123' }),
})
const cookies = loginRes.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
const login = await loginRes.json()
if (!loginRes.ok || !login?.user?.userId) { console.error('FATAL: admin login failed', loginRes.status); process.exit(2) }
const userId = login.user.userId
log(`app session ok (userId=${userId})`)

async function fetchTicket() {
  const r = await fetch(`${APP}/api/auth?path=ws-ticket`, { headers: { Cookie: cookies, 'X-Requested-With': 'tcms' } })
  if (!r.ok) return { status: r.status }
  const j = await r.json()
  return { status: r.status, ticket: j.ticket }
}

function makeTicket(sub, expOffsetSec) {
  const body = Buffer.from(JSON.stringify({ sub, aud: 'tcms-ws', exp: Math.floor(Date.now() / 1000) + expOffsetSec })).toString('base64url')
  const sig = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${sig}`
}

async function notify(title) {
  const r = await fetch('http://127.0.0.1:3004/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-notify-secret': secret },
    body: JSON.stringify({ userId, title, body: 'ws-outage-diag', type: 'system' }),
  })
  log(`POST /notify "${title}" -> ${r.status}`)
  return r.status
}

// ---------- socket mirroring the production hook ----------
let connectCount = 0
let disconnectCount = 0
let authOkCount = 0
let authErrorCount = 0
let firstAuthForcedExpired = phase === 'expired'
let gotLiveNotification = false
let lastConnectAt = 0
let authOkAfterRecovery = false

const socket = io(WS_URL, {
  path: WS_PATH,
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 10000,
})

socket.on('connect', async () => {
  connectCount += 1
  lastConnectAt = Date.now()
  let transport = '?'
  try { transport = socket.io.engine.transport.name } catch { /* engine not ready */ }
  log(`EVENT connect #${connectCount} id=${socket.id} transport=${transport}`)
  if (firstAuthForcedExpired) {
    firstAuthForcedExpired = false
    log('emit auth with FORCED-EXPIRED ticket (valid signature, exp -600s) — replays the suspected stale-ticket reconnect')
    socket.emit('auth', { userId, token: makeTicket(userId, -600) })
    return
  }
  const t = await fetchTicket()
  if (!t.ticket) { log(`ticket fetch FAILED status=${t.status} — hook catch path (stays unauthenticated)`); return }
  log(`emit auth with FRESH ticket (fetched ${Date.now() - lastConnectAt}ms after connect, http ${t.status})`)
  socket.emit('auth', { userId, token: t.ticket })
})

socket.on('auth-ok', (d) => {
  authOkCount += 1
  if (connectCount > 1) authOkAfterRecovery = true
  log(`EVENT auth-ok #${authOkCount} ${JSON.stringify(d)}`)
})

socket.on('auth-error', async (d) => {
  authErrorCount += 1
  log(`EVENT auth-error #${authErrorCount} ${JSON.stringify(d)} -> hook retry: fetching fresh ticket`)
  const t = await fetchTicket()
  if (t.ticket) {
    log(`emit auth RETRY with fresh ticket (socket.connected=${socket.connected} at emit time)`)
    socket.emit('auth', { userId, token: t.ticket })
  } else {
    log(`ticket fetch FAILED status=${t.status} (hook catch path — no retry emitted)`)
  }
})

// The hook's disconnect handler: manual backoff timer -> socket.connect()
let reconnectAttempts = 0
let reconnectTimer = null
socket.on('disconnect', (reason) => {
  disconnectCount += 1
  log(`EVENT disconnect #${disconnectCount} REASON="${reason}"`)
  if (reconnectTimer) clearTimeout(reconnectTimer)
  const delay = Math.min(30000, 1000 * 2 ** reconnectAttempts)
  reconnectAttempts += 1
  log(`manual backoff timer set: ${delay}ms -> socket.connect()`)
  reconnectTimer = setTimeout(() => { log('manual socket.connect() FIRED'); socket.connect() }, delay)
})

socket.on('connect_error', (err) => {
  log(`EVENT connect_error msg="${String(err && err.message)}"`)
})

const mgr = socket.io
mgr.on('reconnect_attempt', (attempt) => log(`manager reconnect_attempt #${attempt}`))
mgr.on('reconnect', (attempt) => log(`manager reconnect #${attempt}`))
mgr.on('reconnect_error', () => log('manager reconnect_error'))
mgr.on('reconnect_failed', () => log('manager reconnect_failed'))

socket.on('notification', (d) => {
  gotLiveNotification = true
  log(`EVENT notification "${d?.title}" (room membership is LIVE again)`)
})

// ---------- phase orchestration ----------
if (phase === 'expired') {
  await new Promise((r) => setTimeout(r, 4000)) // rejection + server disconnect + manual reconnect cycle
  await notify('diag: post-recovery room check (expired phase)')
  await new Promise((r) => setTimeout(r, 2000))
  log(`SUMMARY expired-phase: connects=${connectCount} disconnects=${disconnectCount} authErrors=${authErrorCount} authOks=${authOkCount} authOkAfterRecovery=${authOkAfterRecovery} liveNotification=${gotLiveNotification}`)
  const recovered = authOkAfterRecovery && gotLiveNotification
  log(recovered
    ? 'VERDICT: hook logic RECOVERED from a server-rejected (expired) ticket on the same socket'
    : 'VERDICT: hook logic DID NOT recover — realtime is dead on this socket until reload')
  socket.disconnect()
  process.exit(recovered ? 0 : 1)
} else {
  log(`outage phase: logging for ${holdMs}ms — orchestrator stops/starts the WS service externally`)
  await new Promise((r) => setTimeout(r, holdMs))
  await notify('diag: post-outage room check (outage phase)')
  await new Promise((r) => setTimeout(r, 3000))
  log(`SUMMARY outage-phase: connects=${connectCount} disconnects=${disconnectCount} authErrors=${authErrorCount} authOks=${authOkCount} authOkAfterRecovery=${authOkAfterRecovery} liveNotification=${gotLiveNotification}`)
  const recovered = authOkAfterRecovery && gotLiveNotification
  log(recovered
    ? 'VERDICT: client RE-AUTHENTICATED and re-joined the room after the outage (no reload)'
    : 'VERDICT: client did NOT re-join the room after the outage')
  socket.disconnect()
  process.exit(recovered ? 0 : 1)
}
