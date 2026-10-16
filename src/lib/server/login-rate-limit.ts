// Per-IP login rate limit (backlog B6), next to the per-email lockout in auth.service.
// Counts FAILED sign-ins per client IP in a fixed window; at the limit the IP gets 429
// until the window ends. Successful sign-ins neither count nor reset (an attacker with
// one valid account cannot clear the counter). In memory → correct for the single app
// instance (docs/16); a second instance would need a shared store (Redis).
//
// Client IP: the LAST X-Forwarded-For entry — the address nginx itself appends
// ($proxy_add_x_forwarded_for), so a client-supplied prefix cannot spoof it.

import { ApiError } from '@/lib/api'
import { LOGIN_IP_MAX_FAILURES, LOGIN_IP_WINDOW_SECONDS } from '@/lib/server/config'

interface Bucket {
  failures: number
  resetAt: number
}

const MAX_TRACKED_IPS = 10_000
const buckets = new Map<string, Bucket>()

/** Normalized client IP key from the X-Forwarded-For value captured in RequestMeta. */
export function clientIpKey(forwardedFor: string | null): string {
  const last = (forwardedFor ?? '').split(',').map((s) => s.trim()).filter(Boolean).pop()
  return last || 'direct'
}

function liveBucket(ip: string, now: number): Bucket | null {
  const bucket = buckets.get(ip)
  if (!bucket) return null
  if (bucket.resetAt <= now) {
    buckets.delete(ip)
    return null
  }
  return bucket
}

/** Throws 429 while this IP is over the limit. Call before any password work. */
export function assertLoginAllowedForIp(ip: string): void {
  const now = Date.now()
  const bucket = liveBucket(ip, now)
  if (bucket && bucket.failures >= LOGIN_IP_MAX_FAILURES) {
    const secondsLeft = Math.ceil((bucket.resetAt - now) / 1000)
    throw new ApiError(429, `Too many failed sign-ins from your network. Try again in ${secondsLeft}s.`)
  }
}

/** Records one failed sign-in for this IP; returns the failure count in the window. */
export function recordFailedLoginForIp(ip: string): number {
  const now = Date.now()
  if (buckets.size >= MAX_TRACKED_IPS) {
    for (const [key, b] of buckets) if (b.resetAt <= now) buckets.delete(key)
    if (buckets.size >= MAX_TRACKED_IPS) buckets.delete(buckets.keys().next().value as string)
  }
  const bucket = liveBucket(ip, now) ?? { failures: 0, resetAt: now + LOGIN_IP_WINDOW_SECONDS * 1000 }
  bucket.failures += 1
  buckets.set(ip, bucket)
  return bucket.failures
}
