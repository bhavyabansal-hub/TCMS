// Walk every authenticated route in the browser, capture a full-page
// screenshot of each into download/preview-screens/, and report PASS/FAIL
// per route (client errors + "Application error" detection).
// Usage: node scripts/screenshot-all-pages.mjs
import { execSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'

const BASE = process.env.TCMS_BASE || 'http://localhost:3000'
// NOTE: reusing a session name after `close` makes the next command relaunch a
// blank browser (page state lost). Unique name per run avoids that entirely.
const SESSION = `shots-${Date.now().toString(36)}`
const OUT = 'download/preview-screens'

const routes = [
  ['login', '/login', false],
  ['dashboard', '/dashboard', true],
  ['modules', '/modules', true],
  ['test-cases', '/test-cases', true],
  ['reviews', '/reviews', true],
  ['bugs', '/bugs', true],
  ['tasks', '/tasks', true],
  ['reports', '/reports', true],
  ['wiki', '/wiki', true],
  ['activity-log', '/activity-log', true],
  ['notifications', '/notifications', true],
  ['integrations', '/integrations', true],
  ['settings-users', '/settings/users', true],
  ['settings-permissions', '/settings/permissions', true],
  ['settings-profile', '/settings/profile', true],
]

function ab(cmd) {
  return execSync(`agent-browser --session ${SESSION} ${cmd}`, { encoding: 'utf8', timeout: 90000 })
}

function abSafe(cmd) {
  try { return ab(cmd) } catch { return '' }
}

mkdirSync(OUT, { recursive: true })

// --- fresh session + login -------------------------------------------------
try {
  ab(`open ${BASE}/login`)
  ab('wait --load networkidle')
  ab('wait 800')
  const refs = ab('snapshot -i -c')
  const emailRef = (refs.match(/textbox "Email" \[[^\]]*ref=(\w+)/) || [])[1]
  const passRef = (refs.match(/textbox "Password" \[[^\]]*ref=(\w+)/) || [])[1]
  const btnRef = (refs.match(/button "Sign in" \[[^\]]*ref=(\w+)/) || [])[1]
  if (!emailRef || !passRef || !btnRef) {
    throw new Error('login form refs not found. snapshot head:\n' + refs.slice(0, 400))
  }
  ab(`fill @${emailRef} admin@tcms.com`)
  ab(`fill @${passRef} Admin@123`)
  ab(`click @${btnRef}`)
  ab('wait --url "/dashboard" --timeout 20000')
  console.log('LOGIN OK')
} catch (e) {
  console.log('LOGIN FAILED:', String(e).slice(0, 400))
  process.exit(1)
}

// --- walk + shoot ------------------------------------------------------------
const results = []
for (const [name, route, authed] of routes) {
  if (!authed) continue
  try {
    ab('errors --clear')
    ab(`open ${BASE}${route}`)
    ab('wait --load networkidle')
    ab('wait 1500')
    const errs = ab('errors').trim()
    const url = ab('get url').trim()
    const text = ab('eval "document.body.innerText.slice(0,200)"').trim().replace(/\n/g, ' ')
    const errLines = errs.split('\n').filter((l) => l && !l.includes('favicon'))
    const ok = url.includes(route) && errLines.length === 0 && !text.includes('Application error')
    const file = `${OUT}/${name}.png`
    ab(`screenshot ${file} --full`)
    results.push({ route, ok, errCount: errLines.length, file, text: text.slice(0, 60) })
    console.log(`${ok ? 'PASS' : 'FAIL'} ${route} (errors: ${errLines.length}) -> ${file}`)
  } catch (e) {
    results.push({ route, ok: false, errCount: -1, text: String(e).slice(0, 100) })
    console.log(`FAIL ${route}: ${String(e).slice(0, 120)}`)
  }
}

writeFileSync('/tmp/shot-results.json', JSON.stringify(results, null, 2))

// --- login screen shot (separate session so it never disturbs the walk) ----
try {
  const L = `login-${Date.now().toString(36)}`
  execSync(`agent-browser --session ${L} open ${BASE}/login`, { encoding: 'utf8', timeout: 90000 })
  execSync(`agent-browser --session ${L} wait --load networkidle`, { encoding: 'utf8', timeout: 90000 })
  execSync(`agent-browser --session ${L} wait 800`, { encoding: 'utf8', timeout: 90000 })
  execSync(`agent-browser --session ${L} screenshot ${OUT}/00-login.png --full`, { encoding: 'utf8', timeout: 90000 })
  execSync(`agent-browser --session ${L} close`, { encoding: 'utf8', timeout: 30000 })
  console.log('login screenshot saved')
} catch (e) {
  console.log('login screenshot failed:', String(e).slice(0, 120))
}

const pass = results.filter((r) => r.ok).length
console.log(`\nWALK RESULT: ${pass}/${results.filter((r) => true).length - 0} routes OK (${results.length - 1} authed pages + login shot)`)
process.exit(pass === results.length - 1 ? 0 : 1)
