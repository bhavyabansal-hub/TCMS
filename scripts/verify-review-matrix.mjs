// Sandbox-only live probe: verifies review-feature access matches the
// granted permission matrix for every role (granted -> works; not granted -> blocked).
// NOT part of the shipped package.
const BASE = 'http://localhost:3000/api'

const ACCOUNTS = [
  { email: 'admin@tcms.com', password: 'Admin@123', role: 'vp' },
  { email: 'teamlead@tcms.com', password: 'Lead@123', role: 'manager' },
  { email: 'product@tcms.com', password: 'Product@123', role: 'product' },
  { email: 'developer@tcms.com', password: 'Dev@12345', role: 'developer' },
  { email: 'qa1@tcms.com', password: 'QA@12345', role: 'qa_engineer' },
  { email: 'viewer@tcms.com', password: 'View@12345', role: 'viewer' },
]

let pass = 0
let fail = 0

function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}  (${detail})`) }
}

async function login(email, password) {
  const res = await fetch(`${BASE}/auth?path=login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms' },
    body: JSON.stringify({ email, password }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`login failed for ${email}: ${JSON.stringify(body)}`)
  // Cookie-session contract: the access token arrives as an httpOnly cookie,
  // not in the response body. Extract it for the suite's Cookie headers.
  const raw = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('tcms-access=')) ?? ''
  const accessToken = raw.split(';')[0].replace(/^tcms-access=/, '')
  if (!accessToken) throw new Error(`login for ${email} set no tcms-access cookie`)
  return { ...body, accessToken }
}

async function probe(token, path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Cookie: `tcms-access=${token}` } })
  let body = null
  try { body = await res.json() } catch { /* html 404 page etc. */ }
  return { status: res.status, body }
}

async function main() {
  for (const acc of ACCOUNTS) {
    const session = await login(acc.email, acc.password)
    const { accessToken, permissions, user } = session
    const hasPerform = permissions.includes('perform_review')
    const hasSubmit = permissions.includes('submit_review')
    const expectsAllModuleReviews = hasPerform || hasSubmit
    console.log(`--- ${acc.role} (${acc.email}) perms=${permissions.length} perform=${hasPerform} submit=${hasSubmit}`)

    // 1. Session must carry the role's effective permissions.
    check(`${acc.role}: session role matches`, user.role === acc.role, `got ${user.role}`)

    // 2. All-module-reviews access must equal review participation.
    const all = await probe(accessToken, '/module-reviews?action=all')
    check(
      `${acc.role}: module-reviews?action=all ${expectsAllModuleReviews ? '200' : '403'}`,
      all.status === (expectsAllModuleReviews ? 200 : 403),
      `got ${all.status} ${JSON.stringify(all.body).slice(0, 80)}`
    )

    // 3. Personal queues are open to every logged-in user (view by default).
    for (const p of ['/reviews?action=queue', '/module-reviews?action=queue']) {
      const r = await probe(accessToken, p)
      check(`${acc.role}: GET ${p} -> 200`, r.status === 200, `got ${r.status}`)
    }

    // 4. The paginated reviews list is participation-gated (perform OR submit)
    //    — same rule as module-reviews?action=all (see reviews.service.ts).
    const expectsReviewList = hasPerform || hasSubmit
    const list = await probe(accessToken, '/reviews?pageSize=5')
    check(
      `${acc.role}: GET /reviews ${expectsReviewList ? '200' : '403'}`,
      list.status === (expectsReviewList ? 200 : 403),
      `got ${list.status}`
    )

    // 5. manage_permissions (matrix) and manage_users endpoints follow the matrix.
    const perms = await probe(accessToken, '/permissions')
    const expectsPerms = permissions.includes('manage_permissions')
    check(
      `${acc.role}: GET /permissions ${expectsPerms ? '200' : '403'}`,
      perms.status === (expectsPerms ? 200 : 403),
      `got ${perms.status}`
    )
  }

  console.log('======================================')
  console.log(`REVIEW-MATRIX RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error('PROBE ERROR:', e.message); process.exit(1) })
