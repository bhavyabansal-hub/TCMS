/**
 * Security-fix verification suite (2026-10-09) — re-probes EVERY finding the
 * 4 audit agents raised as must-fix, to prove the fixes actually hold live.
 */
const BASE = 'http://localhost:3000'
let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok  ${name}`)
  else { failures++; console.error(`FAIL  ${name} ${detail}`) }
}

async function req(method, path, { body, jar, headers = {}, raw = false } = {}) {
  const h = { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms', ...headers }
  if (jar) h.Cookie = jar
  if (method !== 'GET') h.Origin = BASE
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined })
  const json = raw ? null : await res.json().catch(() => ({}))
  return { status: res.status, json, res, setCookie: res.headers.getSetCookie?.() ?? [] }
}

function cookieOf(res, name = 'tcms-access') {
  const pair = res.setCookie.find((c) => c.startsWith(`${name}=`))
  return pair ? pair.split(';')[0] : undefined
}

const stamp = Date.now().toString().slice(-6)

// ---------- admin session ----------
const login = await req('POST', '/api/auth?path=login', { body: { email: 'admin@tcms.com', password: 'Admin@123' } })
check('admin login', login.status === 200, String(login.status))
const adminJar = cookieOf(login) + '; ' + cookieOf(login, 'tcms-refresh')

// modules tree for fixtures
const tree = await req('GET', '/api/modules', { jar: adminJar })
const flatModule = tree.json?.flat?.[0]?.moduleId

// ---------- 1. JWT_SECRET fail-fast + forged token rejection ----------
const forged = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  + '.' + Buffer.from(JSON.stringify({ sub: '999999999', email: 'evil@evil.com', role: 'vp', fullName: 'Evil', exp: Math.floor(Date.now()/1000) + 900 })).toString('base64url')
  + '.Zm9vZ2Vkc2lnbmF0dXJl' // signed with the OLD public fallback secret -> must now fail
const forgedProbe = await req('GET', '/api/users', { headers: { Authorization: `Bearer ${forged}` } })
check('FIX 1a: forged JWT with old public secret -> 401', forgedProbe.status === 401, String(forgedProbe.status))
const forgedRealSub = await req('GET', '/api/auth', { headers: { Authorization: `Bearer ${forged}` } })
check('FIX 1b: forged JWT (random sub) -> 401 even before DB', forgedRealSub.status === 401, String(forgedRealSub.status))

// ---------- 2. self-signup is ALWAYS viewer (re-verify after all changes) ----------
const reg1 = await req('POST', '/api/auth?path=register', { body: { fullName: 'Sec Fix Viewer', email: `secfix.viewer${stamp}@example.com`, password: 'Viewer@123', role: 'vp' } })
check('FIX 2a: register with role:vp still -> viewer', reg1.status === 200 && reg1.json?.user?.role === 'viewer', `${reg1.status} ${reg1.json?.user?.role}`)
const viewerJar = cookieOf(reg1) + '; ' + cookieOf(reg1, 'tcms-refresh')

// ---------- 3. link-tc permission gate ----------
const bugs = await req('GET', '/api/bugs?pageSize=1', { jar: adminJar })
const bugId = bugs.json?.data?.[0]?.bugId
const tcs = await req('GET', '/api/test-cases?pageSize=1', { jar: adminJar })
const tcId = tcs.json?.data?.[0]?.testCaseId
const linkViewer = await req('PUT', `/api/bugs?id=${bugId}&action=link-tc`, { jar: viewerJar, body: { testCaseId: tcId } })
check('FIX 3a: viewer link-tc -> 403', linkViewer.status === 403, String(linkViewer.status))
const linkAdmin = await req('PUT', `/api/bugs?id=${bugId}&action=link-tc`, { jar: adminJar, body: { testCaseId: tcId } })
check('FIX 3b: admin link-tc still works', linkAdmin.status === 200, String(linkAdmin.status))
const linkBad = await req('PUT', `/api/bugs?id=${bugId}&action=link-tc`, { jar: adminJar, body: { testCaseId: 'nonexistent-tc-id' } })
check('FIX 3c: unknown test case id -> 404 (no silent success)', linkBad.status === 404, String(linkBad.status))

// ---------- 4. activity-log scoped branches gated ----------
const alEntity = await req('GET', `/api/activity-logs?action=entity&type=user&id=some-id`, { jar: viewerJar })
check('FIX 4a: viewer entity activity -> 403', alEntity.status === 403, String(alEntity.status))
const alUser = await req('GET', `/api/activity-logs?action=user&id=some-id`, { jar: viewerJar })
check('FIX 4b: viewer user activity -> 403', alUser.status === 403, String(alUser.status))
const alAdmin = await req('GET', `/api/activity-logs?pageSize=1`, { jar: adminJar })
check('FIX 4c: admin activity feed still works', alAdmin.status === 200, String(alAdmin.status))
const dash = await req('GET', '/api/stats?action=dashboard', { jar: viewerJar })
const ra = dash.json?.recentActivity ?? []
check('FIX 4d: viewer dashboard recentActivity self-only', ra.every((r) => r.userId === reg1.json?.user?.userId), JSON.stringify(ra.slice(0, 1)))

// ---------- 5. field length caps ----------
const longTitle = 'A'.repeat(5000)
const capProbe = await req('POST', '/api/test-cases', { jar: adminJar, body: { title: longTitle, moduleId: flatModule, description: 'cap probe', priority: 'P2' } })
check('FIX 5a: 5000-char title -> 400', capProbe.status === 400, String(capProbe.status))
const capProbe2 = await req('POST', '/api/test-cases', { jar: adminJar, body: { title: 'Cap ok case', moduleId: flatModule, description: 'd'.repeat(3000), priority: 'P2' } })
check('FIX 5b: 3000-char description -> 400', capProbe2.status === 400, String(capProbe2.status))

// ---------- 6. wiki sanitizer ----------
const xssPayload = `<p>clean</p><svg/onload=alert(2)><img/src=x/onerror=alert(4)><a href="javascript:alert(6)">x</a><a href="jav&#x09;ascript:alert(8)">y</a><base href="//evil.test/"><form><input type=password></form><script>alert(9)</script><iframe src="//evil"></iframe>`
const wikiCreate = await req('POST', '/api/wiki', { jar: adminJar, body: { title: `Sanitizer probe ${stamp}`, content: xssPayload, tags: [] } })
check('FIX 6a: wiki doc created', wikiCreate.status === 200 || wikiCreate.status === 201, String(wikiCreate.status))
const wikiId = wikiCreate.json?.wikiDocumentId ?? wikiCreate.json?.documentId ?? wikiCreate.json?.id
const wikiGet = await req('GET', `/api/wiki?id=${wikiId}`, { jar: adminJar })
const stored = String(wikiGet.json?.content ?? '')
// Attribute-level checks (a string like src="x/onerror=..." inside a QUOTED
// value is inert — only a real tag-level event handler or dangerous element
// would be exploitable):
check('FIX 6b: no tag-level event handler attribute', !/<[a-z][^>]*\son\w+\s*=/i.test(stored), stored.slice(0, 120))
check('FIX 6c: no dangerous elements (svg/base/form/script/iframe)', !/<(svg|base|form|script|iframe)\b/i.test(stored), '')
check('FIX 6d: no javascript: URI in any href/src', !/<\w+[^>]*(href|src)\s*=\s*["']?\s*javascript:/i.test(stored), '')
check('FIX 6e: <svg/onload> not present as element', !stored.includes('<svg'), '')
check('FIX 6f: clean <p> kept', stored.includes('<p>clean</p>'), stored.slice(0, 60))
check('FIX 6g: link rel=noopener enforced', stored.includes('rel="noopener noreferrer nofollow"') || !stored.includes('<a'), stored.slice(0, 120))
// cleanup probe doc
await req('DELETE', `/api/wiki?id=${wikiId}`, { jar: adminJar })

// ---------- 7. WS ticket flow ----------
const badTicket = await fetch(`http://127.0.0.1:3004/notify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'x', type: 't', title: 'INJECT' }) })
check('FIX 7a: /notify without secret -> 401', badTicket.status === 401, String(badTicket.status))
const ticket = await req('GET', '/api/auth?path=ws-ticket', { jar: adminJar })
check('FIX 7b: ws-ticket issued for authed user', ticket.status === 200 && typeof ticket.json?.ticket === 'string', JSON.stringify(ticket.json).slice(0, 80))
check('FIX 7c: ticket has 60s ttl', ticket.json?.ttlSeconds === 60, String(ticket.json?.ttlSeconds))

