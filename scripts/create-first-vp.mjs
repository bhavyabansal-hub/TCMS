#!/usr/bin/env node
/**
 * Creates the first VP account on an empty production database (backlog B1).
 * Seed is blocked in production and signup only creates viewers, so this is the one
 * supported way to get the first admin.
 *
 * Usage:
 *   node scripts/create-first-vp.mjs --email=<email> --name="<full name>"
 * The password is read from a hidden prompt (asked twice), never from an argument, and
 * is never printed or logged. Without a terminal (piped stdin) the first two lines are
 * read as password + confirmation, for automation only.
 *
 * Target database = DATABASE_URL (Prisma loads .env):
 *   TCMS_DEPLOY_ENV=production  -> the production URL; refuses the local sandbox URL.
 *   otherwise                   -> only 127.0.0.1|localhost:5500/tcms_test (agent.md §6).
 * Refuses (exit 1) when an active VP already exists or the email is taken.
 * Exit: 0 created, 1 refused / invalid input, 2 wrong target or DB error.
 */
import { PrismaClient } from '@prisma/client'
import { checkPasswordStrength, countActiveVps, createFirstVp, validateIdentity } from './lib/first-vp.mjs'
import { parseFlags } from './lib/suite-harness.mjs'

const SANDBOX = { hosts: new Set(['127.0.0.1', 'localhost']), port: '5500', path: '/tcms_test' }

/** Returns null when the URL may be used in this mode, else the reason. Never prints the URL. */
function checkTarget(rawUrl, isProduction) {
  let url
  try {
    url = new URL(rawUrl ?? '')
  } catch {
    return 'DATABASE_URL is missing or not a URL'
  }
  if (url.protocol !== 'mysql:') return 'DATABASE_URL is not a mysql:// URL'
  const isSandbox = SANDBOX.hosts.has(url.hostname) && url.port === SANDBOX.port && url.pathname === SANDBOX.path
  if (isProduction && isSandbox) return 'TCMS_DEPLOY_ENV=production but DATABASE_URL points at the local sandbox'
  if (!isProduction && !isSandbox) return 'outside production only 127.0.0.1:5500/tcms_test is allowed (set TCMS_DEPLOY_ENV=production on the server)'
  return null
}

/** Reads one line without echo on a TTY; plain line read when stdin is piped. */
function readHidden(prompt, lines) {
  if (!process.stdin.isTTY) return Promise.resolve(lines.shift() ?? '')
  return new Promise((resolve) => {
    process.stdout.write(prompt)
    let value = ''
    const onData = (buf) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false)
          process.stdin.pause()
          process.stdin.off('data', onData)
          process.stdout.write('\n')
          resolve(value)
          return
        }
        if (ch === '\u0003') process.exit(130) // Ctrl+C
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else value += ch
      }
    }
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', onData)
  })
}

async function readPipedLines() {
  if (process.stdin.isTTY) return []
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text.split(/\r?\n/)
}

async function main() {
  const flags = parseFlags(process.argv.slice(2))
  const identity = validateIdentity(flags.email, flags.name)
  if (identity.error) {
    console.log(`REFUSED: ${identity.error}`)
    return 1
  }
  const isProduction = process.env.TCMS_DEPLOY_ENV === 'production'
  const targetProblem = checkTarget(process.env.DATABASE_URL, isProduction) // .env loaded by @prisma/client
  if (targetProblem) {
    console.log(`NOT RUN: ${targetProblem}`)
    return 2
  }
  // One connection, so GET_LOCK / the transaction / RELEASE_LOCK share one session.
  const url = new URL(process.env.DATABASE_URL)
  url.searchParams.set('connection_limit', '1')
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } } })
  try {
    console.log(`mode=${isProduction ? 'production' : 'sandbox'}`)
    if ((await countActiveVps(db)) > 0) {
      console.log('REFUSED: an active VP already exists (use the Users page to add more)')
      return 1
    }
    const lines = await readPipedLines()
    const password = await readHidden('Password for the new VP: ', lines)
    const confirm = await readHidden('Repeat the password: ', lines)
    if (password !== confirm) {
      console.log('REFUSED: the two passwords differ')
      return 1
    }
    const weak = checkPasswordStrength(password)
    if (weak) {
      console.log(`REFUSED: ${weak}`)
      return 1
    }
    const result = await createFirstVp(db, identity, password)
    if (result.refused) {
      console.log(`REFUSED: ${result.refused}`)
      return 1
    }
    console.log(`OK: VP created user_id=${result.userId} email=${identity.email}`)
    return 0
  } catch (err) {
    console.log(`ERROR: database step failed (${err.code ?? err.name})`)
    return 2
  } finally {
    await db.$disconnect()
  }
}

main().then((code) => { process.exitCode = code })
