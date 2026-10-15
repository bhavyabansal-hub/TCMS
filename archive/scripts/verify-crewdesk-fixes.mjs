// Post-fix verification for owner-reported problems (2026-10-09):
//   P1: "Invalid status" on link attempts  -> slug fix (verify: retry the failed row)
//   P2: copy before link                    -> ?path=preview-comment (no row, no Crew Desk call)
// Run: node scripts/verify-crewdesk-fixes.mjs
import { readFileSync } from 'node:fs'

const BASE = 'http://localhost:3000'
const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
const TOKEN = env.match(/^CREWDESK_TOKEN=(.+)$/m)?.[1].trim()
const EXP = Number(JSON.parse(Buffer.from(TOKEN.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()).exp) * 1000
if (Date.now() > EXP) { console.error('FATAL: dev token expired — ask for a fresh one'); process.exit(1) }

let failed = 0
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok' : 'FAIL'}  ${msg}`); if (!cond) failed++ }

// login as tejas (vp, manage_integrations) — same shape a browser sends
const loginRes = await fetch(`${BASE}/api/auth?path=login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms', Origin: BASE },
  body: JSON.stringify({ email: 'tejas.singh@shipglobal.in', password: 'Tejas@12345' }),
})
ok(loginRes.ok, `login tejas -> ${loginRes.status}`)
const access = (loginRes.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('tcms-access='))
const cookie = access ? access.split(';')[0] : ''
const H = { Cookie: cookie, 'X-Requested-With': 'tcms', Origin: BASE, 'Content-Type': 'application/json' }

// --- P2: preview-comment builds text WITHOUT creating a row ---
const modsRes = await fetch(`${BASE}/api/modules`, { headers: H })
const modsJson = await modsRes.json()
const mods = modsJson?.flat ?? modsJson?.data?.flat ?? []
const mod = mods[0]
if (!mod) { console.error('FATAL: no modules found'); process.exit(1) }
const beforeRes = await fetch(`${BASE}/api/integrations/crewdesk?pageSize=200`, { headers: H })
const beforeTotal = ((await beforeRes.json()).data ?? []).length
const prevRes = await fetch(
  `${BASE}/api/integrations/crewdesk?path=preview-comment&moduleId=${encodeURIComponent(mod.moduleId)}&note=${encodeURIComponent('preview check')}`,
  { headers: H }
)
const prev = await prevRes.json()
ok(prevRes.status === 200, `preview-comment -> ${prevRes.status}`)
ok(prev?.comment?.includes(mod.name) && prev?.comment?.includes('Linked by') && prev?.comment?.includes('preview check'), 'preview text carries module name + Linked by + note')
ok(prev?.moduleUrl?.includes(mod.moduleId), 'preview moduleUrl points at the module page')
const afterRes = await fetch(`${BASE}/api/integrations/crewdesk?pageSize=200`, { headers: H })
const afterTotal = ((await afterRes.json()).data ?? []).length
ok(beforeTotal === afterTotal, `preview-comment created NO history row (${beforeTotal} -> ${afterTotal})`)

// --- P1: retry the owner's failed row (the "Invalid status" one) ---
const linksRes = await fetch(`${BASE}/api/integrations/crewdesk?pageSize=200`, { headers: H })
const links = (await linksRes.json()).data ?? []
const failedRows = links.filter((l) => l.status === 'failed')
if (failedRows.length === 0) {
  console.log('  ..   no failed row present (already retried?) — skipping retry check')
}
for (const failedRow of failedRows) {
  ok(true, `found failed row: ${failedRow.moduleName} -> ${failedRow.ticketId} ("${failedRow.lastError ?? 'no error text'}")`)
  const retryRes = await fetch(`${BASE}/api/integrations/crewdesk?path=retry&linkId=${encodeURIComponent(failedRow.linkId)}`, {
    method: 'POST', headers: H, body: JSON.stringify({}),
  })
  const retried = await retryRes.json()
  ok(retryRes.status === 200 && retried?.status === 'posted', `retry -> ${retryRes.status}, status=${retried?.status}`)
  ok(Boolean(retried?.crewdeskCommentId), `real comment id from retry: ${retried?.crewdeskCommentId ?? 'NONE'}`)
  // read back from the real backend
  const rdRes = await fetch(`https://dev.eng4.back.shipgl.in/api/tickets/${retried.ticketId}/comments`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  const rdJson = await rdRes.json()
  const list = rdJson?.data?.comments?.data ?? rdJson?.data?.comments ?? rdJson?.data ?? []
  const visible = Array.isArray(list) && list.some((c) => String(c.id) === String(retried.crewdeskCommentId))
  ok(visible, 'read-back: retried comment visible on the real ticket')
}

console.log(failed === 0 ? '\nRESULT: ALL FIX CHECKS PASSED' : `\nRESULT: ${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