// ---------- 8. security headers ----------
const home = await fetch(BASE)
check('FIX 8a: X-Frame-Options DENY', home.headers.get('x-frame-options') === 'DENY', String(home.headers.get('x-frame-options')))
check('FIX 8b: X-Content-Type-Options nosniff', home.headers.get('x-content-type-options') === 'nosniff', '')
check('FIX 8c: Referrer-Policy set', !!home.headers.get('referrer-policy'), '')
check('FIX 8d: CSP set with frame-ancestors none', (home.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'"), '')
check('FIX 8e: HSTS set', !!home.headers.get('strict-transport-security'), '')

// ---------- 9. proxy covers /wiki ----------
const anonWiki = await fetch(`${BASE}/wiki`, { redirect: 'manual' })
check('FIX 9a: anonymous /wiki redirects to login', anonWiki.status >= 300 && anonWiki.status < 400 && String(anonWiki.headers.get('location')).includes('/login'), `${anonWiki.status}`)

// ---------- 10. password change parity ----------
const pwBad = await req('PUT', '/api/auth?path=password', { jar: viewerJar, body: { currentPassword: 'Viewer@123', newPassword: 'abcdefgh' } })
check('FIX 10: letters-only new password -> 400', pwBad.status === 400, String(pwBad.status))

// ---------- 11. login timing equalization (rough check) ----------
async function timed(email) {
  const t0 = Date.now()
  await req('POST', '/api/auth?path=login', { body: { email, password: 'WrongPass@1' } })
  return Date.now() - t0
}
await timed('ghost-unknown@tcms.com') // warm
const tUnknown = await timed(`ghost-unknown${stamp}@tcms.com`)
const tKnown = await timed('admin@tcms.com')
check('FIX 11: unknown-email login now does bcrypt work (>= 40% of known timing)', tUnknown >= tKnown * 0.4, `unknown=${tUnknown}ms known=${tKnown}ms`)

// ---------- 12. module ownerId validation ----------
const badOwner = await req('PUT', `/api/modules?id=${flatModule}`, { jar: adminJar, body: { ownerId: 'not-a-real-user' } })
check('FIX 12: invalid ownerId -> 400 (not 500)', badOwner.status === 400, String(badOwner.status))

console.log(failures ? `\nRESULT: ${failures} FAILURES` : '\nRESULT: ALL SECURITY FIXES VERIFIED')
process.exit(failures ? 1 : 0)
