// TCMS 1000-user load test (adapted from scripts/loadtest-200.mjs).
// Run it against a PRODUCTION build (npm run build && next start) — not the dev server.
// Read-only: one login per role at the start, then authenticated GETs only.
//
// Scenarios:
//   T0  warmup                                   @   20 VU,  5 s
//   T1r REALISTIC: LOAD_VU users with think time = LOAD_RATE req/s in total (default 350:
//       1000 users x one page every ~20 s x ~7 API calls per page), 60 s
//   T1  STRESS: page-load read mix, every VU always busy @ LOAD_VU (1000), 30 s
//   T2  sustained same mix                       @ LOAD_VU, 60 s
//   T3  per-endpoint breakdown                   @ LOAD_VU,  6 s each
//   T4  login storm — only with LOAD_LOGIN_STORM=1 (writes refresh-token + activity rows)
//   T5  post-test health check
// Reports exact p50 / p95 (from every response time), errors, non-2xx and the peak number
// of MySQL connections (Threads_connected, sampled every second through the DB guard,
// 127.0.0.1:5500/tcms_test only).
//
// Usage: TCMS_BASE_URL=http://localhost:3999 node scripts/loadtest-1000.mjs
// Env:   LOAD_VU (1000), LOAD_RATE (350), LOAD_LOGIN_STORM (0)
import autocannon from 'autocannon'
import { openGuardedDb } from './lib/db-guard.mjs'

const BASE = process.env.TCMS_BASE_URL || 'http://localhost:3999'
const VU = Number(process.env.LOAD_VU || 1000)
const RATE = Number(process.env.LOAD_RATE || 350)
const LOGIN_STORM = process.env.LOAD_LOGIN_STORM === '1'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fmt = (n) => Number(n ?? 0).toFixed(n >= 100 ? 0 : 1)

// ---------- DB connection sampler ----------
const guard = await openGuardedDb({ lock: false, log: () => {} })
let peakConnections = 0
let sampling = true
const sampler = (async () => {
  while (sampling) {
    try {
      const rows = await guard.db.$queryRaw`SELECT VARIABLE_VALUE AS v FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Threads_connected'`
      peakConnections = Math.max(peakConnections, Number(rows[0]?.v ?? 0))
    } catch { /* sampling must never fail the run */ }
    await sleep(1000)
  }
})()

function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

function run(opts) {
  return new Promise((resolve) => {
    const times = []
    const before = peakConnections
    peakConnections = 0
    const instance = autocannon({ url: BASE, timeout: 30, ...opts }, (err, result) => {
      const peak = peakConnections
      peakConnections = Math.max(before, peak)
      if (err) resolve({ error: String(err) })
      else resolve({ ...result, times: times.sort((a, b) => a - b), peakDb: peak })
    })
    instance.on('response', (_client, _status, _bytes, responseTime) => times.push(responseTime))
    instance.on('reqError', () => { /* counted in result.errors */ })
  })
}

function summarize(name, r) {
  if (!r || r.error) return `  ${name}: FAILED ${r?.error ?? ''}`
  const codes = Object.entries(r.statusCodeStats || {}).filter(([, s]) => s.count > 0).map(([c, s]) => `${c}x${s.count}`).join(' ')
  return [
    `  ${name}`,
    `req=${r.requests.total}`,
    `rps=${fmt(r.requests.average)}`,
    `p50=${fmt(percentile(r.times, 50))}ms p95=${fmt(percentile(r.times, 95))}ms p99=${fmt(percentile(r.times, 99))}ms max=${fmt(r.latency?.max)}ms`,
    `non2xx=${r.non2xx || 0}`,
    `errors=${r.errors || 0}`,
    `timeouts=${r.timeouts || 0}`,
    `dbConnPeak=${r.peakDb}`,
    codes ? `[${codes}]` : '',
  ].filter(Boolean).join(' ')
}

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth?path=login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'tcms' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status}`)
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => c.startsWith('tcms-')).join('; ')
}

console.log(`== TCMS ${VU}-user load test against ${BASE} ==`)
const cookie = await login('admin@tcms.com', 'Admin@123')
const headers = { cookie, 'x-requested-with': 'tcms' }

// What a page load calls (see scripts/verify-page-apis.mjs): session, sidebar badges,
// bell, then the page's own data.
const MIX = [
  { path: '/api/auth' },
  { path: '/api/reviews?action=queue' },
  { path: '/api/module-reviews?action=queue' },
  { path: '/api/notifications?pageSize=50' },
  { path: '/api/stats?action=dashboard' },
  { path: '/api/modules' },
  { path: '/api/test-cases?page=1&pageSize=20' },
  { path: '/api/bugs?pageSize=200' },
  { path: '/api/users?action=options' },
  { path: '/api/test-cases?action=options' },
]
const mixRequests = MIX.map((m) => ({ ...m, headers }))

try {
  console.log('\n== T0 warmup (5 s @ 20 VU) ==')
  console.log(summarize('warmup', await run({ connections: 20, duration: 5, requests: mixRequests })))

  console.log(`\n== T1r realistic: ${VU} users with think time = ${RATE} req/s, 60 s ==`)
  console.log(summarize(`realistic ${VU} users @ ${RATE} req/s / 60s`, await run({ connections: VU, overallRate: RATE, duration: 60, requests: mixRequests })))

  console.log(`\n== T1 STRESS: every VU always busy @ ${VU} VU, 30 s ==`)
  console.log(summarize(`mix @ ${VU} VU / 30s`, await run({ connections: VU, duration: 30, requests: mixRequests })))

  console.log(`\n== T2 sustained mix @ ${VU} VU, 60 s ==`)
  console.log(summarize(`mix @ ${VU} VU / 60s`, await run({ connections: VU, duration: 60, requests: mixRequests })))

  console.log(`\n== T3 per-endpoint @ ${VU} VU, 6 s each ==`)
  for (const m of MIX) {
    console.log(summarize(m.path, await run({ connections: VU, duration: 6, requests: [{ path: m.path, headers }] })))
    await sleep(500)
  }

  if (LOGIN_STORM) {
    console.log(`\n== T4 login storm @ ${VU} VU, 15 s ==`)
    console.log(summarize('login storm', await run({
      connections: VU, duration: 15,
      requests: [{ path: '/api/auth?path=login', method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'tcms' }, body: JSON.stringify({ email: 'admin@tcms.com', password: 'Admin@123' }) }],
    })))
  } else {
    console.log('\n== T4 login storm: skipped (LOAD_LOGIN_STORM=1 to run; it writes refresh-token rows) ==')
  }

  console.log('\n== T5 post-test health check ==')
  // The OS can refuse new connections for a few seconds after a stress run (accept
  // backlog / TIME_WAIT sockets) — retry before calling the server degraded.
  let status = 0
  for (let i = 0; i < 10 && status !== 200; i++) {
    status = await fetch(`${BASE}/api/ready`).then((r) => r.status).catch(() => 0)
    if (status !== 200) await sleep(2000)
  }
  console.log(`  /api/ready: ${status || 'no answer'} -> server ${status === 200 ? 'HEALTHY' : 'DEGRADED'}`)
} finally {
  sampling = false
  await sampler
  await guard.release().catch(() => {})
}
