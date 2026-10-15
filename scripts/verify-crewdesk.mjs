// Crew Desk integration verifier — MOCK-ONLY by design.
//
// HARD RULE: this suite NEVER talks to a real Crew Desk address. It runs
// against the local mock (mini-services/crewdesk-mock, port 3010), which
// itself rejects any ticket it does not define.
//
// The suite ADAPTS to the mode the server was started with and covers the
// product spec:
//   - ONE shared account: every comment's user_id === CREWDESK_USER_ID,
//     never a person's own Crew Desk id; no per-user email mapping exists.
//   - verification-only email check: found / NOT FOUND (exact message,
//     nothing posted) / case-insensitive / down. Email exceptions were
//     REMOVED by product decision — the suite proves the endpoints are gone
//     and that no hidden mapping path remains.
//   - manual mode: zero Crew Desk traffic, copyable comment + module link.
//   - safety: test mode refuses every ticket except the designated one,
//     before any network byte is sent.
//   - login mode: 401 -> one re-login + retry; 3 failed logins -> 15-min
//     backoff with a friendly message (no more network attempts).
//   - no real people's emails, tokens or passwords anywhere in this file.
//
// Run with the app up:  node scripts/verify-crewdesk.mjs [--phase=NAME]
// (the run-crewdesk-tests.sh driver restarts the app per phase)
const BASE = process.env.TCMS_BASE_URL || 'http://localhost:3000'
const MOCK = process.env.CREWDESK_MOCK_URL || 'http://127.0.0.1:3010'
const MOCK_TOKEN = 'mock-local-token'
const MARKER = 'X-Requested-With'
const ORIGIN = process.env.TCMS_ORIGIN || 'https://preview-chat-83c513a6-a34e-4429-9baf-148d9774823e.space-z.ai'
// .env is NOT auto-loaded into node scripts — read the DB URL for the one
// direct-database probe below (same pattern as scripts/db-check-*.mjs).
import { readFileSync } from 'node:fs'
const DATABASE_URL = (() => {
  try {
    const line = readFileSync(new URL('../.env', import.meta.url), 'utf8')
      .split('\n').find((l) => l.startsWith('DATABASE_URL='))
    // trim + strip surrounding quotes: .env values may be quoted (URLs contain '&')
    return line?.slice('DATABASE_URL='.length).trim().replace(/^["']+|["']+$/g, '')
  } catch { return null }
})()

const phaseArg = process.argv.find((a) => a.startsWith('--phase='))
const PHASE = phaseArg ? phaseArg.split('=')[1] : 'auto'

let passed = 0
let failed = 0
function check(name, cond, extra = '') {
  if (cond) {
    passed++
    console.log(`  ok  ${name}`)
  } else {
    failed++
    console.log(`FAIL  ${name} ${extra}`)
  }
}

async function req(method, path, { jar, body, noMarker, noOrigin } = {}) {
  const headers = {}
  if (jar) headers.Cookie = jar
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (method !== 'GET' && method !== 'HEAD' && !noMarker) headers[MARKER] = 'tcms'
  if ((method === 'POST' || method === 'DELETE') && !noOrigin) headers.Origin = ORIGIN
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* non-JSON */ }
  return { status: res.status, json, text, setCookie: res.headers.getSetCookie?.() ?? [] }
}

async function login(email, password) {
  const res = await req('POST', '/api/auth?path=login', { body: { email, password } })
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(res.json)}`)
  const pick = (name) => {
    const pair = res.setCookie.find((c) => c.startsWith(`${name}=`))
    return pair ? pair.split(';')[0].slice(name.length + 1) : undefined
  }
  return { jar: `tcms-access=${pick('tcms-access')}`, json: res.json }
}

const jarOf = (s) => s.jar

// ---------- mock helpers ----------
async function mockReset() {
  await fetch(`${MOCK}/__mock/reset`, { method: 'POST', headers: { Authorization: `Bearer ${MOCK_TOKEN}` } })
}
async function mockConfig(mode) {
  const res = await fetch(`${MOCK}/__mock/config`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MOCK_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  })
  return res.status
}
async function mockComments() {
  const res = await fetch(`${MOCK}/__mock/comments`, { headers: { Authorization: `Bearer ${MOCK_TOKEN}` } })
  return (await res.json()).data
}
async function mockStats() {
  const res = await fetch(`${MOCK}/__mock/stats`, { headers: { Authorization: `Bearer ${MOCK_TOKEN}` } })
  return (await res.json()).data
}
async function mockLogin() {
  const res = await fetch(`${MOCK}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'tcms.service@crewdesk.test', password: 'mock-login-secret' }),
  })
  return (await res.json()).data.token
}

