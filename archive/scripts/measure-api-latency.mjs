// Measures end-to-end latency of the endpoints every tab hits on mount.
// Usage: node scripts/measure-api-latency.mjs
const BASE = process.env.BASE || 'http://localhost:3000'

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth?path=login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms', Origin: BASE },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) throw new Error(`login failed ${res.status}`)
  const setCookie = res.headers.getSetCookie?.() ?? []
  return setCookie.map((c) => c.split(';')[0]).join('; ')
}

async function timed(label, url, cookie) {
  const t0 = performance.now()
  const res = await fetch(`${BASE}${url}`, { headers: { Cookie: cookie } })
  const ms = Math.round(performance.now() - t0)
  const ok = res.ok ? 'ok ' : 'ERR'
  console.log(`${ok} ${String(ms).padStart(6)}ms  ${label}  [${url}]`)
  return ms
}

const accounts = [
  { email: 'admin@tcms.com', password: 'Admin@123' },
]

for (const acc of accounts) {
  const cookie = await login(acc.email, acc.password)
  console.log(`\n=== ${acc.email} — cold (first hit) ===`)
  await timed('dashboard stats   ', '/api/stats?action=dashboard', cookie)
  await timed('modules tree      ', '/api/modules', cookie)
  await timed('test-cases list   ', '/api/test-cases?page=1&pageSize=20', cookie)
  await timed('reviews list      ', '/api/reviews?page=1&pageSize=20', cookie)
  await timed('module-reviews all', '/api/module-reviews?action=all', cookie)
  await timed('bugs list         ', '/api/bugs?page=1&pageSize=20', cookie)
  await timed('tasks (my)        ', '/api/task-reports?action=my', cookie)
  await timed('notifications     ', '/api/notifications?page=1&pageSize=20', cookie)
  await timed('activity logs     ', '/api/activity-logs?page=1&pageSize=20', cookie)
  await timed('users options     ', '/api/users?action=options', cookie)
  console.log(`=== warm (second hit, server caches/DB warm) ===`)
  await timed('dashboard stats   ', '/api/stats?action=dashboard', cookie)
  await timed('modules tree      ', '/api/modules', cookie)
  await timed('test-cases list   ', '/api/test-cases?page=1&pageSize=20', cookie)
  await timed('reviews list      ', '/api/reviews?page=1&pageSize=20', cookie)
  await timed('module-reviews all', '/api/module-reviews?action=all', cookie)
  await timed('bugs list         ', '/api/bugs?page=1&pageSize=20', cookie)
}
