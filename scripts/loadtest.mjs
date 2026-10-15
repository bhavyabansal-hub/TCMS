// TCMS load test — realistic read-heavy QA-team traffic against :3000.
// Usage:  node scripts/loadtest.mjs --vus 25 --duration 60 --label phase-25vus
//
// Scenario per virtual user (mirrors what a real user's browser does):
//   login once (httpOnly cookie session) then loop:
//     dashboard stats -> modules tree -> test-case list -> test-case search
//     -> bugs list -> notifications -> activity log -> reports (VP only)
//   picking 4-6 endpoints per iteration with 150-400ms think time.
// Reports per-endpoint p50/p95/p99/max, RPS, and HTTP error counts.
const BASE = 'http://localhost:3000'

const args = process.argv.slice(2)
function argOf(name, dflt) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : dflt
}
const VUS = parseInt(argOf('--vus', '25'), 10)
const DURATION_MS = parseInt(argOf('--duration', '60'), 10) * 1000
const LABEL = argOf('--label', `${VUS}vus`)
const WARMUP = args.includes('--warmup')

// ---------- tiny percentile helper ----------
function pct(sorted, p) {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}

// ---------- cookie-session login (httpOnly Set-Cookie replay) ----------
async function login() {
  const res = await fetch(`${BASE}/api/auth?path=login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms' },
    body: JSON.stringify({ email: 'admin@tcms.com', password: 'Admin@123' }),
  })
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`)
  const jar = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
  return jar
}

const ENDPOINTS = [
  { name: 'GET /api/stats dashboard', path: '/api/stats?action=dashboard', weight: 3 },
  { name: 'GET /api/modules tree', path: '/api/modules', weight: 2 },
  { name: 'GET /api/test-cases list', path: '/api/test-cases?page=1&pageSize=20', weight: 4 },
  { name: 'GET /api/test-cases search', path: '/api/test-cases?search=LOAD&page=1&pageSize=20', weight: 2 },
  { name: 'GET /api/bugs list', path: '/api/bugs?page=1&pageSize=20', weight: 3 },
  { name: 'GET /api/notifications list', path: '/api/notifications?page=1&pageSize=20', weight: 2 },
  { name: 'GET /api/activity-logs list', path: '/api/activity-logs?page=1&pageSize=20', weight: 2 },
  { name: 'GET /api/task-reports summary', path: '/api/task-reports?action=summary', weight: 1 },
]

function pickEndpoints() {
  const n = 4 + Math.floor(Math.random() * 3) // 4-6 endpoints per iteration
  const pool = []
  for (const ep of ENDPOINTS) for (let i = 0; i < ep.weight; i++) pool.push(ep)
  const chosen = new Map()
  while (chosen.size < n) chosen.set(pool[Math.floor(Math.random() * pool.length)].name, pool[Math.floor(Math.random() * pool.length)])
  return [...chosen.values()]
}

// ---------- shared metrics ----------
const metrics = new Map() // name -> { lat: [], errors: 0, statuses: Map }
for (const ep of ENDPOINTS) metrics.set(ep.name, { lat: [], errors: 0, statuses: new Map() })

async function call(user, ep) {
  const m = metrics.get(ep.name)
  const t0 = performance.now()
  let status = 0
  try {
    const res = await fetch(BASE + ep.path, {
      headers: { Cookie: user.cookie, 'X-Requested-With': 'tcms' },
    })
    status = res.status
    if (res.status !== 200) m.errors++
    else await res.json().catch(() => null)
  } catch {
    m.errors++
  } finally {
    m.lat.push(performance.now() - t0)
    m.statuses.set(status, (m.statuses.get(status) ?? 0) + 1)
  }
}

async function vuWorker(stopAt) {
  let cookie
  try {
    cookie = await login()
  } catch (e) {
    console.error('VU login failed:', e.message)
    return
  }
  const user = { cookie }
  while (Date.now() < stopAt) {
    const eps = pickEndpoints()
    // small concurrency inside an iteration (like a page firing parallel queries)
    await Promise.all(eps.map((ep) => call(user, ep)))
    await new Promise((r) => setTimeout(r, 150 + Math.random() * 250))
  }
}

const stopAt = Date.now() + DURATION_MS
console.log(`[${LABEL}] starting ${VUS} VUs for ${DURATION_MS / 1000}s ...`)
await Promise.all(Array.from({ length: VUS }, () => vuWorker(stopAt)))

// ---------- report ----------
console.log(`\n===== LOAD TEST RESULTS — ${LABEL} (${VUS} VUs, ${DURATION_MS / 1000}s) =====`)
let totalRequests = 0, totalErrors = 0, allLat = []
const report = {}
for (const [name, m] of metrics) {
  const lat = m.lat.slice().sort((a, b) => a - b)
  const count = lat.length
  totalRequests += count
  totalErrors += m.errors
  allLat.push(...lat)
  const rps = +(count / (DURATION_MS / 1000)).toFixed(1)
  const row = {
    requests: count,
    rps,
    p50: +pct(lat, 50).toFixed(0),
    p95: +pct(lat, 95).toFixed(0),
    p99: +pct(lat, 99).toFixed(0),
    max: +(lat[lat.length - 1] ?? 0).toFixed(0),
    errors: m.errors,
    statuses: Object.fromEntries(m.statuses),
  }
  report[name] = row
  console.log(
    `${name.padEnd(32)} n=${String(count).padStart(5)}  rps=${String(rps).padStart(6)}  ` +
      `p50=${row.p50}ms  p95=${row.p95}ms  p99=${row.p99}ms  max=${row.max}ms  err=${m.errors}`
  )
}
allLat.sort((a, b) => a - b)
console.log('----- overall -----')
console.log(
  `requests=${totalRequests}  rps=${+(totalRequests / (DURATION_MS / 1000)).toFixed(1)}  ` +
    `p50=${pct(allLat, 50).toFixed(0)}ms  p95=${pct(allLat, 95).toFixed(0)}ms  ` +
    `p99=${pct(allLat, 99).toFixed(0)}ms  max=${allLat[allLat.length - 1]?.toFixed(0)}ms  ` +
    `errors=${totalErrors} (${totalRequests ? ((totalErrors / totalRequests) * 100).toFixed(2) : 0}%)`
)
const fs = await import('fs')
fs.writeFileSync(`/tmp/loadtest-${LABEL.replace(/[^a-z0-9-]/gi, '_')}.json`, JSON.stringify({ label: LABEL, vus: VUS, durationMs: DURATION_MS, report }, null, 2))
console.log(`json -> /tmp/loadtest-${LABEL.replace(/[^a-z0-9-]/gi, '_')}.json`)