const stamp = Date.now()
// FICTIONAL fixture accounts only. CASE_USER proves the check lowercases the
// TCMS email: the TCMS account holds mixed case, the mock entry is
// 'Mixed.Case@crewdesk.test' (id 7003) and matching happens lowercased.
const FOUND_USER = { email: 'dana.reyes@crewdesk.test', fullName: 'Dana Reyes', password: 'Test@12345', role: 'manager' }
const CASE_USER = { email: 'Mixed.Case@crewdesk.test', fullName: 'Case Test', password: 'Test@12345', role: 'manager' }
const MISSING_USER = { email: 'nowhere@tcms.test', fullName: 'Not On Crew Desk', password: 'Test@12345', role: 'manager' }
// Kept to PROVE email exceptions are gone: her email is not on Crew Desk and
// no admin mapping may exist anymore — the check must answer not_found.
const UNMAPPED_USER = { email: 'p.quill@tcms.test', fullName: 'P Quill', password: 'Test@12345', role: 'manager' }

async function ensureUser(adminJar, spec) {
  const found = await req('GET', `/api/users?search=${encodeURIComponent(spec.email)}`, { jar: adminJar })
  // EXACT compare — the search itself is case-insensitive and would wrongly
  // match a different fixture user whose email differs only by case.
  const existing = (found.json?.data ?? []).find((u) => u.email === spec.email)
  if (existing) return existing
  const created = await req('POST', '/api/users', { jar: adminJar, body: spec })
  if (created.status !== 200 && created.status !== 201) {
    throw new Error(`fixture user ${spec.email} could not be created: ${JSON.stringify(created.json)}`)
  }
  return created.json
}

// ---------- 0. reset + sessions ----------
await mockReset()
const admin = await login('admin@tcms.com', 'Admin@123')

const cfg = (await req('GET', '/api/integrations/crewdesk?path=config', { jar: jarOf(admin) })).json
const MODE = cfg?.mode // manual | test | live
const AUTH = cfg?.authMode // token | login | none
// The full posting-pipeline section runs ONLY in the dedicated test phases —
// the badcreds phase intentionally has no working credentials at all.
const RUN_TEST_SECTION = (PHASE === 'auto' || PHASE === 'test-login' || PHASE === 'test-token') && MODE === 'test'
console.log(`[verify] phase=${PHASE} mode=${MODE} authMode=${AUTH}`)
if (PHASE !== 'auto') {
  const expected =
    PHASE === 'manual' ? MODE === 'manual' :
    PHASE === 'test-login' ? MODE === 'test' && AUTH === 'login' :
    PHASE === 'test-token' ? MODE === 'test' && AUTH === 'token' :
    PHASE === 'badcreds' ? MODE === 'test' && AUTH === 'login' :
    true
  check(`phase mode is ${PHASE}`, expected, `got mode=${MODE} auth=${AUTH}`)
}

