// PERMANENT reconnect verifier (owner task 2026-10-14: "fix realtime reconnect
// after a service outage"). Node-level mirror of the NEW hook policy in
// src/hooks/use-notification-socket.ts:
//   - socket.io `auth` callback mints a FRESH ticket per connection attempt,
//     single-use (attempt-stamped slot, stale-guard, consumed on connect)
//   - 'io server disconnect' -> hook reconnect with backoff (1s -> 30s cap)
//   - 'io client disconnect' -> never reconnect
//   - transport drops -> manager retry (1s -> 10s cap, Infinity attempts)
//   - definitive session death (ticket endpoint 401 after hard refresh fail)
//     -> machinery stopped, no further attempts
// Phases:
//   A  expired-ticket replay: first auth presents an EXPIRED (valid-signature)
//      ticket -> server auth-error + io server disconnect -> policy must
//      recover with a fresh ticket and receive a live /notify.
//   B  outage: the REAL :3003 service is killed for --outage-ms (default
//      10000) and restarted -> client must re-authenticate + rejoin (live
//      /notify). ALWAYS restores the service in a finally.
//   C  stop-on-session-death: poisoned cookies (expired access JWT + garbage
//      refresh) -> mint fails hard -> machinery must STOP (no reconnect
//      attempts for 10s).
// Usage: node scripts/ws-reconnect-test.mjs [--outage-ms 10000]
import { io } from 'socket.io-client'
import { execSync, spawn } from 'child_process'
import { readFileSync, openSync } from 'fs'
import { createHmac } from 'crypto'

const args = process.argv.slice(2)
const OUTAGE_MS = Number(args.includes('--outage-ms') ? args[args.indexOf('--outage-ms') + 1] : 10000)
const WS_URL = 'http://localhost:3003'
const WS_PATH = '/'
const APP = 'http://localhost:3000'
const ADMIN = { email: 'admin@tcms.com', password: 'Admin@123' }

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8')
const secret = (envText.split('\n').find((l) => l.startsWith('WS_NOTIFY_SECRET=')) || '').slice('WS_NOTIFY_SECRET='.length).trim()
const jwtSecret = (envText.split('\n').find((l) => l.startsWith('JWT_SECRET=')) || '').slice('JWT_SECRET='.length).trim()
if (!secret || !jwtSecret) { console.error('FATAL: secrets not resolvable'); process.exit(2) }

const results = []
function record(name, pass, detail = '') {
  results.push(pass)
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeTicket(sub, expOffsetSec) {
  const body = Buffer.from(JSON.stringify({ sub, aud: 'tcms-ws', exp: Math.floor(Date.now() / 1000) + expOffsetSec })).toString('base64url')
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}

async function login() {
  const r = await fetch(`${APP}/api/auth?path=login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms' },
    body: JSON.stringify(ADMIN),
  })
  const cookies = r.headers.getSetCookie().map((c) => c.split(';')[0])
  const body = await r.json()
  if (!r.ok || !body?.user?.userId) throw new Error(`login failed ${r.status}`)
  return { cookieHeader: cookies.join('; '), userId: body.user.userId }
}

// Mint exactly like the app's request helper chain: GET ticket -> on 401 try
// cookie refresh -> definitive rejection = hard death.
async function mint(cookieHeader) {
  const r = await fetch(`${APP}/api/auth?path=ws-ticket`, { headers: { Cookie: cookieHeader, 'X-Requested-With': 'tcms' } })
  if (r.ok) return { ticket: (await r.json()).ticket, hard: false }
  if (r.status !== 401) return { ticket: null, hard: false } // transient (5xx etc.)
  const rr = await fetch(`${APP}/api/auth?path=refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms', Cookie: cookieHeader },
    body: '{}',
  })
  if (rr.ok) {
    const fresh = rr.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    const r2 = await fetch(`${APP}/api/auth?path=ws-ticket`, { headers: { Cookie: fresh, 'X-Requested-With': 'tcms' } })
    return { ticket: r2.ok ? (await r2.json()).ticket : null, hard: false }
  }
  return { ticket: null, hard: true } // refresh definitively rejected -> session dead
}

