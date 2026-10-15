// Warm up every app route once after the dev server boots.
//
// Next dev compiles each route on first request (~1s+), which is exactly the
// "page takes a second to appear" lag. Hitting every route at startup moves
// that cost to boot time instead of the user's first click.
//
// Usage: node scripts/warm-routes.mjs [baseURL]
//   default baseURL: http://localhost:3000

const base = process.argv[2] || process.env.WARM_BASE || 'http://localhost:3000'

const ROUTES = [
  '/dashboard',
  '/modules',
  '/test-cases',
  '/reviews',
  '/bugs',
  '/tasks',
  '/reports',
  '/activity-log',
  '/notifications',
  '/settings/users',
  '/settings/permissions',
  '/settings/profile',
  '/login',
]

async function warm() {
  // Wait for the server to accept connections (max ~60s).
  let up = false
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(base, { redirect: 'manual' })
      if (res.status > 0) { up = true; break }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  if (!up) {
    console.error(`[warm-routes] server at ${base} never came up — skipping`)
    process.exit(0) // never block the dev workflow
  }

  const started = Date.now()
  let ok = 0
  for (const route of ROUTES) {
    try {
      // Auth-gated routes still compile server-side even when the app shell
      // redirects client-side, which is all we need here.
      const res = await fetch(base + route, { redirect: 'manual' })
      if (res.status) ok++
    } catch { /* ignore individual failures */ }
  }
  console.log(`[warm-routes] warmed ${ok}/${ROUTES.length} routes in ${Date.now() - started}ms`)
}

warm()