// ---------- 1. auth gates + self-signup policy ----------
const anonList = await req('GET', '/api/integrations/crewdesk')
check('logged-out GET history -> 401', anonList.status === 401, `got ${anonList.status}`)
const anonCreate = await req('POST', '/api/integrations/crewdesk', { body: { moduleId: 'x', ticketId: '1355' } })
check('logged-out POST link -> 401', anonCreate.status === 401, `got ${anonCreate.status}`)
// Self-signup is ENABLED (owner decision 2026-10-08): a new account signs in
// immediately with the LEAST-privileged role ('viewer'); duplicates -> 409.
const signupEmail = `self-${stamp}@tcms.test`
const signupBody = { email: signupEmail, fullName: 'Self Signup', password: 'Self@12345' }
const reg = await req('POST', '/api/auth?path=register', { body: signupBody })
check('self-signup -> 200 session with viewer role', reg.status === 200 && reg.json?.user?.role === 'viewer', `got ${reg.status} ${JSON.stringify(reg.json)}`)
const regDup = await req('POST', '/api/auth?path=register', { body: signupBody })
check('duplicate self-signup -> 409 conflict', regDup.status === 409, `got ${regDup.status} ${JSON.stringify(regDup.json)}`)
const regWeak = await req('POST', '/api/auth?path=register', { body: { email: `self-weak-${stamp}@tcms.test`, fullName: 'Weak Pw', password: 'short' } })
check('weak-password self-signup -> 400 validation', regWeak.status === 400, `got ${regWeak.status}`)

// ---------- 2. fixture users + modules (created by the ADMIN, never self-serve) ----------
await ensureUser(jarOf(admin), FOUND_USER)
await ensureUser(jarOf(admin), CASE_USER)
await ensureUser(jarOf(admin), MISSING_USER)
await ensureUser(jarOf(admin), UNMAPPED_USER)
const dana = await login(FOUND_USER.email, FOUND_USER.password)
check('fixture manager (email present on mock) logs in', Boolean(dana.jar))
// CSRF funnel: an authenticated mutation WITHOUT the marker (and WITHOUT a
// trusted Origin, which alone would satisfy the same-origin check) is refused.
const csrfless = await req('POST', '/api/integrations/crewdesk', { jar: jarOf(dana), body: { moduleId: 'x', ticketId: '1355' }, noMarker: true, noOrigin: true })
check('mutation without CSRF marker -> 403', csrfless.status === 403, `got ${csrfless.status}`)
const casey = await login(CASE_USER.email, CASE_USER.password)
const nobody = await login(MISSING_USER.email, MISSING_USER.password)
const quill = await login(UNMAPPED_USER.email, UNMAPPED_USER.password)

async function makeModule(name) {
  const res = await req('POST', '/api/modules', { jar: jarOf(dana), body: { name, description: 'crewdesk verify fixture' } })
  if (res.status !== 200 && res.status !== 201) throw new Error(`module create failed: ${JSON.stringify(res.json)}`)
  return res.json.moduleId ?? res.json.module?.moduleId
}
const modA = await makeModule(`CD-verify-A ${stamp}`)
const modB = await makeModule(`CD-verify-B ${stamp}`)
const modC = await makeModule(`CD-verify-C ${stamp}`)
const modD = await makeModule(`CD-verify-D ${stamp}`)
const modE = await makeModule(`CD-verify-E ${stamp}`)
check('fixture modules created (manager)', Boolean(modA && modB && modC && modD && modE))

