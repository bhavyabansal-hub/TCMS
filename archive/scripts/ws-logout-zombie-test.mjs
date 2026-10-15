// CONDITION-2 PROOF (owner task 2026-10-14): after LOGOUT in the browser, NO
// socket may remain: the WS service log must show the socket's disconnect and
// ZERO further connect/authenticated lines for 60s (no zombie reconnect).
//
// Flow:
//   1. fresh agent-browser session -> preview URL -> login admin -> dashboard
//   2. identify THIS page's socket id (last "[WS] user <adminId> authenticated
//      on socket <ID>" line written after login)
//   3. click user menu -> "Sign out" -> wait for /login
//   4. wait until "[WS] socket disconnected: <ID>" appears (the disconnect)
//   5. freeze log position, wait 60s, then assert the 60s delta contains
//      ZERO "[WS] socket connected:" and ZERO "authenticated" lines.
// Raw server-log evidence goes to stdout.
import { execSync, spawn } from 'child_process'
import { readFileSync, openSync } from 'fs'

const BASE = 'https://preview-chat-c07ec613-ee53-4223-b848-dc9b3387e259.space-z.ai'
const SESSION = `wsout-${Date.now().toString(36)}`
const ADMIN_ID = '17f622bf-4bd8-43e7-8085-49037c67937d'
const WATCH_MS = 60000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function ab(cmd) {
  return execSync(`agent-browser --session ${SESSION} ${cmd}`, { encoding: 'utf8', timeout: 90000 })
}
function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', shell: '/bin/bash', timeout: 30000 })
}

// ---------- login ----------
ab(`open ${BASE}/login`)
ab('wait --load networkidle')
ab('wait 800')
const refs = ab('snapshot -i -c')
const emailRef = (refs.match(/textbox "Email" \[[^\]]*ref=(\w+)/) || [])[1]
const passRef = (refs.match(/textbox "Password" \[[^\]]*ref=(\w+)/) || [])[1]
const btnRef = (refs.match(/button "Sign in" \[[^\]]*ref=(\w+)/) || [])[1]
if (!emailRef || !passRef || !btnRef) { console.log('LOGIN REFS NOT FOUND'); process.exit(1) }
ab(`fill @${emailRef} admin@tcms.com`)
ab(`fill @${passRef} Admin@123`)
ab(`click @${btnRef}`)
ab('wait --url "/dashboard" --timeout 25000')
ab('wait --load networkidle')
ab('wait 2000') // allow socket connect + auth to land in the server log
console.log('LOGIN OK')

// ---------- identify THIS page's socket ----------
const adminName = JSON.parse(
  execSync(`curl -s -X POST ${BASE}/api/auth?path=login -H 'Content-Type: application/json' -H 'X-Requested-With: tcms' -d '{"email":"admin@tcms.com","password":"Admin@123"}'`, { encoding: 'utf8' })
).user.fullName
const authLine = readFileSync('/tmp/tcms-ws.log', 'utf8')
  .split('\n')
  .filter((l) => l.includes(`user ${ADMIN_ID} authenticated on socket`))
  .pop()
const sid = authLine ? (authLine.match(/on socket (\S+)/) || [])[1] : null
console.log('admin fullName:', adminName)
console.log('socket id of THIS page:', sid, '(from:', (authLine || 'NONE').trim(), ')')
if (!sid) { console.log('FATAL: no auth line found — socket never connected'); process.exit(1) }

// ---------- logout via the UI ----------
const snap1 = ab('snapshot -i -c')
const userBtnRef = (snap1.match(new RegExp(`button "[^"]*${adminName.split(' ')[0]}[^"]*" \\[[^\\]]*ref=(\\w+)`)) || [])[1]
if (!userBtnRef) { console.log('user menu trigger not found. snapshot head:\n' + snap1.slice(0, 500)); process.exit(1) }
ab(`click @${userBtnRef}`)
ab('wait 600')
const snap2 = ab('snapshot -i -c')
const signOutRef = (snap2.match(/(?:menuitem|button) "Sign out" \[[^\]]*ref=(\w+)/) || [])[1]
if (!signOutRef) { console.log('Sign out item not found. snapshot head:\n' + snap2.slice(0, 600)); process.exit(1) }
ab(`click @${signOutRef}`)
ab('wait --url "/login" --timeout 20000')
console.log('LOGGED OUT (url =', ab('get url').trim() + ')')

// ---------- wait for the disconnect of THIS socket ----------
let disconnectLine = null
for (let i = 0; i < 15; i++) {
  const lines = readFileSync('/tmp/tcms-ws.log', 'utf8').split('\n')
  const hit = lines.find((l) => l.includes(`socket disconnected: ${sid}`))
  if (hit) { disconnectLine = hit.trim(); break }
  await sleep(1000)
}
console.log('disconnect line for the logged-out socket:', disconnectLine || 'NOT SEEN within 15s')

// ---------- 60s zombie watch ----------
const frozen = readFileSync('/tmp/tcms-ws.log', 'utf8').split('\n').length
console.log(`watching ${WATCH_MS / 1000}s for any reconnect from the logged-out page...`)
await sleep(WATCH_MS)
const delta = readFileSync('/tmp/tcms-ws.log', 'utf8').split('\n').slice(frozen - 1)
const newConnects = delta.filter((l) => l.includes('[WS] socket connected:'))
const newAuths = delta.filter((l) => l.includes('authenticated on socket'))
console.log('--- WS server log delta during the 60s watch (raw) ---')
const printed = delta.filter((l) => l.trim()).slice(0, 20)
console.log(printed.length ? printed.join('\n') : '(no WS service log lines at all during the watch)')
console.log('--- end delta ---')
const pass = !!disconnectLine && newConnects.length === 0 && newAuths.length === 0
console.log(`LOGOUT-ZOMBIE VERDICT: ${pass ? 'PASS — disconnect logged, ZERO reconnects in 60s' : 'FAIL'}`)
process.exit(pass ? 0 : 1)
