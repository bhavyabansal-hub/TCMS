// Central structured logger for the TCMS API.
//
// WHY: "proper logs" requirement — every layer logs through this helper so
// output is uniform: `[tcms] <iso-time> <LEVEL> <message> {meta}`.
// Controllers log request/latency via withApi(), services log business
// events, repositories never log (they stay pure data access).
//
// TRANSPORTS (single logging path — DRY):
//   1. console  — always (dev tailing via start-tcms.sh / docker logs).
//   2. files    — on the server (Node runtime):
//       logs/app-YYYY-MM-DD.log    info and above
//       logs/error-YYYY-MM-DD.log  errors only
//     File writing is failure-isolated: any fs problem silently disables the
//     file transport for the rest of the day and logging falls back to
//     console-only, so logging can NEVER break a request.
//   3. Telegram LOGS BOT — when TELEGRAM_LOG_BOT_TOKEN + TELEGRAM_LOG_CHAT_ID
//     are set (a dedicated bot, separate from the user-notification bot),
//     messages at TELEGRAM_LOG_LEVEL and above are mirrored to that chat.
//     Batching: lines are queued and flushed at most once per
//     TELEGRAM_LOG_MIN_INTERVAL_MS so an error burst cannot flood the chat
//     (Telegram allows ~1 msg/sec per chat). Oversized batches keep the
//     newest lines and prepend a suppression counter. Send failures are
//     swallowed after one console note — the bot must never break the app.
//
// RETENTION: files older than LOG_RETENTION_DAYS (default 14) are purged once
// per day on the first write, so the logs folder cannot grow unbounded.

import fs from 'node:fs'
import path from 'node:path'
import {
  IS_PRODUCTION,
  LOG_DIR as LOG_DIR_ENV,
  LOG_RETENTION_DAYS as RETENTION_DAYS_ENV,
  TELEGRAM_LOG_BOT_TOKEN,
  TELEGRAM_LOG_CHAT_ID,
  TELEGRAM_LOG_LEVEL,
  TELEGRAM_LOG_MIN_INTERVAL_MS,
} from '@/lib/server/config'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

const MIN_LEVEL: LogLevel = IS_PRODUCTION ? 'info' : 'debug'

const LOG_DIR = path.isAbsolute(LOG_DIR_ENV) ? LOG_DIR_ENV : path.join(process.cwd(), LOG_DIR_ENV)
const RETENTION_DAYS = RETENTION_DAYS_ENV

// ---------- Telegram logs-bot transport (batched, failure-isolated) ----------

const TELEGRAM_MIN_WEIGHT = LEVEL_WEIGHT[(TELEGRAM_LOG_LEVEL as LogLevel) in LEVEL_WEIGHT ? (TELEGRAM_LOG_LEVEL as LogLevel) : 'error']
const TELEGRAM_ENABLED = Boolean(TELEGRAM_LOG_BOT_TOKEN && TELEGRAM_LOG_CHAT_ID)
const TELEGRAM_MAX_CHARS = 3_500 // Telegram's hard cap is 4096 — leave headroom

const telegramState = {
  queue: [] as string[],
  timer: null as ReturnType<typeof setTimeout> | null,
  dropCount: 0,
  failureNotified: false,
}

function queueForTelegram(level: LogLevel, line: string): void {
  if (!TELEGRAM_ENABLED || LEVEL_WEIGHT[level] < TELEGRAM_MIN_WEIGHT) return
  telegramState.queue.push(line)
  if (!telegramState.timer) {
    telegramState.timer = setTimeout(flushTelegramQueue, TELEGRAM_LOG_MIN_INTERVAL_MS)
  }
}