// ============================================================
// PHASE: manual — everything happens WITHOUT any Crew Desk call
// ============================================================
if (MODE === 'manual') {
  console.log('--- manual mode section ---')
  const badge = await req('GET', '/api/integrations/crewdesk?path=email-check', { jar: jarOf(dana) })
  check('email-check answers WITHOUT network in manual mode', badge.status === 200 && typeof badge.json?.status === 'string', JSON.stringify(badge.json))
  const lookupManual = await req('POST', '/api/integrations/crewdesk?path=lookup', { jar: jarOf(dana), body: { ticketId: '1355' } })
  check('lookup refused in manual mode (no Crew Desk calls)', lookupManual.status === 400, `got ${lookupManual.status}`)
  const statsBefore = (await mockStats()).stats
  const gen = await req('POST', '/api/integrations/crewdesk', { jar: jarOf(dana), body: { moduleId: modA, ticketId: '', note: 'hello from manual' } })
  check('manual generate (empty ticket id ok) -> manual row', gen.status === 201 && gen.json?.status === 'manual', JSON.stringify(gen.json))
  check('manual generate made ZERO login/comment calls', JSON.stringify((await mockStats()).stats) === JSON.stringify(statsBefore))
  const stats1 = (await mockComments()).count
  check('manual generate posted NO comment', stats1 === 0, `got ${stats1}`)
  const copy = await req('GET', `/api/integrations/crewdesk?path=comment&linkId=${gen.json.linkId}`, { jar: jarOf(dana) })
  check('comment-for-copy rebuilds the exact text', copy.status === 200 && copy.json?.comment?.includes(`TCMS: test cases for module "CD-verify-A ${stamp}"`), JSON.stringify(copy.json))
  check('copy text carries the Linked by line', /Linked by Dana Reyes \(dana\.reyes@crewdesk\.test\)/.test(copy.json?.comment ?? ''), JSON.stringify(copy.json))
  check('copy text carries the note', (copy.json?.comment ?? '').endsWith('hello from manual'))
  check('copy text carries the module url', (copy.json?.moduleUrl ?? '').includes(`/modules/${modA}`))
  const genNoMod = await req('POST', '/api/integrations/crewdesk', { jar: jarOf(dana), body: { moduleId: 'nope', ticketId: '' } })
  check('manual generate for unknown module -> 404', genNoMod.status === 404, `got ${genNoMod.status}`)
  const retryManual = await req('POST', `/api/integrations/crewdesk?path=retry&linkId=${gen.json.linkId}`, { jar: jarOf(dana), body: {} })
  check('retry on a manual row -> 409 (nothing to retry)', retryManual.status === 409, `got ${retryManual.status}`)
  const viewer = await login('viewer@tcms.com', 'View@12345')
  const viewerGen = await req('POST', '/api/integrations/crewdesk', { jar: jarOf(viewer), body: { moduleId: modB, ticketId: '' } })
  check('viewer generate -> 403', viewerGen.status === 403, `got ${viewerGen.status}`)
}

