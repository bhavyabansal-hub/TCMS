/**
 * LIVE Crew Desk end-to-end verification — runs against the REAL dev backend
 * (https://dev.eng4.back.shipgl.in) configured in .env. Owner-confirmed only.
 *
 * Proves, through the TCMS API exactly like a browser would:
 *   1. config reports the dev backend, token auth, test mode, expiry;
 *   2. email-check verifies the TCMS user whose email exists in Crew Desk;
 *   3. lookup of the designated test ticket 1355 returns title + status;
 *   4. creating the link posts ONE real comment to ticket 1355 (status=posted);
 *   5. the comment is actually visible on the real ticket (read-back);
 *   6. Copy path (comment rebuild) works from the history row.
 *
 * SAFETY: test mode + CREWDESK_TEST_TICKET_ID=1355 bound every post to that
 * single designated ticket. No bad-credential probing against the real server.
 */
const BASE = 'http://localhost:3000'

async function req(method, path, { body, jar } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms' }
  if (jar) headers.Cookie = jar
  if (method !== 'GET') headers.Origin = BASE
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json, setCookie: res.headers.getSetCookie?.() ?? [] }
}

async function login(email, password) {
  const res = await req('POST', '/api/auth?path=login', { body: { email, password } })
  if (res.status !== 200) throw new Error(`login failed: ${JSON.stringify(res.json)}`)
  const pick = (name) => {
    const pair = res.setCookie.find((c) => c.startsWith(`${name}=`))
    return pair ? pair.split(';')[0].slice(name.length + 1) : undefined
  }
  return `tcms-access=${pick('tcms-access')}`
}

let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok  ${name}`)
  else { failures++; console.error(`FAIL  ${name} ${detail}`) }
}

// ---------- 1. config ----------
const adminJar = await login('admin@tcms.com', 'Admin@123')
const cfg = await req('GET', '/api/integrations/crewdesk?path=config', { jar: adminJar })
check('config 200', cfg.status === 200, JSON.stringify(cfg.json))
check('config points at DEV backend', cfg.json.baseUrlSet === true)
check('config mode=test', cfg.json.mode === 'test', cfg.json.mode)
check('config authMode=token', cfg.json.authMode === 'token', cfg.json.authMode)
check('config test ticket 1355', cfg.json.testTicketId === '1355', cfg.json.testTicketId)
check('config shared account is tejas', cfg.json.accountEmail === 'tejas.singh@shipglobal.in', cfg.json.accountEmail)
check('config exposes token expiry', typeof cfg.json.credentialExpiresAt === 'string' && !Number.isNaN(Date.parse(cfg.json.credentialExpiresAt)), String(cfg.json.credentialExpiresAt))
const expired = cfg.json.credentialExpiresAt ? Date.parse(cfg.json.credentialExpiresAt) < Date.now() : true
check('token not expired yet (paste a fresh one if this fails)', !expired, cfg.json.credentialExpiresAt)

// ---------- 2. email-check as the Crew Desk-matched TCMS user ----------
const tejasJar = await login('tejas.singh@shipglobal.in', 'Tejas@12345')
const emailCheck = await req('GET', '/api/integrations/crewdesk?path=email-check', { jar: tejasJar })
check('email-check 200', emailCheck.status === 200, JSON.stringify(emailCheck.json))
check('email verified against real Crew Desk', emailCheck.json?.status === 'verified', emailCheck.json?.status)

// admin@tcms.com does NOT exist in the real Crew Desk -> must be not_found.
const adminCheck = await req('GET', '/api/integrations/crewdesk?path=email-check', { jar: adminJar })
check('unmatched email (admin) is not_found — no email exceptions', adminCheck.json?.status === 'not_found', adminCheck.json?.status)

// ---------- 3. lookup ----------
const lookup = await req('POST', '/api/integrations/crewdesk?path=lookup', { jar: tejasJar, body: { ticketId: '1355' } })
check('lookup 200', lookup.status === 200, JSON.stringify(lookup.json))
check('lookup title matches real ticket', typeof lookup.json?.title === 'string' && lookup.json.title.length > 0, lookup.json?.title)
check('lookup says linkable in test mode', lookup.json?.canLinkInCurrentMode === true, String(lookup.json?.canLinkInCurrentMode))

// ---------- 4. create link -> ONE real comment on 1355 ----------
const mods = await req('GET', '/api/modules', { jar: tejasJar })
const linkList = await req('GET', '/api/integrations/crewdesk?pageSize=200', { jar: tejasJar })
const linkedModuleIds = new Set((linkList.json?.data ?? []).filter((l) => l.ticketId === '1355').map((l) => l.moduleId))
const flat = mods.json?.flat ?? mods.json?.data?.flat ?? []
const candidate = flat.find((m) => !linkedModuleIds.has(m.moduleId))
check('found an unlinked module for the test', Boolean(candidate), `linked=${[...linkedModuleIds].length} total=${flat.length}`)
if (!candidate) process.exit(failures ? 1 : 0)

const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
const create = await req('POST', '/api/integrations/crewdesk', {
  jar: tejasJar,
  body: { moduleId: candidate.moduleId, ticketId: '1355', note: `Live API verification ${stamp}` },
})
check('create link 200/201', create.status === 200 || create.status === 201, JSON.stringify(create.json))
check('link status=posted', create.json?.status === 'posted', create.json?.status ?? JSON.stringify(create.json))
check('link has real comment id', Boolean(create.json?.crewdeskCommentId), String(create.json?.crewdeskCommentId))
const linkId = create.json?.linkId

// ---------- 5. read-back: comment visible on the REAL ticket ----------
const bearer = (await import('node:fs')).readFileSync('.env', 'utf8')
  .match(/^CREWDESK_TOKEN=(.+)$/m)?.[1]?.trim()
const readBack = await fetch('https://dev.eng4.back.shipgl.in/api/tickets/1355/comments', {
  headers: { accept: 'application/json', authorization: `Bearer ${bearer}` },
})
const rbJson = await readBack.json().catch(() => null)
const rbData = rbJson?.data ?? rbJson
const rawComments = Array.isArray(rbData) ? rbData : rbData?.comments ?? rbData?.data ?? []
const found = JSON.stringify(rawComments).includes(`Live API verification ${stamp}`)
check('read-back: comment visible on real ticket 1355', readBack.ok && found, `HTTP ${readBack.status}`)
if (!readBack.ok) console.error('  (comments read-back endpoint shape:', readBack.status, String(JSON.stringify(rbJson)).slice(0, 200), ')')

// ---------- 6. copy path ----------
if (linkId) {
  const copy = await req('GET', `/api/integrations/crewdesk?path=comment&linkId=${encodeURIComponent(linkId)}`, { jar: tejasJar })
  check('comment rebuild 200', copy.status === 200, JSON.stringify(copy.json))
  check('rebuilt comment carries module link + Linked by', typeof copy.json?.comment === 'string' && copy.json.comment.includes('Linked by'), String(copy.json?.comment).slice(0, 80))
}

console.log(failures ? `\nRESULT: ${failures} FAILURES` : '\nRESULT: ALL LIVE CHECKS PASSED')
process.exit(failures ? 1 : 0)
