// Crew Desk REAL-API smoke test — the ONLY sanctioned script that touches the
// real Crew Desk API, and it is hard-locked to the designated test ticket.
//
// HARD GUARANTEES (by construction, not by configuration):
//   - TICKET_ID is a constant '1355' (owner-designated test ticket). There is
//     no argument, no env, no flag
//     that can change it. It posts EXACTLY ONE comment, then exits.
//   - The content starts with the literal marker "[TCMS TEST]" so readers of
//     the ticket know it is automated test traffic.
//   - The comment echoes the ticket's CURRENT status and never sends
//     status_id, so the ticket's status cannot move.
//   - Form-data only (the real endpoint does not accept JSON).
//
// RUN (on the server, after setting the real env):
//   CREWDESK_BASE_URL=https://api.crewdesk.shipgl.in \
//   CREWDESK_TOKEN=<real token> \
//   node scripts/crewdesk-real-smoke.mjs
//
// It refuses to run when CREWDESK_TOKEN / CREWDESK_BASE_URL are missing, so
// it can never accidentally fire at the mock or without credentials.

const TICKET_ID = '1355' // HARD LOCK — do not edit; see header.
const MARKER_PREFIX = '[TCMS TEST]'
const TEST_EMAIL = 'bhavya.bansal@shipglobal.in' // designated testing account
const TIMEOUT_MS = 10_000

const BASE_URL = (process.env.CREWDESK_BASE_URL || '').replace(/\/+$/, '')
const TOKEN = process.env.CREWDESK_TOKEN || ''

if (!BASE_URL || !TOKEN) {
  console.error('[smoke] refusing to run: set CREWDESK_BASE_URL and CREWDESK_TOKEN first.')
  console.error('[smoke] example: CREWDESK_BASE_URL=https://api.crewdesk.shipgl.in CREWDESK_TOKEN=... node scripts/crewdesk-real-smoke.mjs')
  process.exit(1)
}

const authHeaders = { Authorization: `Bearer ${TOKEN}` }

async function fetchJson(path, init = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${BASE_URL}${path}`, { ...init, headers: { ...authHeaders, ...init.headers }, signal: controller.signal })
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    return { status: res.status, json }
  } finally {
    clearTimeout(timer)
  }
}

// ---- 1. map the designated tester by lowercase email ----
const assignable = await fetchJson('/api/users/assignable')
if (assignable.status !== 200) {
  console.error(`[smoke] assignable-users failed: HTTP ${assignable.status}. Token may be expired.`)
  process.exit(1)
}
const users = assignable.json?.data?.users ?? assignable.json?.data ?? []
const me = (Array.isArray(users) ? users : []).find((u) => String(u?.email ?? '').toLowerCase() === TEST_EMAIL)
if (!me || !me.id) {
  console.error(`[smoke] ${TEST_EMAIL} not found in Crew Desk assignable users. Ask a Crew Desk admin to add that account, then re-run.`)
  process.exit(1)
}
console.log(`[smoke] mapped ${TEST_EMAIL} -> Crew Desk user ${me.id}`)

// ---- 2. read ticket 1355 (title + current status) ----
const ticket = await fetchJson(`/api/tickets/${TICKET_ID}`)
if (ticket.status !== 200 || !ticket.json || ticket.json.status === 'error') {
  console.error(`[smoke] get ticket ${TICKET_ID} failed: HTTP ${ticket.status} ${JSON.stringify(ticket.json)}`)
  console.error('[smoke] if the endpoint above is wrong, update getTicket() in src/lib/server/crewdesk.client.ts and this script to the exact call.')
  process.exit(1)
}
const data = ticket.json.data ?? ticket.json
const t = data.ticket ?? data
const title = t.title ?? t.subject ?? t.name
const status = t.status ?? t.status_name ?? t.current_status
console.log(`[smoke] ticket ${TICKET_ID}: "${title}" (status: ${status})`)

// ---- 3. post EXACTLY ONE test comment (form-data, current status) ----
const form = new FormData()
form.append('content', `${MARKER_PREFIX} TCMS real-API smoke test — module pages now link back from TCMS comments. Safe to ignore/delete.`)
form.append('type', 'comment')
form.append('user_id', String(me.id))
form.append('status', String(status))
// NOTE: no status_id — the comment must never change the ticket status.

const posted = await fetchJson(`/api/tickets/${TICKET_ID}/comments`, { method: 'POST', body: form })
if (posted.status !== 200 || !posted.json || posted.json.status === 'error') {
  console.error(`[smoke] comment post failed: HTTP ${posted.status} ${JSON.stringify(posted.json)}`)
  process.exit(1)
}
const d = posted.json.data ?? posted.json
const c = d.comment ?? d
const commentId = c?.id ?? c?.comment_id ?? c?.commentId ?? '(no id returned)'
console.log('[smoke] SUCCESS — 1 test comment posted.')
console.log(`[smoke] test comments posted this run: 1 (ticket ${TICKET_ID}, comment ${commentId}, [TCMS TEST] prefix)`)
