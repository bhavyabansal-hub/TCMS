// Notification & auth-security verifier — exercises the flows the delivery
// feature touches. Creates a dedicated temp user so demo accounts stay
// pristine; soft-deletes it at the end (domain check), then removes the temp
// user, its bug and their notifications by id (B16). Run with the server up:
//   TCMS_BASE_URL=http://localhost:3000 node scripts/verify-notifications.mjs
import { cleanupRunEntities } from './lib/suite-cleanup.mjs'

const BASE = process.env.TCMS_BASE_URL || 'http://localhost:3000'

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

async function req(method, path, { token, body, raw } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  // CSRF contract: every mutating call must carry the first-party marker.
  if (method !== 'GET' && method !== 'HEAD') headers['X-Requested-With'] = 'tcms'
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* non-JSON */
  }
  // Cookie-session contract: tokens arrive as httpOnly Set-Cookie headers.
  const setCookies = res.headers.getSetCookie?.() ?? []
  return { status: res.status, json, text: raw ? text : undefined, setCookies }
}

/** Extract a cookie VALUE (e.g. 'tcms-access') from a req() result. */
function cookieValue(res, name) {
  const raw = (res.setCookies ?? []).find((c) => c.startsWith(`${name}=`)) ?? ''
  return raw.split(';')[0].replace(new RegExp(`^${name}=`), '')
}

const stamp = Date.now()
const TEMP = {
  email: `notif-verify-${stamp}@tcms-test.com`,
  fullName: 'Notif Verify',
  password: 'TempPass@123',
  role: 'qa_engineer',
}

// ---------- 0. VP session (cookie-style bearer usage everywhere below) ----------
const vpLogin = await req('POST', '/api/auth?path=login', {
  body: { email: 'admin@tcms.com', password: 'Admin@123' },
})
const VP = cookieValue(vpLogin, 'tcms-access')
check('VP login sets tcms-access cookie', Boolean(VP))

// ---------- 1. Bearer header auth (regression: header was ignored before) ----------
const noAuth = await req('GET', '/api/auth?path=me')
check('no token -> 401', noAuth.status === 401)
const bearerMe = await req('GET', '/api/auth?path=me', { token: VP })
check('Authorization: Bearer works on /me', bearerMe.status === 200 && Boolean(bearerMe.json?.user))
const bearerDash = await req('GET', '/api/stats?action=dashboard', { token: VP })
check('Authorization: Bearer works on dashboard', bearerDash.status === 200 && typeof bearerDash.json?.totalTestCases === 'number')
const badToken = await req('GET', '/api/auth?path=me', { token: 'not-a-jwt' })
check('garbage token -> 401', badToken.status === 401)

// ---------- 2. temp user lifecycle ----------
const created = await req('POST', '/api/users', { token: VP, body: TEMP })
check('VP creates temp user (201/200)', created.status === 200 || created.status === 201, `got ${created.status}`)
const tempLogin1 = await req('POST', '/api/auth?path=login', {
  body: { email: TEMP.email, password: TEMP.password },
})
const TEMP_TOKEN = cookieValue(tempLogin1, 'tcms-access')
const TEMP_REFRESH = cookieValue(tempLogin1, 'tcms-refresh')
check('temp user logs in (access + refresh cookies)', Boolean(TEMP_TOKEN) && Boolean(TEMP_REFRESH))
const tempId = bearerTempId(tempLogin1)
function bearerTempId(loginRes) {
  // /me gives the profile; decode from access token payload instead (no dep).
  try {
    const payload = JSON.parse(Buffer.from(TEMP_TOKEN.split('.')[1], 'base64').toString())
    return payload.sub
  } catch {
    return null
  }
}
check('temp user id resolved from token', Boolean(tempId))

// ---------- 3. change-password validation + effect ----------
const wrongCurrent = await req('PUT', '/api/auth?path=password', {
  token: TEMP_TOKEN,
  body: { currentPassword: 'WrongPass@1', newPassword: 'NewPass@1234' },
})
check('wrong current password -> 400', wrongCurrent.status === 400, `got ${wrongCurrent.status}`)
const tooShort = await req('PUT', '/api/auth?path=password', {
  token: TEMP_TOKEN,
  body: { currentPassword: TEMP.password, newPassword: 'short' },
})
check('short new password -> 400 (validation)', tooShort.status === 400, `got ${tooShort.status}`)
const changed = await req('PUT', '/api/auth?path=password', {
  token: TEMP_TOKEN,
  body: { currentPassword: TEMP.password, newPassword: 'NewPass@1234' },
})
check('change password -> 200', changed.status === 200, `got ${changed.status}`)

const oldPw = await req('POST', '/api/auth?path=login', {
  body: { email: TEMP.email, password: TEMP.password },
})
check('old password no longer logs in -> 401', oldPw.status === 401, `got ${oldPw.status}`)
const newPw = await req('POST', '/api/auth?path=login', {
  body: { email: TEMP.email, password: 'NewPass@1234' },
})
check('new password logs in -> 200', newPw.status === 200)
const NEW_TOKEN = cookieValue(newPw, 'tcms-access')
const OLD_REFRESH = TEMP_REFRESH

