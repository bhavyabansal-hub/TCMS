// Smoke check: served /integrations HTML shows the round-3 layout.
const BASE = 'http://localhost:3000'

const jar = []
async function req(method, path, body) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Requested-With': 'tcms',
    ...(jar.length ? { Cookie: jar.join('; ') } : {}),
  }
  if (method !== 'GET') headers.Origin = BASE
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const setCookies = res.headers.getSetCookie?.() ?? []
  for (const c of setCookies) if (!jar.includes(c.split(';')[0])) jar.push(c.split(';')[0])
  return res
}

const login = await req('POST', '/api/auth?path=login', { email: 'admin@tcms.com', password: 'Admin@123' })
if (login.status !== 200) throw new Error(`login failed ${login.status}`)

const page = await req('GET', '/integrations')
const html = await page.text()
console.log('GET /integrations ->', page.status)

const checks = [
  ['new title "Link a module to a ticket"', html.includes('Link a module to a ticket')],
  ['full-width field row "Search modules"', html.includes('Search modules')],
  ['history section "Link history"', html.includes('Link history')],
  ['"How it works" REMOVED', !html.includes('How it works')],
  ['status strip "Connected"', html.includes('Connected')],
]
let fail = 0
for (const [name, pass] of checks) {
  console.log(`${pass ? 'ok' : 'FAIL'}  ${name}`)
  if (!pass) fail++
}
process.exit(fail ? 1 : 0)