async function flushTelegramQueue(): Promise<void> {
  telegramState.timer = null
  if (telegramState.queue.length === 0) return

  // Keep the NEWEST lines within the size budget; count what we dropped.
  const batch: string[] = []
  let size = 0
  while (telegramState.queue.length > 0) {
    const line = telegramState.queue[telegramState.queue.length - 1]
    if (size + line.length + 1 > TELEGRAM_MAX_CHARS) break
    batch.unshift(telegramState.queue.pop() as string)
    size += line.length + 1
  }
  if (telegramState.queue.length > 0) {
    telegramState.dropCount += telegramState.queue.length
    telegramState.queue = []
  }
  const dropNote = telegramState.dropCount > 0 ? `\n…(${telegramState.dropCount} earlier lines suppressed)` : ''
  if (telegramState.dropCount > 0) telegramState.dropCount = 0
  if (batch.length === 0) return

  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_LOG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_LOG_CHAT_ID, text: batch.join('\n') + dropNote }),
      signal: AbortSignal.timeout(5_000),
    })
    if (res.ok) {
      telegramState.failureNotified = false // recovered — re-arm the one-time note
    } else if (!telegramState.failureNotified) {
      telegramState.failureNotified = true
      console.warn(`[tcms] Telegram logs-bot send failed (HTTP ${res.status}) — continuing console/file only.`)
    }
  } catch {
    if (!telegramState.failureNotified) {
      telegramState.failureNotified = true
      console.warn('[tcms] Telegram logs-bot unreachable — continuing console/file only.')
    }
  }
}

// ---------- File transport ----------

/** One file-transport state bag; day-scoped so files rotate at UTC midnight. */
const fileState = {
  day: '',
  appFile: '',
  errorFile: '',
  disabledUntilDay: '', // set when fs fails; retry next day
  retentionSwept: false,
}

function isoDay(d = new Date()): string {
  return d.toISOString().slice(0, 10)
}

/** Opens the day's log files (and runs the retention sweep) once per day. */
function ensureDayFiles(day: string): void {
  fs.mkdirSync(LOG_DIR, { recursive: true })
  fileState.appFile = path.join(LOG_DIR, `app-${day}.log`)
  fileState.errorFile = path.join(LOG_DIR, `error-${day}.log`)

  if (!fileState.retentionSwept) {
    fileState.retentionSwept = true
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000
    for (const name of fs.readdirSync(LOG_DIR)) {
      const match = /^(app|error)-(\d{4}-\d{2}-\d{2})\.log$/.exec(name)
      if (!match) continue
      if (new Date(`${match[2]}T00:00:00Z`).getTime() < cutoff) {
        fs.unlinkSync(path.join(LOG_DIR, name))
      }
    }
  }
}

function appendToFile(file: string, line: string): boolean {
  try {
    const day = isoDay()
    if (day !== fileState.day) {
      fileState.day = day
      fileState.disabledUntilDay = ''
      fileState.retentionSwept = false
      ensureDayFiles(day)
    }
    if (fileState.disabledUntilDay === day) return false
    fs.appendFileSync(file, line + '\n')
    return true
  } catch {
    // Disk problem (permissions, full volume...) — console still has the line.
    fileState.disabledUntilDay = isoDay()
    return false
  }
}

// ---------- Formatting + dispatch ----------

function formatMeta(meta?: Record<string, unknown>): string {
  if (!meta) return ''
  try {
    return ' ' + JSON.stringify(meta)
  } catch {
    return ' [unserializable meta]'
  }
}

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack }
  }
  return { value: String(err) }
}

function write(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[MIN_LEVEL]) return
  const line = `[tcms] ${new Date().toISOString()} ${level.toUpperCase()} ${message}${formatMeta(meta)}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)

  appendToFile(fileState.appFile || path.join(LOG_DIR, `app-${isoDay()}.log`), line)
  if (level === 'error') appendToFile(path.join(LOG_DIR, `error-${isoDay()}.log`), line)

  queueForTelegram(level, line)
}

export const logger = {
  debug(message: string, meta?: Record<string, unknown>) {
    write('debug', message, meta)
  },
  info(message: string, meta?: Record<string, unknown>) {
    write('info', message, meta)
  },
  warn(message: string, meta?: Record<string, unknown>) {
    write('warn', message, meta)
  },
  error(message: string, err?: unknown, meta?: Record<string, unknown>) {
    write('error', message, { ...(err ? { error: serializeError(err) } : {}), ...meta })
  },
}