async function notify(userId, title) {
  const r = await fetch('http://127.0.0.1:3004/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-notify-secret': secret },
    body: JSON.stringify({ userId, title, body: 'ws-reconnect-test', type: 'system' }),
  })
  return r.status
}

// --- the hook policy, mirrored ---
function makeClient({ session, firstAuthOverride, poisonedAfterConnect }) {
  return new Promise((resolveClient) => {
    const state = { attempts: 0, attemptCounter: 0, slot: null, stopped: false, everConnected: false, authOks: 0, manualConnects: 0, poisoned: false }
    const log = []
    const socket = io(WS_URL, {
      path: WS_PATH,
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      auth: async (cb) => {
        const attempt = ++state.attemptCounter
        let ticket = null
        let hard = false
        if (attempt === 1 && firstAuthOverride) {
          ticket = firstAuthOverride // phase A: replay the suspected stale ticket
        } else {
          const jar = state.poisoned ? poisonedAfterConnect : session.cookieHeader
          const m = await mint(jar)
          ticket = m.ticket
          hard = m.hard
        }
        log.push(`auth-callback attempt=${attempt} gotTicket=${!!ticket} hard=${hard}`)
        if (hard) {
          state.stopped = true
          cb({})
          socket.io.reconnection(false)
          socket.disconnect()
          return
        }
        if (attempt !== state.attemptCounter) return // stale-guard: superseded attempt -> DROP
        if (!ticket) { cb({}); return }
        state.slot = { attempt, ticket }
        cb({ ticket })
      },
    })
    socket.on('connect', () => {
      state.attempts = 0
      if (state.everConnected) log.push('RECONNECT connect')
      state.everConnected = true
      const slot = state.slot
      state.slot = null // consume: single use
      if (slot && slot.attempt === state.attemptCounter) socket.emit('auth', { userId: session.userId, token: slot.ticket })
    })
    socket.on('auth-ok', () => { state.authOks += 1; log.push('auth-ok') })
    socket.on('auth-error', (d) => log.push(`auth-error ${JSON.stringify(d)}`))
    socket.on('notification', (d) => log.push(`notification "${d?.title}"`))
    socket.on('disconnect', (reason) => {
      log.push(`disconnect reason="${reason}"`)
      if (state.stopped) return
      if (reason === 'io client disconnect') return
      if (reason === 'io server disconnect') {
        const delay = Math.min(30000, 1000 * 2 ** state.attempts)
        state.attempts += 1
        setTimeout(() => { state.manualConnects += 1; socket.connect() }, delay)
      }
    })
    socket.on('connect_error', (e) => log.push(`connect_error ${String(e).slice(0, 40)}`))
    const mgr = socket.io
    mgr.on('reconnect_attempt', (n) => log.push(`manager reconnect_attempt #${n}`))
    resolveClient({ socket, state, log })
  })
}

// --- service control (same recipe as start-tcms.sh; detached, no pipe trap) ---
function wsPid() {
  const out = execSync(`ss -tlnp 2>/dev/null | grep ':3003 ' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true`, { encoding: 'utf8', shell: '/bin/bash' }).trim()
  return out || null
}
function portUp(port) {
  return execSync(`ss -tln | grep ':${port} ' || true`, { encoding: 'utf8', shell: '/bin/bash' }).trim() !== ''
}
function startWs() {
  const out = openSync('/tmp/tcms-ws.log', 'a')
  const child = spawn('bun', ['index.ts'], { cwd: '/home/z/my-project/mini-services/notifications', detached: true, stdio: ['ignore', out, out] })
  child.unref()
}
async function ensureUp(label) {
  for (let i = 0; i < 40 && !portUp(3003); i++) await sleep(500)
  if (!portUp(3003)) { console.error(`FATAL[${label}]: :3003 not listening — stack left DOWN`); process.exit(2) }
}

