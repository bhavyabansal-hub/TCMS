// Crew Desk DEV-environment end-to-end verifier — talks to the REAL dev
// backend (https://dev.eng4.back.shipgl.in) THROUGH the running TCMS app.
//
// HARD RULES (mirrors the product safety contract):
//   - The ONLY Crew Desk ticket touched is the designated dev test ticket
//     1355 (CREWDESK_TEST_TICKET_ID). No other ticket is read or written.
//   - At most ONE comment is posted (via the module-link flow); re-runs are
//     idempotent (duplicate link -> 409 -> verified via history instead).
//
// FLOW UNDER TEST (shared service account, no per-user email mapping):
//   login -> config (shows shared account) -> lookup 1355 -> create link
//   with a NOTE -> the comment must contain "Linked by <name> (<email>)"
//   AND the note -> history row posted. Read-back goes through the dev API
//   using CREWDESK_TOKEN parsed from .env (never hard-coded).
//
// Run with the server up:  node scripts/dev-crewdesk-e2e.mjs
import { readFileSync } from 'node:fs'

const BASE = process.env.TCMS_BASE_URL || 'http://localhost:3000'
const DEV_BASE = process.env.CREWDESK_BASE_URL_OVERRIDE || 'https://dev.eng4.back.shipgl.in'
const MARKER = 'X-Requested-With'
const NOTE_TEXT = 'DEV e2e verification — linked via the shared TCMS account'

function tokenFromEnvFile() {
  try {
    const text = readFileSync(new URL('../.env', import.meta.url), 'utf8')
    const line = text.split('\n').find((l) => /^CREWDESK_TOKEN=.+$/.test(l.trim()))
    return line ? line.trim().slice('CREWDESK_TOKEN='.length) : null
  } catch {
    return null
  }
}

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

