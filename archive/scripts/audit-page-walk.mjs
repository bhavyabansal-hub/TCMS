// Task 15 audit: walk every authenticated route in the browser, capture
// client-side errors per page. Uses agent-browser CLI; the 'verify' session
// is already signed in. Reports PASS/FAIL per route.
import { execSync } from 'child_process'

const BASE = 'http://localhost:3000'
const SESSION = 'audit'
const routes = [
  '/dashboard', '/modules', '/test-cases', '/reviews', '/bugs', '/tasks',
  '/reports', '/activity-log', '/notifications', '/settings/users',
  '/settings/permissions', '/settings/profile',
]

function ab(cmd) {
  return execSync(`agent-browser --session ${SESSION} ${cmd}`, { encoding: 'utf8', timeout: 60000 })
}

// fresh session + login
try {
  ab(`open ${BASE}/login`)
  ab('wait --load networkidle')
  const refs = ab('snapshot -i -c')
  const emailRef = (refs.match(/textbox "Email" \[[^\]]*ref=(\w+)/) || [])[1]
  const passRef = (refs.match(/textbox "Password" \[[^\]]*ref=(\w+)/) || [])[1]
  const btnRef = (refs.match(/button "Sign in" \[[^\]]*ref=(\w+)/) || [])[1]
  ab(`fill @${emailRef} admin@tcms.com`)
  ab(`fill @${passRef} Admin@123`)
  ab(`click @${btnRef}`)
  ab('wait --url "/dashboard" --timeout 15000')
} catch (e) {
  console.log('LOGIN FAILED:', String(e).slice(0, 300))
  process.exit(1)
}

const results = []
for (const r of routes) {
  try {
    ab(`errors --clear`)
    ab(`open ${BASE}${r}`)
    ab('wait --load networkidle')
    ab('wait 1200')
    const errs = ab('errors').trim()
    const url = ab('get url').trim()
    const text = ab('eval "document.body.innerText.slice(0,60)"').trim().replace(/\n/g, ' ')
    const errLines = errs.split('\n').filter((l) => l && !l.includes('favicon'))
    const ok = url.includes(r) && errLines.length === 0 && !text.includes('Application error')
    results.push({ route: r, ok, url, errCount: errLines.length, text: text.slice(0, 45) })
  } catch (e) {
    results.push({ route: r, ok: false, errCount: -1, text: String(e).slice(0, 80) })
  }
}

console.log('\n===== PAGE WALK RESULTS =====')
let pass = 0
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.route}  (errors: ${r.errCount})  "${r.text}"`)
  if (r.ok) pass++
}
console.log(`===== ${pass}/${results.length} routes clean =====`)
