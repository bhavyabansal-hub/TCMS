// STEP 0 browser-level proof — does the REAL client recover after a 90s WS
// outage, with NO page reload, on the current code?
// Protocol:
//   1. Fresh agent-browser session -> preview URL -> login admin -> /dashboard
//   2. Set window.__step0NoReload = 42 (no-reload marker)
//   3. PRE:  /notify (WS-only, NOT persisted) -> bell badge must increment
//            (proves live WS through the gateway before the outage)
//   4. kill -9 the WS service -> 90s outage -> restart via start-tcms.sh recipe
//   5. POST: /notify again -> poll the WS service log for the re-auth line
//      ("user <adminId> authenticated") written by the RESTARTED process
//   6. Assert WITHOUT reload: marker still 42, badge incremented again, bell
//      dropdown contains the post-outage item. Screenshots before/after.
// Raw evidence goes to stdout. Never prints WS_NOTIFY_SECRET.
// Usage: node scripts/ws-reconnect-browser-step0.mjs   (env OUTAGE_MS, default 91000)
import { execSync, spawn } from 'child_process'
import { readFileSync, openSync } from 'fs'

const OUTAGE_MS = Number(process.env.OUTAGE_MS || 91000)

const BASE = 'https://preview-chat-c07ec613-ee53-4223-b848-dc9b3387e259.space-z.ai'
const SESSION = `wsrec-${Date.now().toString(36)}`
const OUT = 'download/preview-screens'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function ab(cmd) {
  return execSync(`agent-browser --session ${SESSION} ${cmd}`, { encoding: 'utf8', timeout: 90000 })
}
function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', shell: '/bin/bash', timeout: 30000 })
}
// Start the WS service EXACTLY like start-tcms.sh does (cwd + `bun index.ts`
// cmdline -> passes the zombie-guard identity check), fully detached so the
// orchestrator's stdio pipes are never inherited (execSync on a backgrounded
// nohup never sees EOF and hangs — seen twice in step-0 debugging).
function startWsService() {
  const out = openSync('/tmp/tcms-ws.log', 'a')
  const child = spawn('bun', ['index.ts'], {
    cwd: '/home/z/my-project/mini-services/notifications',
    detached: true,
    stdio: ['ignore', out, out],
  })
  child.unref()
}

