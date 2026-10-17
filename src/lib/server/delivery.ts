// Outbound notification delivery — email (SMTP) and Telegram channels.
//
// Both channels are opt-in and environment-gated:
//   - Email    requires SMTP_HOST (+ optional SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM/SMTP_SECURE).
//   - Telegram requires TELEGRAM_BOT_TOKEN; the per-user chat id comes from
//     the user's `telegram_chat_id` column (set in Settings → Profile).
//
// When the environment is missing (or a send fails) the channel is SKIPPED
// or marked failed with a log line — delivery must never throw and never
// block or fail the business operation that produced the notification.
// Pure server module: no HTTP types, no Next.js imports.

import { logger } from '@/lib/logger'
import {
  SMTP_FROM,
  SMTP_HOST,
  SMTP_PASS,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_TIMEOUT_MS,
  SMTP_USER,
  TELEGRAM_API_URL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_TIMEOUT_MS,
} from '@/lib/server/config'


export interface DeliveryTarget {
  email?: string | null
  telegramChatId?: string | null
  notifyEmail?: boolean
  notifyTelegram?: boolean
}

export interface DeliveryPayload {
  /** Short headline — becomes the email subject / the first Telegram line. */
  subject: string
  /** Longer body — plain text, no HTML required. */
  body?: string
}

export type DeliveryChannel = 'email' | 'telegram'

export type DeliveryStatus = 'sent' | 'skipped' | 'failed'

export interface DeliveryResult {
  channel: DeliveryChannel
  status: DeliveryStatus
  /** Why a channel was skipped or failed (logged; also useful in tests). */
  reason?: string
}

interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  user?: string
  pass?: string
  from: string
}

/** Read + validate SMTP config from the central config; null = email not configured. */
function readSmtpConfig(): SmtpConfig | null {
  if (!SMTP_HOST) return null
  return {
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    user: SMTP_USER || undefined,
    pass: SMTP_PASS || undefined,
    from: SMTP_FROM,
  }
}

// LAZY SINGLETON transporter: created once per process on the first real send
// and reused for every send afterwards (an SMTP pool per message would churn
// sockets). Config is process-static (module-level constants), so one
// transporter is correct for the process lifetime.
let transporterPromise: Promise<Awaited<ReturnType<typeof import('nodemailer').createTransport>>> | null = null
async function getTransporter(config: SmtpConfig) {
  if (!transporterPromise) {
    transporterPromise = import('nodemailer').then((nodemailer) =>
      nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.user ? { user: config.user, pass: config.pass } : undefined,
        connectionTimeout: SMTP_TIMEOUT_MS,
        // Cap the whole SMTP exchange too, so a stalled server cannot hold
        // background work open (nodemailer defaults are minutes long).
        greetingTimeout: SMTP_TIMEOUT_MS,
        socketTimeout: SMTP_TIMEOUT_MS,
      })
    )
  }
  return transporterPromise
}

/** Send one email through SMTP. Returns a result object; never throws. */
async function sendEmail(to: string, payload: DeliveryPayload): Promise<DeliveryResult> {
  const config = readSmtpConfig()
  if (!config) {
    return { channel: 'email', status: 'skipped', reason: 'SMTP not configured (set SMTP_HOST)' }
  }
  try {
    const transporter = await getTransporter(config)
    await transporter.sendMail({
      from: config.from,
      to,
      subject: payload.subject,
      text: payload.body ?? payload.subject,
    })
    return { channel: 'email', status: 'sent' }
  } catch (err) {
    logger.error('Email delivery failed', err, { to, subject: payload.subject })
    return { channel: 'email', status: 'failed', reason: 'SMTP send error' }
  }
}

/** Send one Telegram message via the Bot API. Returns a result; never throws. */
async function sendTelegram(chatId: string, payload: DeliveryPayload): Promise<DeliveryResult> {
  const token = TELEGRAM_BOT_TOKEN
  if (!token) {
    return { channel: 'telegram', status: 'skipped', reason: 'Telegram not configured (set TELEGRAM_BOT_TOKEN)' }
  }
  try {
    const text = payload.body ? `${payload.subject}\n\n${payload.body}` : payload.subject
    const response = await fetch(`${TELEGRAM_API_URL}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    })
    if (!response.ok) {
      logger.error('Telegram delivery failed', null, { chatId, httpStatus: response.status })
      return { channel: 'telegram', status: 'failed', reason: `HTTP ${response.status}` }
    }
    return { channel: 'telegram', status: 'sent' }
  } catch (err) {
    logger.error('Telegram delivery failed', err, { chatId })
    return { channel: 'telegram', status: 'failed', reason: 'Request error' }
  }
}

/**
 * Deliver one notification to every channel the recipient enabled.
 * Channels run in parallel; each is env-gated + preference-gated and
 * independently failure-isolated. The returned results describe what
 * happened per channel (sent / skipped / failed + reason).
 */
export async function deliverNotification(target: DeliveryTarget, payload: DeliveryPayload): Promise<DeliveryResult[]> {
  const wantEmail = target.notifyEmail === true && Boolean(target.email)
  const wantTelegram = target.notifyTelegram === true && Boolean(target.telegramChatId)

  const attempts: Promise<DeliveryResult>[] = []
  attempts.push(
    wantEmail
      ? sendEmail(target.email as string, payload)
      : Promise.resolve<DeliveryResult>({
          channel: 'email',
          status: 'skipped',
          reason: wantEmail ? undefined : 'Disabled by user preferences or missing address',
        })
  )
  attempts.push(
    wantTelegram
      ? sendTelegram(target.telegramChatId as string, payload)
      : Promise.resolve<DeliveryResult>({
          channel: 'telegram',
          status: 'skipped',
          reason: wantTelegram ? undefined : 'Disabled by user preferences or missing chat id',
        })
  )

  const results = await Promise.all(attempts)
  const summary = results.map((r) => `${r.channel}:${r.status}`).join(' ')
  logger.info('Notification delivery attempted', { subject: payload.subject, channels: summary })
  return results
}