// ================= PHASE A: expired-ticket replay =================
console.log('=== PHASE A: expired-ticket replay (suspected stale-ticket mechanism) ===')
{
  const session = await login()
  const { socket, state, log } = await makeClient({ session, firstAuthOverride: makeTicket(session.userId, -600) })
  await sleep(3500) // reject -> io server disconnect -> manual reconnect (1s) -> fresh ticket
  const gotAuthOk = state.authOks >= 1
  const st = await notify(session.userId, 'reconnect-test: phase A room check')
  await sleep(1500)
  const gotPush = log.some((l) => l.startsWith('notification "reconnect-test: phase A room check"'))
  record('A: expired ticket -> auth-error + io server disconnect, policy RECOVERS with fresh ticket', gotAuthOk && state.manualConnects >= 1, `authOks=${state.authOks} manualConnects=${state.manualConnects}`)
  record('A: room re-joined (live /notify received after recovery)', st === 200 && gotPush)
  socket.disconnect()
}
await sleep(500)

// ================= PHASE B: outage (--outage-ms) =================
console.log(`=== PHASE B: service outage ${OUTAGE_MS}ms (kill -9 -> restart) ===`)
try {
  const session = await login()
  const { socket, state, log } = await makeClient({ session })
  await sleep(1500) // connected + authed
  const pid = wsPid()
  if (!pid) throw new Error('no WS pid before outage')
  execSync(`kill -9 ${pid}`)
  await sleep(500)
  const down = !portUp(3003)
  await sleep(OUTAGE_MS)
  startWs()
  await ensureUp('phase B restart')
  const tUp = Date.now()
  let recovered = false
  for (let i = 0; i < 45; i++) { if (state.authOks >= 2) { recovered = true; break } await sleep(500) }
  const latency = Date.now() - tUp
  const st = await notify(session.userId, 'reconnect-test: phase B room check')
  await sleep(1500)
  const gotPush = log.some((l) => l.startsWith('notification "reconnect-test: phase B room check"'))
  record(`B: :3003 killed for ~${OUTAGE_MS + 500}ms (down=${down}), client re-authenticates WITHOUT reload`, down && recovered && state.authOks >= 2, `re-auth ~${latency}ms after restart, authOks=${state.authOks}`)
  record('B: room re-joined (live /notify received after outage)', st === 200 && gotPush)
  socket.disconnect()
} finally {
  // A failed test must NEVER leave the stack down.
  if (!portUp(3003)) { console.log('[cleanup] :3003 down after phase B — restarting'); startWs() }
  await ensureUp('phase B finally')
}
await sleep(500)

// ================= PHASE C: stop on definitive session death =================
console.log('=== PHASE C: session death -> machinery stops (no reconnect attempts) ===')
{
  const session = await login()
  const expiredJwt = execSync(
    `node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:'${session.userId}',email:'x@x.c',role:'viewer',fullName:'Probe',jti:'dead-probe'},process.env.JWT_SECRET,{expiresIn:'-10s'}))"`,
    { encoding: 'utf8', env: { ...process.env, JWT_SECRET: jwtSecret } }
  ).trim()
  const poisoned = `tcms-access=${expiredJwt}; tcms-refresh=garbage-token`
  const { socket, state, log } = await makeClient({ session, poisonedAfterConnect: poisoned })
  await sleep(1500) // connected + authed with the GOOD session
  // Poison BEFORE the outage: the reconnect attempt's auth callback runs
  // BEFORE its 'connect' event, so the jar must already be dead by then.
  state.poisoned = true
  const pid = wsPid()
  execSync(`kill -9 ${pid}`)
  await sleep(1200)
  startWs()
  await ensureUp('phase C restart')
  // next attempt mints with the POISONED jar -> hard death -> machinery stops
  await sleep(12000) // manager reaches the service within <=10s; stop must happen; then observe 10s of silence
  const stopIdx = log.findIndex((l) => l.includes('hard=true'))
  const after = stopIdx >= 0 ? log.slice(stopIdx + 1) : []
  const reconnectsAfterStop = after.filter((l) => l.includes('reconnect_attempt') || l.includes('RECONNECT connect')).length
  const disconnected = !socket.connected
  record('C: poisoned session (expired access + garbage refresh) -> mint hard-fails -> machinery STOPS', stopIdx >= 0 && disconnected && reconnectsAfterStop === 0, `stop seen=${stopIdx >= 0}, disconnected=${disconnected}, reconnect events after stop=${reconnectsAfterStop}`)
  socket.disconnect()
}

console.log('--- SUMMARY ---')
const fails = results.filter((r) => !r).length
console.log(`PASS=${results.length - fails} FAIL=${fails}`)
process.exit(fails ? 1 : 0)
