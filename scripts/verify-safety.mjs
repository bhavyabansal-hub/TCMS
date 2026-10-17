#!/usr/bin/env node
/**
 * Safety checks (backlog B5/B6):
 *   1. Security headers on a page and an API response (CSP incl. frame-ancestors 'none',
 *      nosniff, X-Frame-Options, Referrer-Policy; HSTS reported).
 *   2. GET /api/ready -> 200 { status: 'ready', database: 'ok' }.
 *   3. Read-only rules (src/lib/server/read-only.ts) + optional LIVE check against an
 *      instance started with TCMS_READ_ONLY=true: set READ_ONLY_BASE_URL=http://host:port.
 *   4. CSV export cells (src/lib/csv-export.ts): quoting + formula-injection guard.
 *   5. Per-IP login limit, live, from a fake TEST-NET client IP (X-Forwarded-For) with
 *      random unknown emails, so no real account and no real localhost login is blocked.
 * Usage: node scripts/verify-safety.mjs   (app on http://localhost:3000)
 */
import { randomInt } from 'node:crypto'
import { cleanupRunEntities } from './lib/suite-cleanup.mjs'

process.removeAllListeners('warning') // silence Node's "typeless package.json" notice for the .ts imports
const { isBlockedInReadOnly } = await import('../src/lib/server/read-only.ts')
const { csvCell, toCsv } = await import('../src/lib/csv-export.ts')

const BASE = process.env.TCMS_BASE_URL || 'http://localhost:3000'
const READ_ONLY_BASE = process.env.READ_ONLY_BASE_URL || ''
const MAX_FAILURES = Number(process.env.TCMS_LOGIN_IP_MAX_FAILURES) || 30
let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`) }
}

async function checkHeaders() {
  for (const path of ['/login', '/api']) {
    const res = await fetch(`${BASE}${path}`)
    const h = (k) => res.headers.get(k) ?? ''
    check(`headers ${path}: CSP with frame-ancestors 'none' and object-src 'none'`, h('content-security-policy').includes("frame-ancestors 'none'") && h('content-security-policy').includes("object-src 'none'"), h('content-security-policy'))
    check(`headers ${path}: X-Content-Type-Options nosniff`, h('x-content-type-options') === 'nosniff')
    check(`headers ${path}: X-Frame-Options DENY`, h('x-frame-options') === 'DENY')
    check(`headers ${path}: Referrer-Policy strict-origin-when-cross-origin`, h('referrer-policy') === 'strict-origin-when-cross-origin')
    console.log(`      info ${path}: Strict-Transport-Security=${h('strict-transport-security') || '(none)'} (browsers apply it over HTTPS only)`)
  }
}

async function checkReady() {
  const res = await fetch(`${BASE}/api/ready`)
  const body = await res.json().catch(() => null)
  check('GET /api/ready -> 200 ready, database ok', res.status === 200 && body?.status === 'ready' && body?.database === 'ok', `${res.status} ${JSON.stringify(body)}`)
  check('GET /api/ready is no-store', (res.headers.get('cache-control') ?? '').includes('no-store'))
}

async function checkReadOnly() {
  const q = (s) => new URLSearchParams(s)
  check('read-only rule: GET allowed', !isBlockedInReadOnly('GET', '/api/bugs', q('')))
  check('read-only rule: POST bug blocked', isBlockedInReadOnly('POST', '/api/bugs', q('')))
  check('read-only rule: PUT/DELETE blocked', isBlockedInReadOnly('PUT', '/api/test-cases', q('id=x')) && isBlockedInReadOnly('DELETE', '/api/modules', q('id=x')))
  check('read-only rule: login/refresh/logout allowed', ['login', 'refresh', 'logout'].every((p) => !isBlockedInReadOnly('POST', '/api/auth', q(`path=${p}`))))
  check('read-only rule: register + password change blocked', isBlockedInReadOnly('POST', '/api/auth', q('path=register')) && isBlockedInReadOnly('PUT', '/api/auth', q('path=password')))
  if (!READ_ONLY_BASE) {
    console.log('      info read-only LIVE check skipped (set READ_ONLY_BASE_URL to an instance with TCMS_READ_ONLY=true)')
    return
  }
  const write = await fetch(`${READ_ONLY_BASE}/api/bugs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms' }, body: '{}' })
  const body = await write.json().catch(() => null)
  check('read-only LIVE: POST /api/bugs -> 503 maintenance message', write.status === 503 && /read-only/.test(body?.error ?? ''), `${write.status} ${JSON.stringify(body)}`)
  const ready = await fetch(`${READ_ONLY_BASE}/api/ready`).then((r) => r.json()).catch(() => null)
  check('read-only LIVE: /api/ready reports readOnly=true', ready?.readOnly === true, JSON.stringify(ready))
  const login = await fetch(`${READ_ONLY_BASE}/api/auth?path=login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms' }, body: JSON.stringify({ email: 'nobody@tcms-test.com', password: 'x' }) })
  check('read-only LIVE: login still reachable (401 for bad credentials, not 503)', login.status === 401, `${login.status}`)
}

function checkCsv() {
  check('csv: plain value quoted', csvCell('abc') === '"abc"')
  check('csv: quotes doubled', csvCell('a"b') === '"a""b"')
  check('csv: = + - @ neutralized', ['=1+1', '+SUM(A1)', '-2+3', '@cmd'].every((v) => csvCell(v) === `"'${v}"`))
  check('csv: leading blank before = neutralized', csvCell('  =HYPERLINK("x")') === `"'  =HYPERLINK(""x"")"`)
  check('csv: TAB / CR start neutralized', csvCell('\t=1').startsWith(`"'`) && csvCell('\r=1').startsWith(`"'`))
  check('csv: null -> empty cell', csvCell(null) === '""')
  check('csv: commas + newlines stay in one cell', toCsv([['a,b', 'c\nd']]) === '"a,b","c\nd"')
}