// secret for /notify (never printed)
const secret =
  (readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').find((l) => l.startsWith('WS_NOTIFY_SECRET=')) || '')
    .slice('WS_NOTIFY_SECRET='.length).trim()
if (!secret) { console.error('FATAL: WS_NOTIFY_SECRET not resolvable'); process.exit(2) }

const ADMIN_ID = '17f622bf-4bd8-43e7-8085-49037c67937d'
async function notify(title) {
  const r = await fetch('http://127.0.0.1:3004/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-notify-secret': secret },
    body: JSON.stringify({ userId: ADMIN_ID, title, body: 'ws-reconnect-browser-step0', type: 'system' }),
  })
  console.log(`POST /notify "${title}" -> ${r.status}`)
  return r.status
}
const wsLines = () => readFileSync('/tmp/tcms-ws.log', 'utf8').split('\n').length
const badge = () => ab(`eval "(() => { const b = document.querySelector('button[aria-label=\\"Notifications\\"]'); return b ? (b.textContent.trim() || '0') : 'NO-BELL' })()"`).trim().replace(/"/g, '')
const markerVal = () => ab('eval "String(window.__step0NoReload)"').trim().replace(/"/g, '')

// ---------- 1. login ----------
console.log('=== 1. login on preview URL ===')
ab(`open ${BASE}/login`)
ab('wait --load networkidle')
ab('wait 800')
const refs = ab('snapshot -i -c')
const emailRef = (refs.match(/textbox "Email" \[[^\]]*ref=(\w+)/) || [])[1]
const passRef = (refs.match(/textbox "Password" \[[^\]]*ref=(\w+)/) || [])[1]
const btnRef = (refs.match(/button "Sign in" \[[^\]]*ref=(\w+)/) || [])[1]
if (!emailRef || !passRef || !btnRef) { console.log('LOGIN REFS NOT FOUND:', refs.slice(0, 300)); process.exit(1) }
ab(`fill @${emailRef} admin@tcms.com`)
ab(`fill @${passRef} Admin@123`)
ab(`click @${btnRef}`)
ab('wait --url "/dashboard" --timeout 25000')
ab('wait --load networkidle')
ab('wait 1000')
console.log('LOGIN OK, url =', ab('get url').trim())

// ---------- 2. no-reload marker ----------
ab('eval "window.__step0NoReload = 42; String(window.__step0NoReload)"')
console.log('no-reload marker set:', markerVal())

// ---------- 3. PRE: live delivery before the outage ----------
console.log('=== 2. PRE-outage live check ===')
const badgePre0 = badge()
console.log('badge before pre-notify:', badgePre0)
const linesPre = wsLines()
const st0 = await notify('diag PRE-outage live check')
await sleep(4000)
const badgePre1 = badge()
console.log(`badge after pre-notify: ${badgePre1} (was ${badgePre0})`)
ab(`screenshot ${OUT}/ws-reconnect-step0-before.png --full`)
const preLive = st0 === 200 && badgePre1 !== badgePre0
console.log('PRE verdict: live WS delivery through gateway =', preLive ? 'YES' : 'NO (aborting — outage test would be meaningless)')
if (!preLive) process.exit(1)
// Set the no-reload marker NOW — from here until the final assert there must
// be ZERO navigation (clicks/evals only). Marker lost = something reloaded.
ab('eval "window.__step0NoReload = 42; String(window.__step0NoReload)"')
console.log('no-reload marker set before outage:', markerVal())

// ---------- 4. outage ----------
console.log('=== 3. outage: kill WS service for ' + Math.round(OUTAGE_MS / 1000) + 's ===')
const linesBeforeRestart = wsLines()
const pid = sh(`ss -tlnp 2>/dev/null | grep ':3003 ' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2`).trim()
console.log(`WS pid=${pid} — kill -9 at ${new Date().toISOString()}`)
sh(`kill -9 ${pid}`)
await sleep(1000)
const down = sh(`ss -tln | grep ':3003 ' || true`).trim() === ''
console.log(':3003 confirmed DOWN =', down)
if (!down) process.exit(1)
await sleep(OUTAGE_MS)
console.log(`restarting WS service at ${new Date().toISOString()} (outage was ~${Math.round((OUTAGE_MS + 1000) / 1000)}s)`)
startWsService()
let up = false
for (let i = 0; i < 30; i++) { if (sh(`ss -tln | grep ':3003 ' || true`).trim() !== '') { up = true; break } await sleep(500) }
console.log(':3003 LISTENING again =', up, 'at', new Date().toISOString())
if (!up) process.exit(1)

// ---------- 5. POST: recovery without reload ----------
console.log('=== 4. POST-outage recovery check (no reload) ===')
const tUp = Date.now()
console.log('polling WS log for re-auth line of the RESTARTED service (client auto-reconnect, up to 120s)...')
let reauthLine = null
let reauthAfterMs = null
// 120s: the SANDBOX platform gateway can hold its :3003 upstream unhealthy
// after rapid kill/restart cycles (observed: a 10s outage right after another
// outage test delayed transport-open by ~67s — mint at 18:17:24 after a
// 18:16:17 restart — while node-direct recovered in ~2.5s). The manager loop
// is the only recovery driver and keeps retrying throughout; the window just
// has to be patient with the gateway.
for (let i = 0; i < 120; i++) {
  const newLines = readFileSync('/tmp/tcms-ws.log', 'utf8').split('\n').slice(linesBeforeRestart - 1)
  const hit = newLines.find((l) => l.includes(`user ${ADMIN_ID} authenticated`))
  if (hit) { reauthLine = hit.trim(); reauthAfterMs = Date.now() - tUp; break }
  await sleep(1000)
}
console.log('WS re-auth line (restarted process):', reauthLine || 'NOT SEEN within 120s', reauthLine ? `(recovery latency ~${reauthAfterMs}ms from service LISTENING to room re-join)` : '')
if (!reauthLine) process.exit(1)
// Socket has re-joined the room — only NOW fire the live push.
const badgePost0 = badge()
const st1 = await notify('diag POST-outage recovery check')
console.log(`POST /notify -> ${st1}; badge before push: ${badgePost0}`)
await sleep(3000)
const marker = markerVal()
const badgePost = badge()
console.log(`no-reload marker after recovery: ${marker} (expected 42)`)
console.log(`badge after post-outage notify: ${badgePost} (was ${badgePost0})`)
const snap = ab('snapshot -i -c')
const bellRef = (snap.match(/button "Notifications" \[[^\]]*ref=(\w+)/) || [])[1]
let dropdownHit = false
if (bellRef) {
  ab(`click @${bellRef}`)
  ab('wait 700')
  const txt = ab('eval "document.body.innerText"').trim()
  dropdownHit = txt.includes('diag POST-outage recovery check')
  console.log('bell dropdown contains post-outage item =', dropdownHit)
} else {
  console.log('bell button ref not found in snapshot (checking innerText anyway)')
  dropdownHit = ab('eval "document.body.innerText"').trim().includes('diag POST-outage recovery check')
}
ab(`screenshot ${OUT}/ws-reconnect-step0-after.png --full`)
const consoleErrs = ab('errors').trim()
console.log('browser console errors:', consoleErrs ? consoleErrs.split('\n').filter((l) => !l.includes('favicon')).slice(0, 5).join(' | ') : 'none')
const pass = marker === '42' && st1 === 200 && !!reauthLine && dropdownHit && badgePost !== badgePost0
console.log(`STEP0-BROWSER VERDICT: ${pass ? 'PASS — socket re-authenticated WITHOUT reload and live /notify reached the bell' : 'FAIL'}`)
process.exit(pass ? 0 : 1)
