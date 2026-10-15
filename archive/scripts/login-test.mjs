// Focused login-capacity test ("start-of-day rush") against the PRODUCTION
// server (next start on :3000). Complements scripts/loadtest-200.mjs — that
// file carries the full 5-tier suite; this one isolates the login storm so
// the auth bottleneck can be measured (and re-measured after tuning) without
// a full load-test run.
//
// Tiers:
//   A  realistic morning rush   @  25 VU, 15 s   (whole team signing in)
//   B  worst-case login storm   @ 200 VU, 15 s   (the bcrypt-bound tier)
//
// Read-only side effects: successful logins only insert refresh_tokens rows
// (7-day TTL) — no business data is created, nothing to clean up.
//
// Usage: node scripts/login-test.mjs
import autocannon from 'autocannon'

const BASE = 'http://localhost:3000'

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
  const p = (k) => Number(L[k] ?? L.average ?? 0).toFixed(k === 'max' ? 0 : 1)
  const ok = r['2xx'] ?? 0
  const total = r.requests.total || 0
  return [
    `  ${name}`,
    `logins/sec=${Number(r.requests.average || 0).toFixed(1)}`,
    `ok=${ok} fail=${r.non2xx || 0} errors=${r.errors || 0} timeouts=${r.timeouts || 0}`,
    `lat p50=${p('p50')}ms p90=${p('p90')}ms p99=${p('p99')}ms max=${p('max')}ms`,
    total ? `[${(ok / total * 100).toFixed(2)}% success]` : '',
  ].filter(Boolean).join('  ')
}

const LOGIN = {
  path: '/api/auth?path=login',
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-requested-with': 'tcms' },
  body: JSON.stringify({ email: 'admin@tcms.com', password: 'Admin@123' }),
}

console.log('== TCMS login capacity test (production server) ==')
console.log('  A: morning rush  @ 25 VU, 15 s')
console.log(summarize('rush @ 25 VU / 15s', await run({ connections: 25, duration: 15, requests: [LOGIN] })))

console.log('  B: login storm @ 200 VU, 15 s')
console.log(summarize('storm @ 200 VU / 15s', await run({ connections: 200, duration: 15, requests: [LOGIN] })))

const health = await fetch(`${BASE}/api`)
const page = await fetch(`${BASE}/login`, { redirect: 'manual' })
console.log(`  post-test: api health ${health.status}, login page ${page.status} -> ${health.status === 200 && page.status === 200 ? 'HEALTHY' : 'DEGRADED'}`)
