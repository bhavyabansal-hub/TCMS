// Test A: lost-rotation healing.
// 1. Login -> token pair T1 (as the browser would store).
// 2. Refresh with T1 -> server rotates -> T2. Simulate the response being
//    LOST: the "browser" keeps T1.
// 3. Refresh AGAIN with T1 (what the browser's hard refresh does) -> with the
//    grace window this must SUCCEED and return a fresh pair T3.
// Before the fix, step 3 returned 401 and the client hard-logged-out.
const BASE = 'http://localhost:3000'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

async function j(method, url, body, token) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

const login = await j('POST', '/api/auth?path=login', { email: 'admin@tcms.com', password: 'Admin@123' })
if (login.status !== 200) { console.log('LOGIN FAILED', login.status); process.exit(1) }
const T1 = login.data.refreshToken
console.log('1. login ok, T1 =', T1.slice(-12))

const rot = await j('POST', '/api/auth?path=refresh', { refreshToken: T1 })
console.log('2. rotation (response "lost") ->', rot.status, '| new token T2 =', rot.data.refreshToken?.slice(-12))
if (rot.status !== 200) process.exit(1)

await new Promise((r) => setTimeout(r, 800))
const heal = await j('POST', '/api/auth?path=refresh', { refreshToken: T1 })
console.log('3. retry with OLD T1 within grace ->', heal.status, heal.status === 200 ? '(SESSION HEALED)' : '(STILL BROKEN)')
if (heal.status === 200) {
  console.log('   healed pair T3 =', heal.data.refreshToken.slice(-12))
  // sanity: me() works with the new access token
  const me = await j('GET', '/api/auth', null, heal.data.accessToken)
  console.log('4. GET /api/auth with healed access ->', me.status, me.data.user?.email)
}

// genuine revocation still kills it
const T3 = heal.data.refreshToken
const { PrismaClient } = require('@prisma/client')
const db = new PrismaClient()
await db.$connect()
await db.$executeRaw`UPDATE refresh_tokens SET revoked = true WHERE token = ${T3}`
await db.$disconnect()
const dead = await j('POST', '/api/auth?path=refresh', { refreshToken: T3 })
console.log('5. revoked token refresh ->', dead.status, dead.status === 401 ? '(REAL REVOCATION STILL ENFORCED)' : '(SECURITY REGRESSION!)')
