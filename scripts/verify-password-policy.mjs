#!/usr/bin/env node
/**
 * Password rule (src/lib/password-policy.ts, owner request 2026-10-23): at least 10
 * characters, a letter and a number, at most 72 bytes — the SAME rule on every
 * endpoint that sets a password:
 *   1. POST /api/users (VP creates an account)
 *   2. PUT /api/auth?path=password (a user changes their own password)
 *   3. POST /api/auth?path=register (self-signup; 403 afterwards when signup is off)
 *   4. an old password that predates the rule still signs in (sign-in is not checked)
 *   5. the first-VP script keeps its stricter 12+ rule and the 72-byte cap
 * Own stamped fixture users; everything is removed at the end (residue 0).
 * Usage: node scripts/verify-password-policy.mjs   (app on TCMS_BASE_URL, default :3000)
 */
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { GuardAbort, openGuardedDb } from './lib/db-guard.mjs'
import { cleanupFixtureRun } from './lib/fixture-cleanup.mjs'
import { createFixtureUsers, fixtureEmail } from './lib/fixture-users.mjs'
import { checkPasswordStrength } from './lib/first-vp.mjs'
import { BASE, createCounter, jarFromSetCookie } from './lib/suite-harness.mjs'

const stamp = String(Date.now())
const PREFIX = 'pwpolicy'
const counter = createCounter()
const check = counter.check

// Each weak password breaks exactly one part of the rule.
const WEAK = [
  ['9 characters', 'Abcdefg12'],
  ['no number', 'Abcdefghij'],
  ['no letter', '1234567890'],
  ['73 bytes (bcrypt would cut it)', `Aa1${'x'.repeat(70)}`],
  ['73 bytes with accents', `Aa1${'é'.repeat(35)}`],
]
const strong = () => `Pw${randomBytes(6).toString('hex')}7` // 15 characters, letter + number

async function api(jar, method, urlPath, body) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: { 'X-Requested-With': 'tcms', Origin: BASE, 'Content-Type': 'application/json', ...(jar ? { Cookie: jar } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let json = null
  try { json = await res.json() } catch { /* no body */ }
  return { status: res.status, json, jar: jarFromSetCookie(res.headers.getSetCookie?.() ?? []) }
}

const fieldMessage = (r, field) => r.json?.details?.fieldErrors?.[field]?.[0] ?? r.json?.error ?? ''
const login = (email, password) => api(null, 'POST', '/api/auth?path=login', { email, password })

async function main() {
  // 5: the first-VP rule (pure function, no server needed).
  check('5a first VP: 10 characters is not enough (needs 12)', checkPasswordStrength('Abcdefgh12') !== null)
  check('5b first VP: 12 characters with letter + number accepted', checkPasswordStrength('Abcdefghij12') === null)
  check('5c first VP: 73 bytes refused', checkPasswordStrength(`Aa1${'x'.repeat(70)}`) !== null)

  let guard
  try {
    guard = await openGuardedDb()
  } catch (err) {
    console.log(`NOT RUN: ${err instanceof GuardAbort ? err.message : err.message}`)
    process.exitCode = 2
    return
  }
  const { db } = guard
  const fixtures = []
  try {
    const [vp, old] = await createFixtureUsers(db, [
      { key: 'vp', role: 'vp', email: fixtureEmail(PREFIX, 'vp', stamp), name: 'Pwpolicy VP' },
      { key: 'old', role: 'viewer', email: fixtureEmail(PREFIX, 'old', stamp), name: 'Pwpolicy Old' },
    ])
    fixtures.push(vp, old)
    const vpJar = (await login(vp.email, vp.password)).jar

    // 1: POST /api/users
    for (const [label, password] of WEAK) {
      const r = await api(vpJar, 'POST', '/api/users', { email: fixtureEmail(PREFIX, `weak${fixtures.length}${label.length}`, stamp), fullName: 'Pwpolicy Weak', password, role: 'viewer' })
      check(`1 new account, ${label} -> 400 with a clear message`, r.status === 400 && /Password/.test(fieldMessage(r, 'password')), `${r.status} ${fieldMessage(r, 'password')}`)
    }
    const firstPassword = strong()
    const newEmail = fixtureEmail(PREFIX, 'new', stamp)
    const created = await api(vpJar, 'POST', '/api/users', { email: newEmail, fullName: 'Pwpolicy New', password: firstPassword, role: 'viewer' })
    const newId = created.json?.userId ?? created.json?.user?.userId
    if (newId) fixtures.push({ userId: String(newId), email: newEmail })
    check('1 new account with a 15-character password -> 200', created.status === 200 && !!newId, `${created.status}`)

    // 2: PUT /api/auth?path=password
    const userJar = (await login(newEmail, firstPassword)).jar
    for (const [label, password] of WEAK) {
      const r = await api(userJar, 'PUT', '/api/auth?path=password', { currentPassword: firstPassword, newPassword: password })
      check(`2 change password, ${label} -> 400`, r.status === 400 && /Password/.test(fieldMessage(r, 'newPassword')), `${r.status} ${fieldMessage(r, 'newPassword')}`)
    }
    const nextPassword = strong()
    const changed = await api(userJar, 'PUT', '/api/auth?path=password', { currentPassword: firstPassword, newPassword: nextPassword })
    check('2 change password to a valid one -> 200', changed.status === 200, `${changed.status}`)
    check('2 the new password signs in', (await login(newEmail, nextPassword)).status === 200)

    // 3: POST /api/auth?path=register — the rule is checked before the signup switch.
    for (const [label, password] of WEAK) {
      const r = await api(null, 'POST', '/api/auth?path=register', { email: fixtureEmail(PREFIX, `reg${label.length}`, stamp), fullName: 'Pwpolicy Signup', password })
      check(`3 self-signup, ${label} -> 400`, r.status === 400, `${r.status}`)
    }
    const regEmail = fixtureEmail(PREFIX, 'signup', stamp)
    const reg = await api(null, 'POST', '/api/auth?path=register', { email: regEmail, fullName: 'Pwpolicy Signup', password: strong() })
    check('3 self-signup with a valid password -> 200 (signup on) or 403 (signup off)', reg.status === 200 || reg.status === 403, `${reg.status}`)
    if (reg.status === 200) {
      const row = await db.$queryRaw`SELECT user_id FROM users WHERE email = ${regEmail}`
      if (row[0]) fixtures.push({ userId: String(row[0].user_id), email: regEmail })
    }

    // 4: a password set before the rule (8 characters) still signs in.
    await db.$executeRaw`UPDATE users SET password_hash = ${bcrypt.hashSync('Old12345', 10)} WHERE user_id = ${old.userId}`
    check('4 an old 8-character password still signs in', (await login(old.email, 'Old12345')).status === 200)
  } catch (err) {
    check(`suite aborted: ${err.message}`, false)
  } finally {
    if (fixtures.length) {
      try {
        const report = await cleanupFixtureRun(db, fixtures, { prefix: PREFIX, stamp })
        check('cleanup: residue 0', Object.values(report.residue).every((n) => n === 0), JSON.stringify(report.residue))
      } catch (err) {
        check(`cleanup failed (stamp ${stamp})`, false, err.message)
      }
    }
    await guard.release()
  }
  console.log(`\nPASSWORD-POLICY RESULT: ${counter.pass} passed, ${counter.fail} failed`)
  process.exitCode = counter.fail ? 1 : 0
}

main()
