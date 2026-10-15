'use client'

import type { QueryClient } from '@tanstack/react-query'

// CENTRAL MUTATION INVALIDATION (owner speed requirement 2026-10-09):
// "suppose I add a test case then it should update properly everywhere very
// fast — even when I switch the tab I can see the updated cases."
//
// Strategy: after ANY mutation, invalidate every query ROOT that displays
// that domain (directly or through counts). Invalidation marks inactive
// queries stale (they refetch in the background on their next mount — cached
// content paints INSTANTLY, no skeleton) and refetches active ones silently.
// One contract, applied by every view, so no tab can ever show stale rows
// after a create/update/delete anywhere else.

/** Which entity a mutation touched. */
export type MutationDomain =
  | 'testCases'
  | 'modules'
  | 'reviews'
  | 'moduleReviews'
  | 'bugs'
  | 'tasks'
  | 'users'
  | 'crewdesk'
  | 'notifications'
  | 'permissions'
  | 'wiki'

/** Query-key ROOTS that render each domain's data. Roots are prefixes —
 *  invalidating ['test-cases'] covers list + detail + history + reviews. */
const DOMAIN_ROOTS: Record<MutationDomain, string[]> = {
  testCases: ['test-cases', 'modules', 'stats', 'reviews', 'activity-logs', 'activity'],
  modules: ['modules', 'test-cases', 'stats', 'module-reviews', 'reviews', 'activity-logs', 'activity'],
  reviews: ['reviews', 'module-reviews', 'test-cases', 'stats', 'activity-logs', 'activity'],
  moduleReviews: ['module-reviews', 'reviews', 'test-cases', 'modules', 'stats', 'activity-logs', 'activity'],
  bugs: ['bugs', 'stats', 'activity-logs', 'activity'],
  tasks: ['task-reports', 'stats', 'activity-logs', 'activity'],
  users: ['users', 'stats', 'activity-logs', 'activity'],
  crewdesk: ['crewdesk', 'activity-logs', 'activity'],
  notifications: ['notifications'],
  permissions: ['permissions'],
  wiki: ['wiki', 'activity-logs', 'activity'],
}

/**
 * Invalidate every query root affected by the given mutation domains.
 * Pass one or more domains; roots are deduped, so overlapping domains
 * (e.g. a module review touching tests AND reviews) cost nothing extra.
 *
 * Active queries refetch immediately (background, no spinner — the views
 * render cached data via keepPreviousData / stale-while-revalidate).
 * Inactive queries are marked stale + refetch on next mount, so switching
 * tabs always shows fresh data without a loading flash.
 */
export function invalidateAfterMutation(qc: QueryClient, ...domains: MutationDomain[]): void {
  const roots = new Set<string>()
  for (const domain of domains) {
    for (const root of DOMAIN_ROOTS[domain]) roots.add(root)
  }
  for (const root of roots) {
    void qc.invalidateQueries({ queryKey: [root] })
  }
}