async function attemptLogin(ip, email, password) {
  const res = await fetch(`${BASE}/api/auth?path=login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms', 'X-Forwarded-For': ip },
    body: JSON.stringify({ email, password }),
  })
  return res.status
}

async function checkLoginIpLimit() {
  const ip = `203.0.113.${randomInt(1, 255)}` // RFC 5737 TEST-NET-3, never a real client
  const emails = Array.from({ length: MAX_FAILURES }, (_, i) => `ip-limit-${Date.now()}-${i}@tcms-test.com`)
  try {
    const statuses = []
    for (const email of emails) statuses.push(await attemptLogin(ip, email, 'wrong-password'))
    check(`ip limit: first ${MAX_FAILURES} failures from one IP -> 401 each`, statuses.every((s) => s === 401), statuses.join(','))
    const blocked = await attemptLogin(ip, 'admin@tcms.com', 'Admin@123')
    check('ip limit: next sign-in from that IP -> 429, even with valid credentials', blocked === 429, `${blocked}`)
    const otherEmail = `ip-limit-other-${Date.now()}@tcms-test.com`
    emails.push(otherEmail)
    const other = await attemptLogin(`198.51.100.${randomInt(1, 255)}`, otherEmail, 'wrong')
    check('ip limit: another IP is not affected (401)', other === 401, `${other}`)
  } finally {
    await cleanupRunEntities(check, {}, { userIds: [], emails })
  }
}

async function main() {
  await checkHeaders()
  await checkReady()
  await checkReadOnly()
  checkCsv()
  await checkLoginIpLimit()
  console.log(`\nSAFETY RESULT: ${pass} passed, ${fail} failed`)
  return fail ? 1 : 0
}

main().then((code) => { process.exitCode = code }, (err) => { console.error(`ERROR: ${err.message}`); process.exitCode = 1 })
