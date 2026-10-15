// S6-only per-endpoint breakdown (companion to loadtest.mjs) — read-only.
import autocannon from 'autocannon'

const BASE = 'http://localhost:3000'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function run(opts) {
  return new Promise((resolve) => {
    autocannon({ url: BASE, ...opts }, (err, result) => resolve(err ? { error: String(err) } : result))
  })
}

function fmt(n) { return Number(n ?? 0).toFixed(n >= 100 ? 0 : 1) }

function summarize(name, r) {
  const L = r.latency || {}
  const p = (k) => fmt(L[k] ?? L.average ?? 0)
  return `  ${name}  rps=${fmt(r.requests.average)}  lat p50=${p('p50')}ms p90=${p('p90')}ms p99=${p('p99')}ms max=${fmt(L.max)}ms  2xx=${r['2xx'] ?? '-'} non2xx=${r.non2xx || 0} errors=${r.errors || 0}`
}

const res = await fetch(`${BASE}/api/auth?path=login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-requested-with': 'tcms' },
  body: JSON.stringify({ email: 'admin@tcms.com', password: 'Admin@123' }),
})
const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('tcms-access='))
const headers = { cookie }

const ENDPOINTS = [
  '/api/modules',
  '/api/test-cases?page=1&pageSize=20',
  '/api/test-cases?search=login',
  '/api/stats?action=dashboard',
  '/api/notifications?page=1&pageSize=10',
  '/api/reviews?action=queue',
  '/api/search?q=login&limit=5',
  '/api/users?action=options',
  '/api/activity-logs?page=1&pageSize=20',
  '/dashboard',
  '/test-cases',
]

console.log('== S6 per-endpoint breakdown (8s @ 25 VU each) ==')
for (const ep of ENDPOINTS) {
  console.log(summarize(`GET ${ep}`, await run({ connections: 25, duration: 8, requests: [{ path: ep }], headers })))
  await sleep(300)
}
console.log('\n== S6 DONE ==')
