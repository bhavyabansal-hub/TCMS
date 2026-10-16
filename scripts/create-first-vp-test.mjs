#!/usr/bin/env node
/**
 * Verifier for scripts/create-first-vp.mjs (backlog B1). Sandbox only (DB guard + lock).
 *   1. Refusals through the real CLI: VP exists, bad email, wrong DB target (never
 *      connects), production mode on the sandbox URL. The password never shows in output.
 *   2. Create path inside ONE transaction that is always rolled back: active VPs are
 *      deactivated in the transaction, the VP row is inserted with the shared code,
 *      the bcrypt hash verifies, then ROLLBACK; afterwards nothing changed.
 * Usage: node scripts/create-first-vp-test.mjs
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import bcrypt from 'bcryptjs'
import { openGuardedDb } from './lib/db-guard.mjs'
import { checkPasswordStrength, countActiveVps, insertVp, isEmailTaken, validateIdentity } from './lib/first-vp.mjs'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'create-first-vp.mjs')
const PASSWORD = `FirstVp${Date.now()}x`
const EMAIL = `first-vp-test-${Date.now()}@tcms-test.com`
let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`) }
}
class Rollback extends Error {}

function runCli(args, env = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    input: `${PASSWORD}\n${PASSWORD}\n`,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { code: res.status, out: `${res.stdout}${res.stderr}` }
}

function checkCliRefusals() {
  const exists = runCli([`--email=${EMAIL}`, '--name=First VP'])
  check('CLI: refuses when an active VP exists (exit 1)', exists.code === 1 && exists.out.includes('an active VP already exists'), exists.out.trim())
  check('CLI: password never printed', !exists.out.includes(PASSWORD))
  const badEmail = runCli(['--email=not-an-email', '--name=First VP'])
  check('CLI: bad email refused (exit 1)', badEmail.code === 1 && badEmail.out.includes('valid --email'), badEmail.out.trim())
  const wrongDb = runCli([`--email=${EMAIL}`, '--name=First VP'], { DATABASE_URL: 'mysql://u:p@127.0.0.1:5599/other_db', TCMS_DEPLOY_ENV: '' })
  check('CLI: non-sandbox URL outside production -> NOT RUN (exit 2)', wrongDb.code === 2 && wrongDb.out.includes('NOT RUN'), wrongDb.out.trim())
  const prodOnSandbox = runCli([`--email=${EMAIL}`, '--name=First VP'], { TCMS_DEPLOY_ENV: 'production' })
  check('CLI: production mode refuses the sandbox URL (exit 2)', prodOnSandbox.code === 2 && prodOnSandbox.out.includes('local sandbox'), prodOnSandbox.out.trim())
}

function checkRules() {
  check('rule: short password rejected', checkPasswordStrength('Abc123') !== null)
  check('rule: no digit rejected', checkPasswordStrength('abcdefghijklmn') !== null)
  check('rule: strong password accepted', checkPasswordStrength(PASSWORD) === null)
  check('rule: email normalized', validateIdentity('  First.VP@Example.COM ', 'A B').email === 'first.vp@example.com')
}

async function checkCreatePathRolledBack(db) {
  const before = await countActiveVps(db)
  try {
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE users SET is_active = 0 WHERE role = 'vp' AND is_active = 1`
      check('tx: no active VP after the in-transaction deactivation', (await countActiveVps(tx)) === 0)
      const userId = await insertVp(tx, { email: EMAIL, fullName: 'First VP Test', password: PASSWORD })
      const rows = await tx.$queryRaw`SELECT role, is_active, password_hash FROM users WHERE user_id = ${userId}`
      check('tx: VP row inserted (role vp, active)', rows[0]?.role === 'vp' && Number(rows[0]?.is_active) === 1)
      check('tx: stored hash is bcrypt and verifies', /^\$2[aby]\$10\$/.test(rows[0]?.password_hash) && bcrypt.compareSync(PASSWORD, rows[0].password_hash))
      check('tx: hash does not contain the password', !rows[0]?.password_hash.includes(PASSWORD))
      throw new Rollback('always roll back')
    })
  } catch (err) {
    if (!(err instanceof Rollback)) throw err
  }
  check('after rollback: active VP count unchanged', (await countActiveVps(db)) === before, `before=${before}`)
  check('after rollback: test email absent', !(await isEmailTaken(db, EMAIL)))
}

async function main() {
  checkRules()
  checkCliRefusals()
  const guard = await openGuardedDb()
  try {
    guard.setBusy(true)
    await checkCreatePathRolledBack(guard.db)
  } finally {
    guard.setBusy(false)
    await guard.release()
  }
  console.log(`\nFIRST-VP RESULT: ${pass} passed, ${fail} failed`)
  return fail ? 1 : 0
}

main().then((code) => { process.exitCode = code }, (err) => { console.error(`ERROR: ${err.message}`); process.exitCode = 1 })
