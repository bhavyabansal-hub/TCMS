// Crew Desk identity — the verification-ONLY email check.
//
// What it does: before TCMS posts a comment on behalf of a human linker
// (test + live modes), the linker's TCMS email (lowercase, trimmed) is
// looked up in the Crew Desk user list fetched WITH THE SHARED credentials.
// Not found -> the post is refused with a friendly message. Found -> only
// TWO facts are stored on the TCMS user: the matched Crew Desk user id and
// the time of the check. The user LIST itself is never stored, cached to
// disk, or returned to any browser.
//
// Caching rules (product spec):
//   - the Crew Desk user list is kept in memory for ~10 minutes;
//   - when an email is NOT found, the list is refreshed once and the lookup
//     retried (protects against a stale cache producing a false "not found");
//   - a user with a stored match is re-verified at most once every 24 hours
//     (fresh stored check => no network call at all).
//
// Exceptions: none. Every linker is matched by their own TCMS email
// (lowercase, trimmed) — exactly the "simple check" the product kept.

import { CrewDeskError, listAssignableUsers, type CrewDeskUserRef } from '@/lib/server/crewdesk.client'
import { getUserCrewDeskCheck, saveUserCrewDeskCheck } from './crewdesk.repository'

export const EMAIL_NOT_FOUND_MESSAGE = 'Your email was not found in Crew Desk. Ask your admin.'

const LIST_TTL_MS = 10 * 60 * 1000 // ~10 minutes
const USER_RECHECK_MS = 24 * 60 * 60 * 1000 // re-check each user at least once a day

interface ListCache {
  users: CrewDeskUserRef[] | null
  fetchedAt: number
  inflight: Promise<CrewDeskUserRef[]> | null
}
const cache: ListCache = { users: null, fetchedAt: 0, inflight: null }

async function fetchUserList(): Promise<CrewDeskUserRef[]> {
  const users = await listAssignableUsers()
  cache.users = users
  cache.fetchedAt = Date.now()
  return users
}

/** Cached list (10-min TTL). `force` bypasses the TTL (refresh-on-miss). */
async function cachedUserList(force = false): Promise<CrewDeskUserRef[]> {
  const fresh = cache.users && Date.now() - cache.fetchedAt < LIST_TTL_MS
  if (!force && fresh && cache.users) return cache.users
  // Serialize concurrent refreshes.
  if (!cache.inflight) {
    cache.inflight = fetchUserList().finally(() => {
      cache.inflight = null
    })
  }
  return cache.inflight
}

/** Test hook — drop the in-memory list (the next check refetches). */
export function resetUserListCache(): void {
  cache.users = null
  cache.fetchedAt = 0
}

export interface EmailCheckResult {
  status: 'verified' | 'not_found'
  crewdeskUserId: string | null
  checkedAt: string | null
  /** true when answered from the stored 24h-fresh check (no network call). */
  fromStored: boolean
}

function normalized(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * Verify the logged-in user's email against the Crew Desk user list.
 * `allowNetwork: false` (manual mode / badge-only paths) answers from the
 * stored check only and reports not_found WITHOUT any Crew Desk call when
 * nothing is stored.
 */
export async function verifyCrewDeskEmail(
  me: { userId: string; email: string },
  opts: { allowNetwork: boolean } = { allowNetwork: true }
): Promise<EmailCheckResult> {
  const stored = await getUserCrewDeskCheck(me.userId)
  if (stored?.crewdesk_user_id && stored.crewdesk_checked_at) {
    const age = Date.now() - stored.crewdesk_checked_at.getTime()
    if (age < USER_RECHECK_MS) {
      return {
        status: 'verified',
        crewdeskUserId: stored.crewdesk_user_id,
        checkedAt: stored.crewdesk_checked_at.toISOString(),
        fromStored: true,
      }
    }
  }

  if (!opts.allowNetwork) {
    return { status: 'not_found', crewdeskUserId: null, checkedAt: null, fromStored: false }
  }

  const tcmsEmail = normalized(me.email)

  // First attempt (may hit a fresh or cached list)…
  let users = await cachedUserList()
  let match = users.find((u) => u.email === tcmsEmail)
  // …refresh ONCE when not found so a stale cache can never reject someone.
  if (!match) {
    users = await cachedUserList(true)
    match = users.find((u) => u.email === tcmsEmail)
  }

  if (!match) {
    return { status: 'not_found', crewdeskUserId: null, checkedAt: null, fromStored: false }
  }

  const checkedAt = await saveUserCrewDeskCheck(me.userId, match.id)
  return { status: 'verified', crewdeskUserId: match.id, checkedAt: checkedAt.toISOString(), fromStored: false }
}

/**
 * Guard used before posting in test/live modes: throws the product-defined
 * error when the linker's email is not found (NOTHING is sent to Crew Desk).
 */
export async function assertEmailVerifiedBeforePosting(me: {
  userId: string
  email: string
}): Promise<EmailCheckResult> {
  const result = await verifyCrewDeskEmail(me, { allowNetwork: true })
  if (result.status !== 'verified') {
    throw new CrewDeskError('email_check', EMAIL_NOT_FOUND_MESSAGE)
  }
  return result
}

/** Drop the cached assignable-user list. Called when users change (create /
 *  update) so the posting-time email check never serves a stale roster —
 *  without it a renamed/deactivated user could pass/fail the check for up to
 *  LIST_TTL_MS (10 min) on cached data. */
export function clearIdentityCache(): void {
  cache.users = null
  cache.fetchedAt = 0
  cache.inflight = null
}