// ============================================================
// PHASE: test (login OR token auth) — the full posting pipeline
// ============================================================
if (RUN_TEST_SECTION) {
  console.log('--- test mode section ---')
  // Start each phase with a CLEAN slate for the fixture users: a stored check
  // from a previous phase would short-circuit the network path (24h rule) and
  // hide the live-lookup behavior these checks are meant to prove.
  {
    if (!DATABASE_URL) throw new Error('DATABASE_URL missing from .env for the DB probe')
    const { PrismaClient } = await import('@prisma/client')
    const pdb = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } })
    await pdb.user.updateMany({
      where: { email: { in: [FOUND_USER.email, CASE_USER.email, MISSING_USER.email, UNMAPPED_USER.email] } },
      data: { crewdeskUserId: null, crewdeskCheckedAt: null },
    })
    await pdb.$disconnect()
  }
  // ---------- config hygiene ----------
  check('config exposes NO token material', !JSON.stringify(cfg).toLowerCase().includes('bearer') && !JSON.stringify(cfg).toLowerCase().includes('tokenvalue'), JSON.stringify(cfg))
  check('config reports the designated test ticket 1355', cfg?.testTicketId === '1355', `got ${cfg?.testTicketId}`)

  // ---------- badge: found / case-insensitive / not found ----------
  const badgeDana = await req('GET', '/api/integrations/crewdesk?path=email-check', { jar: jarOf(dana) })
  check('email found -> verified with stored id 7002', badgeDana.json?.status === 'verified' && badgeDana.json?.crewdeskUserId === '7002', JSON.stringify(badgeDana.json))
  const badgeAgain = await req('GET', '/api/integrations/crewdesk?path=email-check', { jar: jarOf(dana) })
  check('fresh stored check answered without refetch (24h rule)', badgeAgain.json?.status === 'verified' && badgeAgain.json?.checkedAt === badgeDana.json?.checkedAt, JSON.stringify({ a: badgeDana.json?.checkedAt, b: badgeAgain.json?.checkedAt }))
  const statsAfterFirst = (await mockStats()).stats.loginAttempts
  const badgeCase = await req('GET', '/api/integrations/crewdesk?path=email-check', { jar: jarOf(casey) })
  check('MIXED-CASE tcms email matches lowercased crewdesk entry', badgeCase.json?.status === 'verified' && badgeCase.json?.crewdeskUserId === '7003', JSON.stringify(badgeCase.json))
  const badgeMissing = await req('GET', '/api/integrations/crewdesk?path=email-check', { jar: jarOf(nobody) })
  check('unknown email -> not_found badge (never stores an id)', badgeMissing.json?.status === 'not_found' && badgeMissing.json?.crewdeskUserId === null, JSON.stringify(badgeMissing.json))
  const missingRow = await req('GET', `/api/users?search=${encodeURIComponent(MISSING_USER.email)}`, { jar: jarOf(admin) })
  const missingRowUser = (missingRow.json?.data ?? []).find((u) => u.email === MISSING_USER.email)
  {
    // The users API never exposes crewdeskUserId (internal only) — probe the DB.
    if (!DATABASE_URL) throw new Error('DATABASE_URL missing from .env for the DB probe')
    const { PrismaClient } = await import('@prisma/client')
    const pdb = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } })
    const row = await pdb.user.findUnique({ where: { email: MISSING_USER.email }, select: { crewdeskUserId: true, crewdeskCheckedAt: true } })
    await pdb.$disconnect()
    check('unknown email persists NO Crew Desk id and NO checked_at', Boolean(missingRowUser) && row && row.crewdeskUserId === null && row.crewdeskCheckedAt === null, JSON.stringify(row))
  }

  // ---------- email exceptions are REMOVED (product decision) ----------
  const exAdd = await req('POST', '/api/integrations/crewdesk?path=exceptions', { jar: jarOf(admin), body: { tcmsEmail: 'p.quill@tcms.test', crewdeskEmail: 'dana.reyes@crewdesk.test' } })
  check('exceptions endpoint REMOVED -> 400 unknown path', exAdd.status === 400, `got ${exAdd.status} ${JSON.stringify(exAdd.json)}`)
  const badgeQuill = await req('GET', '/api/integrations/crewdesk?path=email-check', { jar: jarOf(quill) })
  check('NO hidden mapping path: unmapped email stays not_found', badgeQuill.json?.status === 'not_found' && badgeQuill.json?.crewdeskUserId === null, JSON.stringify(badgeQuill.json))

  // ---------- lookup ----------
  const lookup = await req('POST', '/api/integrations/crewdesk?path=lookup', { jar: jarOf(dana), body: { ticketId: '1355' } })
  check('lookup 1355 -> title + current status', lookup.status === 200 && Boolean(lookup.json?.title) && lookup.json?.status === 'Open', JSON.stringify(lookup.json))
  check('lookup reports test mode + canLink for 1355', lookup.json?.mode === 'test' && lookup.json?.canLinkInCurrentMode === true)
  const lookupMiss = await req('POST', '/api/integrations/crewdesk?path=lookup', { jar: jarOf(dana), body: { ticketId: '424242' } })
  check('lookup unknown ticket -> 404 "Ticket not found"', lookupMiss.status === 404 && lookupMiss.json?.error === 'Ticket not found', `got ${lookupMiss.status} ${JSON.stringify(lookupMiss.json)}`)

  // ---------- happy path: the ONLY comment posted in this run ----------
  const rawNote = `Note with\tcontrol\nchars ${'x'.repeat(340)}`
  const beforeHappy = (await mockComments()).count
  const happy = await req('POST', '/api/integrations/crewdesk', { jar: jarOf(dana), body: { moduleId: modA, ticketId: '1355', note: rawNote } })
  check('create link -> 201 posted', happy.status === 201 && happy.json?.status === 'posted', `got ${happy.status} ${JSON.stringify(happy.json)}`)
  check('link stores Crew Desk comment id', Boolean(happy.json?.crewdeskCommentId), JSON.stringify(happy.json))
  const comments = (await mockComments()).comments
  check('exactly one new comment reached the mock', comments.length === beforeHappy + 1, `before ${beforeHappy} after ${comments.length}`)
  const sent = comments[comments.length - 1]
  check('comment user_id = CREWDESK_USER_ID (shared account only)', sent?.user_id === (process.env.EXPECTED_USER_ID || '7001'), `got ${sent?.user_id}`)
  check('comment status = ticket current status (Open)', sent?.status === 'Open', JSON.stringify(sent))
  check('comment carries plain module URL', sent?.content?.includes(`${ORIGIN}/modules/${modA}`) === true, JSON.stringify(sent?.content))
  check('comment carries "Linked by <tcms name> (<tcms email>)"', sent?.content?.includes(`Linked by ${FOUND_USER.fullName} (${FOUND_USER.email})`), JSON.stringify(sent?.content))
  {
    // The note is the THIRD line of the comment (link, Linked by, note) and
    // must be a single control-char-free line: tabs/newlines became spaces,
    // the words survived, and the line was capped at 300 chars. (The \r\n
    // separators BETWEEN comment lines are the comment's own line breaks.)
    const noteLine = String(sent?.content ?? '').split(/\r?\n/)[2] ?? ''
    check('note sanitized: control chars removed, single line', noteLine.startsWith('Note with control chars') && !/[\t\r\n\x00-\x1F\x7F]/.test(noteLine) && noteLine.length <= 300, JSON.stringify(noteLine))
  }
  check('note truncated to 300 chars', (sent?.content?.match(/x/g) ?? []).length <= 300)
  const ticketsAfter = await fetch(`${MOCK}/__mock/tickets`, { headers: { Authorization: `Bearer ${MOCK_TOKEN}` } }).then((r) => r.json())
  check('mock ticket 1355 status UNCHANGED after comment', ticketsAfter.data.tickets.find((t) => t.id === '1355').status === 'Open')

  // ---------- duplicate + guard + not-found ----------
  const dupCount = (await mockComments()).count
  const dup = await req('POST', '/api/integrations/crewdesk', { jar: jarOf(dana), body: { moduleId: modA, ticketId: '1355' } })
  check('duplicate module+ticket -> 409', dup.status === 409, `got ${dup.status} ${JSON.stringify(dup.json)}`)
  check('duplicate attempt sent NO comment', (await mockComments()).count === dupCount)
  const guard = await req('POST', '/api/integrations/crewdesk', { jar: jarOf(dana), body: { moduleId: modB, ticketId: '4191' } })
  check('test-mode link to 4191 -> refused by guard', guard.json?.status === 'failed' && /CREWDESK_MODE=test/.test(guard.json?.lastError ?? ''), JSON.stringify(guard.json))
  check('mock received ZERO comments for 4191', (await mockComments()).comments.every((c) => c.ticket_id !== '4191'))
  const nf = await req('POST', '/api/integrations/crewdesk', { jar: jarOf(dana), body: { moduleId: modB, ticketId: '424242' } })
  check('link to unknown ticket -> failed row "Ticket not found", input kept', nf.status === 201 && nf.json?.status === 'failed' && nf.json?.lastError === 'Ticket not found' && nf.json?.ticketId === '424242', JSON.stringify(nf.json))

  // ---------- email check blocks BEFORE posting ----------
  const blocked = await req('POST', '/api/integrations/crewdesk', { jar: jarOf(nobody), body: { moduleId: modC, ticketId: '1355', note: 'should never post' } })
  check('unverified email -> failed row with EXACT product message', blocked.json?.status === 'failed' && blocked.json?.lastError === 'Your email was not found in Crew Desk. Ask your admin.', JSON.stringify(blocked.json))
  check('blocked attempt sent NO comment', (await mockComments()).count === dupCount)

  // ---------- Crew Desk DOWN ----------
  await mockConfig('down')
  const downLookup = await req('POST', '/api/integrations/crewdesk?path=lookup', { jar: jarOf(dana), body: { ticketId: '1355' } })
  check('Crew Desk down -> clear unreachable message (502, not 401)', downLookup.status === 502 && /unreachable/i.test(downLookup.json?.error ?? ''), `got ${downLookup.status} ${JSON.stringify(downLookup.json)}`)
  const downLink = await req('POST', '/api/integrations/crewdesk', { jar: jarOf(dana), body: { moduleId: modD, ticketId: '1355' } })
  check('Crew Desk down -> failed row, input kept', downLink.json?.status === 'failed' && downLink.json?.ticketId === '1355', JSON.stringify(downLink.json))
  const downBadge = await req('GET', '/api/integrations/crewdesk?path=email-check', { jar: jarOf(dana) })
  check('badge degrades gracefully when Crew Desk is down', downBadge.status >= 500 || downBadge.status === 200, `got ${downBadge.status}`)
  await mockConfig('ok')

  // ---------- retry (after fault cleared) ----------
  const retry = await req('POST', `/api/integrations/crewdesk?path=retry&linkId=${downLink.json.linkId}`, { jar: jarOf(dana), body: {} })
  check('retry after recovery -> posted', retry.status === 200 && retry.json?.status === 'posted' && Boolean(retry.json?.crewdeskCommentId), JSON.stringify(retry.json))
  const retryAgain = await req('POST', `/api/integrations/crewdesk?path=retry&linkId=${downLink.json.linkId}`, { jar: jarOf(dana), body: {} })
  check('retry on posted link -> 409', retryAgain.status === 409, `got ${retryAgain.status}`)

  // ---------- history ----------
  const list = await req('GET', '/api/integrations/crewdesk', { jar: jarOf(dana) })
  check('history lists rows with module + linker names + note', list.json?.data?.length >= 4 && Boolean(list.json.data[0].moduleName) && Boolean(list.json.data[0].linkedByName) && 'note' in list.json.data[0], `got ${list.json?.data?.length}`)
  const paged = await req('GET', '/api/integrations/crewdesk?page=1&pageSize=2', { jar: jarOf(dana) })
  check('history pagination works', paged.json?.data?.length === 2, JSON.stringify(paged.json?.totalPages))
  const postedCopy = await req('GET', `/api/integrations/crewdesk?path=comment&linkId=${retry.json.linkId}`, { jar: jarOf(dana) })
  check('posted row comment-for-copy includes Linked by + url', postedCopy.json?.comment?.includes('Linked by') && postedCopy.json?.moduleUrl?.includes('/modules/'), JSON.stringify(postedCopy.json))

  // ---------- viewer cannot link ----------
  const viewer = await login('viewer@tcms.com', 'View@12345')
  const viewerLink = await req('POST', '/api/integrations/crewdesk', { jar: jarOf(viewer), body: { moduleId: modE, ticketId: '1355' } })
  check('viewer create link -> 403', viewerLink.status === 403, `got ${viewerLink.status}`)
}

