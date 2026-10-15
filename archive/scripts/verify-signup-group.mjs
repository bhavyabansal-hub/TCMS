/**
 * Owner bug repro + group-choice verification (2026-10-09):
 *   1. Self-signup WITH a chosen group -> role stored as chosen.
 *   2. THE OWNER'S BUG: a self-created account whose email EXISTS in the real
 *      Crew Desk must verify on the Integrations email check (it showed
 *      "email does not match" while the app was on the mock — must be
 *      'verified' on the dev backend).
 *   3. Self-signup WITHOUT a group -> least-privilege 'viewer' default.
 *   4. Self-signup with an invalid group -> 400 (server-side gate).
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

function cookieOf(res, name = 'tcms-access') {
  const pair = res.setCookie.find((c) => c.startsWith(`${name}=`))
  return pair ? pair.split(';')[0] : undefined
}

let failures = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok  ${name}`)
  else { failures++; console.error(`FAIL  ${name} ${detail}`) }
}

const stamp = Date.now().toString().slice(-6)
const password = 'Test@12345'

// Pick a REAL email from the live Crew Desk assignable list (read-only GET)
// so the repro mirrors the owner's scenario: same email on both sides.
const bearer = (await import('node:fs')).readFileSync('.env', 'utf8')
  .match(/^CREWDESK_TOKEN=(.+)$/m)?.[1]?.trim()
const cdList = await fetch('https://dev.eng4.back.shipgl.in/api/users/assignable', {
  headers: { accept: 'application/json', authorization: `Bearer ${bearer}` },
}).then((r) => r.json())
const cdUsers = cdList?.data?.users ?? []
if (!cdUsers.length) { console.error('FATAL: could not read the Crew Desk assignable list'); process.exit(1) }

let email = null
let reg = null
for (const u of cdUsers) {
  const candidate = String(u.email).toLowerCase()
  const attempt = await req('POST', '/api/auth?path=register', {
    body: { fullName: u.name || 'QA Group Choice', email: candidate, password, role: 'qa_engineer' },
  })
  if (attempt.status === 200 || attempt.status === 201) { email = candidate; reg = attempt; break }
  if (attempt.status === 409) continue // already a TCMS user — try the next Crew Desk member
  // Unexpected failure — surface it and stop.
  console.error(`FATAL: signup with ${candidate} -> ${attempt.status}`, JSON.stringify(attempt.json).slice(0, 200))
  process.exit(1)
}
if (!reg) { console.error('FATAL: every Crew Desk email already exists in TCMS'); process.exit(1) }
check(`self-signup with real Crew Desk email (${email})`, true)
check('chosen role stored (qa_engineer)', reg.json?.user?.role === 'qa_engineer', reg.json?.user?.role)
const jar = cookieOf(reg)

// 2. OWNER'S BUG repro: same email exists in Crew Desk -> must verify
const cfg = await req('GET', '/api/integrations/crewdesk?path=config', { jar })
check('new user can open Integrations (config 200)', cfg.status === 200, String(cfg.status))
const ec = await req('GET', '/api/integrations/crewdesk?path=email-check', { jar })
check('email-check 200', ec.status === 200, JSON.stringify(ec.json).slice(0, 160))
check('OWNER BUG FIXED: email verified against Crew Desk', ec.json?.status === 'verified', ec.json?.status)
check('email-check returned a checkedAt timestamp', typeof ec.json?.checkedAt === 'string', String(ec.json?.checkedAt))

// 3. signup WITHOUT group -> viewer default
const regDefault = await req('POST', '/api/auth?path=register', {
  body: { fullName: 'Default Group', email: `viewer.group${stamp}@shipglobal.in`, password },
})
check('signup without group -> viewer default', regDefault.json?.user?.role === 'viewer', regDefault.json?.user?.role)

// 4. invalid group -> 400
const regBad = await req('POST', '/api/auth?path=register', {
  body: { fullName: 'Bad Group', email: `bad.group${stamp}@shipglobal.in`, password, role: 'superadmin' },
})
check('invalid group refused (400)', regBad.status === 400, String(regBad.status))

console.log(failures ? `\nRESULT: ${failures} FAILURES` : '\nRESULT: ALL GROUP/EMAIL CHECKS PASSED')
process.exit(failures ? 1 : 0)