const refreshedWithOld = await req('POST', '/api/auth?path=refresh', {
  body: { refreshToken: OLD_REFRESH },
})
check('old refresh token revoked after password change -> 401', refreshedWithOld.status === 401, `got ${refreshedWithOld.status}`)

const pwdNotif = await req('GET', '/api/notifications', { token: NEW_TOKEN })
const pwdNotifItems = (pwdNotif.json?.data ?? []).filter((n) => n.type === 'password_changed')
check(
  'password_changed notification created for the user',
  pwdNotifItems.length >= 1 && pwdNotifItems[0].type === 'password_changed',
  `got ${pwdNotifItems.length}`
)

// ---------- 4. notification preferences persist (telegram chat id + toggles) ----------
const prefUpdate = await req('PUT', '/api/auth', {
  token: NEW_TOKEN,
  body: { telegramChatId: '123456789', notifyEmail: false, notifyTelegram: true, notifyInapp: true },
})
check('profile PUT with telegram + channel prefs -> 200', prefUpdate.status === 200, `got ${prefUpdate.status}`)
const meAfter = await req('GET', '/api/auth?path=me', { token: NEW_TOKEN })
const u = meAfter.json?.user ?? {}
check('telegramChatId persisted', u.telegramChatId === '123456789', `got ${u.telegramChatId}`)
check('notifyEmail=false persisted', u.notifyEmail === false)
check('notifyTelegram=true persisted', u.notifyTelegram === true)

// ---------- 5. notification scoping + ownership ----------
const otherLogin = await req('POST', '/api/auth?path=login', {
  body: { email: 'teamlead@tcms.com', password: 'Lead@123' },
})
const OTHER = cookieValue(otherLogin, 'tcms-access')
const firstNotifId = pwdNotifItems[0]?.notificationId
const foreignRead = await req('PATCH', `/api/notifications?id=${firstNotifId}`, { token: OTHER })
check('marking someone else\'s notification read -> 403', foreignRead.status === 403, `got ${foreignRead.status}`)
const ownRead = await req('PATCH', `/api/notifications?id=${firstNotifId}`, { token: NEW_TOKEN })
check('owner marks own notification read -> 200', ownRead.status === 200 && ownRead.json?.isRead === true, `got ${ownRead.status}`)
const readAll = await req('POST', '/api/notifications?action=read-all', { token: NEW_TOKEN })
check('read-all -> 200 {success}', readAll.status === 200 && readAll.json?.success === true)
const unreadAfter = await req('GET', '/api/notifications?isRead=false', { token: NEW_TOKEN })
check('unread list empty after read-all', (unreadAfter.json?.data ?? []).length === 0)
const foreignList = await req('GET', '/api/notifications', { token: OTHER })
const foreignItems = foreignList.json?.data ?? []
check(
  'other user\'s list never contains temp user\'s notifications',
  foreignItems.every((n) => n.userId !== tempId)
)

// ---------- 6. bug assignment notifies assignee (in-app pipeline) ----------
// Bug creation requires a target module (validation layer); priority is no
// longer a bug field, so it is deliberately omitted here.
const modList = await req('GET', '/api/modules', { token: VP })
const notifModuleId = modList.json?.flat?.[0]?.moduleId
check('module available for bug creation', Boolean(notifModuleId))
const bugBody = {
  title: `Verify notification ${stamp}`,
  description: 'Created by verify-notifications.mjs to exercise bug_assigned delivery.',
  severity: 'low',
  environment: 'test',
  stepsToReproduce: 'Run the verifier',
  expectedBehaviour: 'Notification created',
  actualBehaviour: 'Notification created',
  moduleId: notifModuleId,
  assignedToId: tempId,
}
const bugCreate = await req('POST', '/api/bugs', { token: OTHER, body: bugBody })
check('manager creates bug assigned to temp user -> 201/200', bugCreate.status === 200 || bugCreate.status === 201, `got ${bugCreate.status}`)
const tempList = await req('GET', '/api/notifications', { token: NEW_TOKEN })
const bugNotifs = (tempList.json?.data ?? []).filter((n) => n.type === 'bug_assigned')
check('bug_assigned notification delivered in-app', bugNotifs.length >= 1, `got ${bugNotifs.length}`)

// ---------- 7. cleanup — soft delete temp user (domain rule) ----------
const deactivated = await req('DELETE', `/api/users?id=${tempId}`, { token: VP })
check('temp user soft-deleted (isActive -> false)', deactivated.status === 200)
const deactivatedLogin = await req('POST', '/api/auth?path=login', {
  body: { email: TEMP.email, password: 'NewPass@1234' },
})
check('deactivated user cannot log in -> 401', deactivatedLogin.status === 401, `got ${deactivatedLogin.status}`)

// ---------- 8. B16 cleanup — the temp user, its bug and their notifications ----------
await cleanupRunEntities(
  check,
  { bugs: bugCreate.json?.bugId ? [bugCreate.json.bugId] : [] },
  { userIds: tempId ? [tempId] : [], emails: [TEMP.email] }
)

console.log('======================================')
console.log(`NOTIF-AUTH RESULT: ${passed} passed, ${failed} failed`)
console.log('======================================')
process.exit(failed ? 1 : 0)