// ============================================================
// AUTH-SPECIFIC sections (both run inside mode=test phases)
// ============================================================
if (RUN_TEST_SECTION && AUTH === 'login') {
  console.log('--- login-mode section (401 recovery) ---')
  const stats0 = (await mockStats()).stats
  await mockConfig('badtoken') // bumps the epoch: cached JWT instantly 401
  const recovered = await req('POST', '/api/integrations/crewdesk?path=lookup', { jar: jarOf(dana), body: { ticketId: '1355' } })
  check('401 -> automatic re-login + ONE retry succeeds', recovered.status === 200 && Boolean(recovered.json?.title), `got ${recovered.status} ${JSON.stringify(recovered.json)}`)
  const stats1 = (await mockStats()).stats
  check('exactly one fresh login was made during recovery', stats1.loginSuccesses === stats0.loginSuccesses + 1, JSON.stringify({ before: stats0, after: stats1 }))
  await mockConfig('ok')
}

if (RUN_TEST_SECTION && AUTH === 'token') {
  console.log('--- token-mode section (fixed credential, no auto-recovery) ---')
  if (process.env.EXPECTED_USER_ID === '9999') {
    console.log('  (CREWDESK_USER_ID=9999 intentionally mismatches the JWT claim — the startup warning is asserted by the driver)')
  }
  const stats0 = (await mockStats()).stats.loginAttempts
  await mockConfig('badtoken')
  const unauth = await req('POST', '/api/integrations/crewdesk?path=lookup', { jar: jarOf(dana), body: { ticketId: '1355' } })
  check('invalid fixed token -> clear unauthorized message (502, NOT a session-kill 401)', unauth.status === 502 && /expired or invalid/i.test(unauth.json?.error ?? ''), `got ${unauth.status} ${JSON.stringify(unauth.json)}`)
  const stats1 = (await mockStats()).stats.loginAttempts
  check('token mode makes NO login attempts (fixed credential)', stats1 === stats0, `before ${stats0} after ${stats1}`)
  await mockConfig('ok')
}