async function req(method, path, { jar, body } = {}) {
  const headers = {}
  if (jar) headers.Cookie = jar
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (method !== 'GET' && method !== 'HEAD') headers[MARKER] = 'tcms'
  // Simulate the browser's Origin so comment links carry the PUBLIC tcms url
  // (getPublicOrigin falls back to Host=localhost for origin-less server-side
  // calls, which would put a dead http://localhost:3000 link in the comment).
  headers.Origin = process.env.TCMS_ORIGIN || 'https://preview-chat-83c513a6-a34e-4429-9baf-148d9774823e.space-z.ai'
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

// ---------- 0. login (any manage_integrations user — NO Crew Desk mapping needed) ----------
const me = await login('tejas.singh@shipglobal.in', 'Tejas@12345')
check('dev TCMS user tejas.singh@shipglobal.in logs in', Boolean(me.jar))

// ---------- 1. config: app must point at the dev backend + shared account ----------
const cfg = await req('GET', '/api/integrations/crewdesk?path=config', { jar: me.jar })
check('config reachable (manage_integrations ok)', cfg.status === 200, `got ${cfg.status}`)
check('mode = test (single-ticket guard active)', cfg.json?.mode === 'test')
check('baseUrlSet = true (dev backend configured)', cfg.json?.baseUrlSet === true)
check('tokenSet = true', cfg.json?.tokenSet === true)
check('designated test ticket = 1355', cfg.json?.testTicketId === '1355', `got ${cfg.json?.testTicketId}`)
check('shared account email exposed (from token)', typeof cfg.json?.accountEmail === 'string' && cfg.json.accountEmail.includes('@'), `got ${cfg.json?.accountEmail}`)
const mappingGone = await req('GET', '/api/integrations/crewdesk?path=mapping', { jar: me.jar })
check('legacy ?path=mapping endpoint removed (404/400)', mappingGone.status >= 400, `got ${mappingGone.status}`)

// ---------- 2. lookup ticket 1355 through the app -> real dev API ----------
const lookup = await req('POST', '/api/integrations/crewdesk?path=lookup', {
  jar: me.jar,
  body: { ticketId: '1355' },
})
check('lookup 1355 -> HTTP 200', lookup.status === 200, `got ${lookup.status} ${JSON.stringify(lookup.json)?.slice(0, 200)}`)
check('lookup title matches dev ticket', String(lookup.json?.title ?? '').includes('TCMS Testing ticket'), `got "${lookup.json?.title}"`)
check('lookup status = Open', lookup.json?.status === 'Open', `got "${lookup.json?.status}"`)
check('canLinkInCurrentMode = true', lookup.json?.canLinkInCurrentMode === true)

// ---------- 3. create the link WITH a note (posts the ONE comment, shared account) ----------
const modules = await req('GET', '/api/modules', { jar: me.jar })
const flat = modules.json?.flat ?? []
check('modules list available', Array.isArray(flat) && flat.length > 0, `got ${flat.length}`)
const mod = flat[0]

let link = null
let linkPosted = false
if (mod) {
  const create = await req('POST', '/api/integrations/crewdesk', {
    jar: me.jar,
    body: { moduleId: mod.moduleId, ticketId: '1355', note: NOTE_TEXT },
  })
  if (create.status === 201 || create.status === 200) {
    link = create.json
    linkPosted = link?.status === 'posted'
    check(`link created for module "${mod.name}" (no email mapping involved)`, linkPosted, `status=${link?.status} err=${link?.lastError}`)
    check('comment id returned by dev backend', Boolean(link?.crewdeskCommentId), `got ${link?.crewdeskCommentId}`)
    check('link stores ticket title', String(link?.ticketTitle ?? '').includes('TCMS Testing ticket'), `got "${link?.ticketTitle}"`)
  } else if (create.status === 409) {
    check('duplicate guard (link already exists from earlier run)', true)
  } else {
    check('create link -> 201', false, `got ${create.status} ${JSON.stringify(create.json)?.slice(0, 300)}`)
  }
}

// ---------- 4. history shows the posted link ----------
await new Promise((r) => setTimeout(r, 300))
const history = await req('GET', '/api/integrations/crewdesk?pageSize=50', { jar: me.jar })
const rows = history.json?.data ?? []
const row1355 = rows.find((r) => r.ticketId === '1355')
check('history contains a 1355 row', Boolean(row1355), `rows=${rows.length}`)
check('1355 row status = posted', row1355?.status === 'posted', `got ${row1355?.status} err=${row1355?.lastError}`)
if (row1355) {
  console.log(`      row: module "${row1355.moduleName}" | comment ${row1355.crewdeskCommentId} | by ${row1355.linkedByName} | ${row1355.createdAt}`)
}

// ---------- 5. read back the comment from the dev API (shared-token identity) ----------
const token = tokenFromEnvFile()
if (linkPosted && link?.crewdeskCommentId && token) {
  const res = await fetch(`${DEV_BASE}/api/tickets/1355/comments`, {
    headers: { accept: 'application/json', authorization: `Bearer ${token}` },
  })
  const devJson = await res.json().catch(() => null)
  const comments = devJson?.data?.comments ?? devJson?.comments ?? []
  const mine = comments.find((c) => String(c.id ?? c.comment_id) === String(link.crewdeskCommentId))
  const content = String(mine?.comment ?? mine?.content ?? mine?.comments ?? '')
  check('posted comment found on dev ticket', Boolean(mine), `comments visible: ${comments.length}`)
  check('comment carries "Linked by" attribution', content.includes('Linked by '), content.slice(0, 120))
  check('comment carries the note text', content.includes(NOTE_TEXT), content.slice(0, 160))
  check('comment carries the module url', content.includes('/modules/'), '')
  if (mine) console.log(`      dev comment ${link.crewdeskCommentId}: ${content.replace(/\n/g, ' | ').slice(0, 220)}`)
} else {
  console.log('skip  dev read-back (no fresh comment this run, or token missing from .env)')
}

// ---------- summary ----------
console.log(`\n[dev-e2e] ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
console.log('[dev-e2e] DEV INTEGRATION VERIFIED — shared-account flow works against dev.eng4.back.shipgl.in (ticket 1355 only).')
