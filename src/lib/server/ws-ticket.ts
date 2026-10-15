// WebSocket auth tickets — SECURITY FIX (audit 2026-10-09).
//
// The notifications WS mini-service used to accept ANY {userId, token} pair
// (the client literally sent token:'dev'), so anyone who could reach the
// service could subscribe to ANY user's live notification stream. The fix:
// the app issues a short-lived, single-purpose HMAC ticket to authenticated
// users (GET /api/auth?path=ws-ticket); the mini-service verifies the
// signature + expiry + audience and only then joins the socket to the
// user's room. The ticket grants NOTHING else, expires in 60s, and never
// touches the long-lived session JWT (which stays in an httpOnly cookie and
// is unreadable to the WS client).
//
// Implemented with node:crypto HMAC-SHA256 (NOT jsonwebtoken) so the
// dependency-free Bun mini-service can verify with the exact same code path.

import { createHmac, timingSafeEqual } from 'crypto'

const TICKET_TTL_SECONDS = 60
const AUDIENCE = 'tcms-ws'

export interface WsTicketPayload {
  /** subject = TCMS user id the socket may subscribe to */
  sub: string
  /** audience marker — a ticket is useless anywhere except the WS service */
  aud: string
  /** expiry, epoch seconds */
  exp: number
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function hmac(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url')
}

/** Signs a 60-second ticket for `userId`. Secret comes from the shared
 *  WS_NOTIFY_SECRET (set in .env for both the app and the mini-service). */
export function signWsTicket(userId: string, secret: string): string {
  const payload: WsTicketPayload = {
    sub: userId,
    aud: AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS,
  }
  const body = b64url(JSON.stringify(payload))
  const sig = hmac(body, secret)
  return `${body}.${sig}`
}

/**
 * Verifies a ticket: signature (constant-time), expiry and audience.
 * Returns the subject userId, or null for ANY problem (fail closed).
 */
export function verifyWsTicket(token: string | undefined, secret: string): string | null {
  if (!token || !secret) return null
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = hmac(body, secret)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as WsTicketPayload
    if (payload.aud !== AUDIENCE) return null
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null
    if (!payload.sub) return null
    return payload.sub
  } catch {
    return null
  }
}

export const WS_TICKET_TTL_SECONDS = TICKET_TTL_SECONDS
