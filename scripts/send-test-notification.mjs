#!/usr/bin/env node
/**
 * Sends ONE test email and/or ONE Telegram message with the same settings and the same
 * transport options as the app (src/lib/server/delivery.ts), and prints OK or the error.
 * Use it after filling SMTP_* / TELEGRAM_BOT_TOKEN in .env (see .env.example).
 *
 * Usage:
 *   node scripts/send-test-notification.mjs --email=you@company.com --chat=123456789
 *   node scripts/send-test-notification.mjs --email=you@company.com     (email only)
 *   node scripts/send-test-notification.mjs --chat=-1001234567890        (Telegram only)
 *   node scripts/send-test-notification.mjs --check                      (show what is configured, send nothing)
 *
 * Settings come from the environment, then .env (loaded by this script; values are never
 * printed — only whether each one is set). The SMTP password and the bot token never
 * appear in the output, even inside error messages.
 * Exit: 0 every requested channel OK · 1 a send failed · 2 nothing to do / not configured.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFlags } from './lib/suite-harness.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENV_FILE = path.join(ROOT, '.env')
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE) // existing env vars win
const env = (k) => (process.env[k] ?? '').trim()

const EMAIL_TIMEOUT_MS = 10_000 // same as delivery.ts
const TELEGRAM_TIMEOUT_MS = 8_000
const SECRETS = [env('SMTP_PASS'), env('TELEGRAM_BOT_TOKEN')].filter((s) => s.length >= 4)

/** Error text with every secret value masked. */
function redact(text) {
  let out = String(text ?? '')
  for (const s of SECRETS) out = out.split(s).join('***')
  return out
}

function smtpSettings() {
  const port = Number(env('SMTP_PORT')) || 587
  return {
    host: env('SMTP_HOST'),
    port,
    secure: env('SMTP_SECURE').toLowerCase() === 'true' || env('SMTP_PORT') === '465',
    user: env('SMTP_USER'),
    pass: env('SMTP_PASS'),
    from: env('SMTP_FROM') || 'tcms@localhost',
  }
}

function printConfig() {
  const s = smtpSettings()
  console.log('Email   : SMTP_HOST ' + (s.host ? 'set' : 'NOT SET') + ` · port ${s.port} · secure ${s.secure} · SMTP_USER ${s.user ? 'set' : 'not set'} · SMTP_PASS ${s.pass ? 'set' : 'not set'} · from ${s.from}`)
  console.log('Telegram: TELEGRAM_BOT_TOKEN ' + (env('TELEGRAM_BOT_TOKEN') ? 'set' : 'NOT SET'))
}

async function sendTestEmail(to) {
  const s = smtpSettings()
  if (!s.host) return { ok: false, notConfigured: true, message: 'SMTP_HOST is not set' }
  try {
    const nodemailer = (await import('nodemailer')).default
    const transporter = nodemailer.createTransport({
      host: s.host,
      port: s.port,
      secure: s.secure,
      auth: s.user ? { user: s.user, pass: s.pass } : undefined,
      connectionTimeout: EMAIL_TIMEOUT_MS,
    })
    const info = await transporter.sendMail({
      from: s.from,
      to,
      subject: 'TCMS test notification',
      text: `This is a test email from TCMS (scripts/send-test-notification.mjs) sent at ${new Date().toISOString()}.`,
    })
    return { ok: true, message: `accepted by ${s.host}:${s.port} (message id ${info.messageId ?? '-'})` }
  } catch (err) {
    return { ok: false, message: redact(`${err.code ?? err.name}: ${err.message}`) }
  }
}

async function sendTestTelegram(chatId) {
  const token = env('TELEGRAM_BOT_TOKEN')
  if (!token) return { ok: false, notConfigured: true, message: 'TELEGRAM_BOT_TOKEN is not set' }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: `TCMS test notification (${new Date().toISOString()})` }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    })
    const body = await res.json().catch(() => ({}))
    if (res.ok && body.ok) return { ok: true, message: `delivered to chat ${chatId}` }
    return { ok: false, message: redact(`HTTP ${res.status}: ${body.description ?? 'no description'}`) }
  } catch (err) {
    return { ok: false, message: redact(`${err.name}: ${err.cause?.code ?? err.message}`) }
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2))
  printConfig()
  if (flags.check) return 0
  const jobs = []
  if (flags.email) jobs.push(['Email', String(flags.email), sendTestEmail])
  if (flags.chat) jobs.push(['Telegram', String(flags.chat), sendTestTelegram])
  if (jobs.length === 0) {
    console.log('Nothing to send: pass --email=<address> and/or --chat=<telegram chat id> (or --check).')
    return 2
  }
  let failed = false
  let notConfigured = false
  for (const [label, target, send] of jobs) {
    const result = await send(target)
    console.log(`${label.padEnd(8)}: ${result.ok ? 'OK' : 'ERROR'} — ${result.message}`)
    if (!result.ok) {
      failed = true
      notConfigured ||= !!result.notConfigured
    }
  }
  if (!failed) return 0
  return notConfigured ? 2 : 1
}

main().then((code) => { process.exitCode = code })
