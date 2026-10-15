// STEP 0 live probe — is the WS notification service still open? (owner task)
// Tries the HISTORICAL attack (token:'dev' / no token / fake token / user-id
// swap / expired ticket) against the RUNNING service on :3003, then proves
// isolation + delivery with a REAL ticket. Read-only: /notify only emits to
// sockets, nothing is persisted. Never prints WS_NOTIFY_SECRET.
//
// Usage: node scripts/ws-auth-probe.mjs

import { io } from 'socket.io-client'
import { readFileSync } from 'fs'
import { createHmac } from 'crypto'

const WS_URL = 'http://localhost:3003'
const APP = 'http://localhost:3000'
const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

// Resolve WS_NOTIFY_SECRET the same way the mini-service does (env, then .env)
const secret =
  process.env.WS_NOTIFY_SECRET ||
  (readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .find((l) => l.startsWith('WS_NOTIFY_SECRET=')) || '')
    .slice('WS_NOTIFY_SECRET='.length).trim()
if (!secret) { console.error('FATAL: WS_NOTIFY_SECRET not resolvable'); process.exit(2) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Connect a raw socket, emit auth payload, collect events for `ms`. */
function probeAuth(label, authPayload, ms = 1500) {
  return new Promise((resolve) => {
    const socket = io(WS_URL, { path: '/', transports: ['websocket'], reconnection: false, timeout: 5000 })
    const events = []
    socket.on('auth-ok', (d) => events.push(['auth-ok', d]))
    socket.on('auth-error', (d) => events.push(['auth-error', d]))
    socket.on('notification', (d) => events.push(['notification', d]))
    socket.on('connect', () => socket.emit('auth', authPayload))
    socket.on('connect_error', (e) => events.push(['connect_error', String(e).slice(0, 60)]))
    setTimeout(() => {
      const ok = events.some(([e]) => e === 'auth-ok')
      const err = events.some(([e]) => e === 'auth-error')
      socket.disconnect()
      resolve({ label, ok, err, events, gotNotification: events.some(([e]) => e === 'notification') })
    }, ms)
  })
}

/** Broadcast to a user room via the loopback endpoint (secret header). */
function notify(userId, title) {
  return fetch('http://127.0.0.1:3004/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-notify-secret': secret },
    body: JSON.stringify({ userId, title, body: 'ws-auth-probe', type: 'system' }),
  }).then((r) => r.status)
}

// ---------- App session: login admin, read userId, fetch real ticket ----------
console.log('--- app session (cookie auth, httpOnly) ---')
const loginRes = await fetch(`${APP}/api/auth?path=login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms' },
  body: JSON.stringify({ email: 'admin@tcms.com', password: 'Admin@123' }),
})
const cookies = loginRes.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
const login = await loginRes.json()
if (!loginRes.ok || !login?.user?.userId) {
  console.error('FATAL: admin login failed', loginRes.status)
  process.exit(2)
}
const adminId = login.user.userId
console.log('admin userId:', adminId)

// user B (isolation target) from the admin users list
const usersRes = await fetch(`${APP}/api/users?search=qa1`, { headers: { Cookie: cookies, 'X-Requested-With': 'tcms' } })
const users = await usersRes.json()
const userB = (users.data || []).find((u) => u.email === 'qa1@tcms.com')
const bId = userB?.userId
console.log('user B (qa1) userId:', bId)

const ticketRes = await fetch(`${APP}/api/auth?path=ws-ticket`, { headers: { Cookie: cookies, 'X-Requested-With': 'tcms' } })
const { ticket } = await ticketRes.json()
console.log('real ticket fetched (not printed):', ticketRes.status, typeof ticket === 'string' && ticket.length > 20)

// An EXPIRED ticket: valid signature, exp 10 minutes in the past
function makeTicket(sub, expOffsetSec) {
  const body = Buffer.from(JSON.stringify({ sub, aud: 'tcms-ws', exp: Math.floor(Date.now() / 1000) + expOffsetSec })).toString('base64url')
  const sig = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${sig}`
}
const expiredTicket = makeTicket(adminId, -600)

// ---------- ATTACKS ----------
console.log('--- attacks (expect rejection, no room join) ---')
const noToken = await probeAuth('no-token', { userId: adminId, token: undefined })
record('no token -> rejected', !noToken.ok && noToken.err, JSON.stringify(noToken.events.filter(([e]) => e !== 'connect_error')))

const devToken = await probeAuth('dev-token', { userId: adminId, token: 'dev' })
record("token 'dev' -> rejected", !devToken.ok && devToken.err, JSON.stringify(devToken.events))

const fakeToken = await probeAuth('fake-token', { userId: adminId, token: 'ZmFrZQ.fakesignature' })
record('fake token -> rejected', !fakeToken.ok && fakeToken.err, JSON.stringify(fakeToken.events))

const expired = await probeAuth('expired-ticket', { userId: adminId, token: expiredTicket })
record('expired ticket (valid sig, past exp) -> rejected', !expired.ok && expired.err, JSON.stringify(expired.events))

const idSwap = await probeAuth('id-swap', { userId: bId, token: ticket }) // admin's ticket, claims B's id
record('real ticket + someone else userId -> rejected', !idSwap.ok && idSwap.err, JSON.stringify(idSwap.events))

// ---------- EAVESDROPPING WHILE UNAUTHENTICATED ----------
console.log('--- eavesdrop attempt: fake-token socket connected, broadcast to admin room ---')
let eavesdropped = false
const lurker = io(WS_URL, { path: '/', transports: ['websocket'], reconnection: false })
lurker.on('connect', () => lurker.emit('auth', { userId: adminId, token: 'still-fake' }))
lurker.on('notification', () => { eavesdropped = true })
await sleep(700)
const lurkerStatus = await notify(adminId, 'probe: victim broadcast while lurker connected')
await sleep(900)
record('unauthenticated socket receives NOTHING from victim room', lurkerStatus === 200 && !eavesdropped, `/notify -> ${lurkerStatus}, lurker got notification: ${eavesdropped}`)
lurker.disconnect()

// ---------- POSITIVE PATH: real ticket ----------
console.log('--- positive: real ticket delivers own, filters others ---')
const got = { own: false, other: false }
const adminSock = io(WS_URL, { path: '/', transports: ['websocket'], reconnection: false })
adminSock.on('connect', () => adminSock.emit('auth', { userId: adminId, token: ticket }))
adminSock.on('auth-ok', () => record('real ticket -> auth-ok (room joined)', true, `userId=${adminId}`))
adminSock.on('notification', (d) => { if (d?.title === 'probe: OWN') got.own = true; if (d?.title === 'probe: OTHER') got.other = true })
await sleep(700)
const st1 = await notify(adminId, 'probe: OWN')     // must arrive
const st2 = await notify(bId, 'probe: OTHER')       // must NOT arrive
await sleep(900)
record('user A receives notification sent to A', st1 === 200 && got.own, `/notify A -> ${st1}, received: ${got.own}`)
record('user A does NOT receive notification sent to B', st2 === 200 && !got.other, `/notify B -> ${st2}, received: ${got.other}`)
adminSock.disconnect()

// ---------- /notify stays secret-checked ----------
const noSecret = await fetch('http://127.0.0.1:3004/notify', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ userId: adminId, title: 'x' }),
})
record('loopback /notify without secret -> 401', noSecret.status === 401, `status ${noSecret.status}`)

console.log('--- SUMMARY ---')
const failed = results.filter((r) => !r.pass)
console.log(`PASS=${results.length - failed.length} FAIL=${failed.length}`)
if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join(' | ')); process.exit(1) }
process.exit(0)