// ============================================================
// PHASE: badcreds — login mode with a WRONG password
// ============================================================
if (PHASE === 'badcreds') {
  console.log('--- bad-credentials section (3-strike backoff) ---')
  const stats0 = (await mockStats()).stats
  for (let i = 1; i <= 4; i++) {
    const r = await req('POST', '/api/integrations/crewdesk?path=lookup', { jar: jarOf(dana), body: { ticketId: '1355' } })
    check(`wrong-credentials lookup #${i} -> friendly blocked message (502)`, r.status === 502 && r.json?.error === 'Crew Desk login failed, contact admin', `got ${r.status} ${JSON.stringify(r.json)}`)
  }
  const stats1 = (await mockStats()).stats
  check('exactly 3 login attempts hit the mock, the 4th was blocked locally', stats1.loginAttempts - stats0.loginAttempts === 3, JSON.stringify({ before: stats0.loginAttempts, after: stats1.loginAttempts }))
}

// ---------- page shells + cleanup ----------
const modPage = await fetch(`${BASE}/modules/${modA}`)
check('GET /modules/<id> renders (permanent URL)', modPage.status === 200, `got ${modPage.status}`)
const loginNext = await fetch(`${BASE}/login?next=${encodeURIComponent(`/modules/${modA}`)}`)
check('GET /login?next=/modules/<id> renders (login-only screen)', loginNext.status === 200, `got ${loginNext.status}`)

// cleanup: the self-signup fixture user is deactivated through the Users API
if (reg.json?.user?.userId) {
  const deact = await req('DELETE', `/api/users?id=${reg.json.user.userId}`, { jar: jarOf(admin) })
  check('self-signup fixture user deactivated', deact.status === 200, `got ${deact.status} ${JSON.stringify(deact.json)}`)
}

// cleanup: fixture modules cascade their links
for (const id of [modA, modB, modC, modD, modE]) {
  await req('DELETE', `/api/modules?id=${id}`, { jar: jarOf(dana) })
}
const linksAfterCleanup = await req('GET', '/api/integrations/crewdesk', { jar: jarOf(dana) })
check('fixture cleanup removed links (module cascade)', (linksAfterCleanup.json?.data ?? []).every((l) => ![modA, modB, modC, modD, modE].includes(l.moduleId)))
await mockReset()

console.log('======================================')
console.log(`CREWDESK RESULT [phase=${PHASE} mode=${MODE} auth=${AUTH}]: ${passed} passed, ${failed} failed`)
console.log('======================================')
process.exit(failed ? 1 : 0)
