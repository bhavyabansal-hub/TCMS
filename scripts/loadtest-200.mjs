// TCMS 200-user load test (stretch beyond the documented 100-VU knee).
// Complements scripts/loadtest.mjs (25/50/100 VU). Run against the PRODUCTION
// server (next start on :3000). Read-only except the login storm, which only
// exercises /api/auth (no data rows are created — nothing to clean up).
//
// Scenarios:
//   T0  warmup                              @  10 VU,  5 s
//   T1  realistic authenticated READ mix    @ 200 VU, 30 s
//   T2  sustained same mix                  @ 200 VU, 60 s
//   T3  per-endpoint breakdown              @ 200 VU,  6 s each
//   T4  login storm (bcrypt-bound)          @ 200 VU, 15 s
//   T5  post-test health check
//
// Usage: node scripts/loadtest-200.mjs
import autocannon from 'autocannon'

const BASE = 'http://localhost:3000'
const VU = Number(process.env.LOAD_VU || 200)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function fmt(n) { return Number(n ?? 0).toFixed(n >= 100 ? 0 : 1) }

function run(opts) {
  return new Promise((resolve) => {
    const instance = autocannon({ url: BASE, ...opts }, (err, result) => {
      if (err) resolve({ error: String(err) })
      else resolve(result)
    })
    instance.on('reqError', () => { /* counted in result.errors */ })
  })
}

function summarize(name, r) {
  if (!r || r.error) return `  ${name}: FAILED ${r?.error ?? ''}`
  const L = r.latency || {}
  const p = (k) => fmt(L[k] ?? L.average ?? 0)
  const errRate = r.requests.total ? ((r.non2xx || 0) / r.requests.total * 100) : 0
  const codes = Object.entries(r.statusCodeStats || {})
    .filter(([, s]) => s.count > 0)
    .map(([c, s]) => `${c}x${s.count}`).join(' ')
  return [
    `  ${name}`,
    `rps=${fmt(r.requests.average)}`,
    `lat p50=${p('p50')}ms p90=${p('p90')}ms p99=${p('p99')}ms max=${fmt(L.max)}ms`,
    `2xx=${r['2xx'] ?? r.statusCodeStats?.[200]?.count ?? '-'}`,
    `non2xx=${r.non2xx || 0}`,
    `errors=${r.errors || 0}`,
    `timeouts=${r.timeouts || 0}`,
    errRate > 0.5 ? '<ELEVATED NON-2XX>' : '',
    codes ? `[${codes}]` : '',
  ].filter(Boolean).join(' ')
}

// ---------- login once -> session cookie for authenticated GETs ----------
console.log(`== TCMS ${VU}-user load test (production server) ==`)
const res = await fetch(`${BASE}/api/auth?path=login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-requested-with': 'tcms' },
  body: JSON.stringify({ email: 'admin@tcms.com', password: 'Admin@123' }),
})
if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`)
const access = res.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('tcms-access='))
if (!access) throw new Error('no tcms-access cookie')
const authHeaders = { cookie: access }
console.log('   session acquired')

const MIX = [
  { path: '/api/modules' },
  { path: '/api/test-cases?page=1&pageSize=20' },
  { path: '/api/stats?action=dashboard' },
  { path: '/api/notifications?page=1&pageSize=10' },
  { path: '/api/reviews?action=queue' },
  { path: '/api/search?q=login&limit=5' },
  { path: '/api/users?action=options' },
  { path: '/dashboard' },
]
const mixRequests = MIX.map((m) => ({ ...m, headers: authHeaders }))

console.log('\n== T0 warmup (5s @ 10 VU) ==')
console.log(summarize('warmup', await run({ connections: 10, duration: 5, requests: mixRequests })))

console.log(`\n== T1 realistic read mix @ ${VU} VU, 30 s ==`)
console.log(summarize(`mix @ ${VU} VU / 30s`, await run({ connections: VU, duration: 30, requests: mixRequests })))

console.log(`\n== T2 sustained read mix @ ${VU} VU, 60 s ==`)
console.log(summarize(`mix @ ${VU} VU / 60s`, await run({ connections: VU, duration: 60, requests: mixRequests })))

console.log(`\n== T3 per-endpoint breakdown @ ${VU} VU, 6 s each ==`)
for (const m of MIX) {
  const r = await run({ connections: VU, duration: 6, requests: [{ path: m.path, headers: authHeaders }] })
  console.log(summarize(m.path, r))
  await sleep(500)
}

console.log(`\n== T4 login storm @ ${VU} VU, 15 s (bcrypt-bound by design) ==`)
console.log(summarize('login storm', await run({
  connections: VU,
  duration: 15,
  requests: [{
    path: '/api/auth?path=login',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'tcms' },
    body: JSON.stringify({ email: 'admin@tcms.com', password: 'Admin@123' }),
  }],
})))

console.log('\n== T5 post-test health check ==')
const health = await fetch(`${BASE}/api`)
const root = await fetch(`${BASE}/login`, { redirect: 'manual' })
console.log(`  api health: ${health.status}  login page: ${root.status}  -> server ${health.status === 200 && root.status === 200 ? 'HEALTHY' : 'DEGRADED'}`)
