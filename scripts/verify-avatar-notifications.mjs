// Regression probe for Task 4 fixes: avatar URL end-to-end + notification
// context/delivery readiness. Local stack only (no real SMTP/Telegram).
const BASE = process.env.TCMS_BASE || 'http://localhost:3000'
const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'tcms', Origin: BASE }

const accounts = {
  admin: { email: 'admin@tcms.com', password: 'Admin@123' },  // VP — holds view_all_task_reports
  lead: { email: 'teamlead@tcms.com', password: 'Lead@123' }, // Manager — holds view_all_task_reports
  qa: { email: 'qa1@tcms.com', password: 'QA@12345' },        // qa_engineer — submits work log
}

async function login({ email, password }) {
  const res = await fetch(`${BASE}/api/auth?path=login`, {
    method: 'POST', headers: HEADERS, body: JSON.stringify({ email, password }),
  })
  if (!res.ok) throw new Error(`login ${email} -> ${res.status}`)
  const jar = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
  return { jar, me: (await res.json())?.user }
}

async function req(method, path, jar, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { ...HEADERS, Cookie: jar } : { ...HEADERS, Cookie: jar },
    body: body ? JSON.stringify(body) : undefined,
  })
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, body: json }
}

const results = []
const check = (name, ok, detail) => {
  results.push({ ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  —  ${detail}`)
}

const AVATAR = 'https://i.pravatar.cc/150?u=tcms-verify'

// ---- 1. Avatar URL round-trip (profile update persists + session reflects) ----
const admin = await login(accounts.admin)
const put = await req('PUT', '/api/auth', admin.jar, { avatarUrl: AVATAR })
check('profile avatarUrl PUT accepted', put.status === 200, `status=${put.status} avatarUrl=${put.body?.avatarUrl}`)
const sess = await req('GET', '/api/auth?path=session', admin.jar)
check('session reflects new avatarUrl', sess.status === 200 && sess.body?.user?.avatarUrl === AVATAR,
  `session.avatarUrl=${sess.body?.user?.avatarUrl}`)

// ---- 2. User refs in payloads now carry avatarUrl ----
const tcs = await req('GET', '/api/test-cases?pageSize=20', admin.jar)
const anyCase = (tcs.body?.data ?? []).find((t) => t.author && 'avatarUrl' in t.author)
check('test-case author ref exposes avatarUrl', !!anyCase,
  anyCase ? `case "${anyCase.title}" author="${anyCase.author?.fullName}" avatarUrl=${anyCase.author?.avatarUrl}` : 'no serialized author in page 1')
const bugs = await req('GET', '/api/bugs?pageSize=1', admin.jar)
const firstBug = bugs.body?.data?.[0]
check('bug reportedBy ref exposes avatarUrl key', !!firstBug && 'avatarUrl' in (firstBug.reportedBy ?? {}),
  firstBug ? `bug "${firstBug.title}" reportedBy.avatarUrl=${firstBug.reportedBy?.avatarUrl}` : 'no bugs in db')

// ---- 3. Daily work-log submission notifies view_all_task_reports holders ----
const qa = await login(accounts.qa)
const today = new Date().toISOString().slice(0, 10)
const upsert = await req('POST', '/api/task-reports', qa.jar, {
  reportDate: today,
  tasks: [{ description: '[verify] notification context test task', timeSpentMinutes: 95, status: 'done' }],
})
check('qa daily work-log upsert accepted', upsert.status === 200, `status=${upsert.status} total=${upsert.body?.totalMinutes}m`)

const lead = await login(accounts.lead)
const notifs = await req('GET', '/api/notifications', lead.jar)
const dn = (notifs.body?.data ?? notifs.body ?? []).find?.((n) => n.type === 'daily_report_submitted')
check('manager received daily_report_submitted', !!dn,
  dn ? `title="${dn.title}" body="${dn.body}"` : 'no daily_report_submitted for manager')
check('notification body names actor + context', !!dn && dn.body?.includes('Quinn Tester') && dn.body?.includes('1h 35m') && dn.body?.includes(today),
  dn?.body ?? 'n/a')

// qa (non-holder) must NOT receive it
const qaNotifs = await req('GET', '/api/notifications', qa.jar)
const qaGot = (qaNotifs.body?.data ?? qaNotifs.body ?? []).some?.((n) => n.type === 'daily_report_submitted')
check('non-holder did NOT receive report notification', !qaGot, `qa has it: ${qaGot}`)

// ---- cleanup: reset admin avatar + remove the verify report ----
await req('PUT', '/api/auth', admin.jar, { avatarUrl: null })
const del = await req('DELETE', `/api/task-reports?id=${upsert.body?.taskReportId ?? ''}`, qa.jar)
check('cleanup: verify report removed', [200, 204, 404, 405].includes(del.status), `DELETE status=${del.status} (405 = no delete endpoint, row left)`)

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
