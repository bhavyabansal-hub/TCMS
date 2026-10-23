// URL route map — the single source of truth linking ViewKey <-> URL paths.
//
// Every page is a real URL now: `navigate(view, params)` pushes the mapped
// path through the Next router (shareable links, back/forward, bookmarks),
// and `viewFromPath` derives the active view + params back from a pathname
// (used by RouteSync on every URL change: deep links, browser navigation).

import type { ViewKey } from '@/store'

type PathBuilder = (params: Record<string, string>) => string

const PATHS: Record<ViewKey, PathBuilder> = {
  dashboard: () => '/dashboard',
  modules: () => '/modules',
  'test-cases': () => '/test-cases',
  'test-case-detail': (p) => (p.id ? `/test-cases/${p.id}` : '/test-cases'),
  reviews: () => '/reviews',
  'review-detail': (p) => (p.id ? `/reviews/${p.id}` : '/reviews'),
  'module-review-detail': (p) => (p.id ? `/module-reviews/${p.id}` : '/reviews'),
  'module-detail': (p) => (p.id ? `/modules/${p.id}` : '/modules'),
  integrations: () => '/integrations',
  wiki: () => '/wiki',
  'wiki-doc': (p) => (p.id ? `/wiki/${p.id}` : '/wiki'),
  bugs: () => '/bugs',
  tasks: () => '/tasks',
  reports: () => '/reports',
  'activity-log': () => '/activity-log',
  notifications: () => '/notifications',
  'settings-users': () => '/settings/users',
  'settings-permissions': () => '/settings/permissions',
  'settings-profile': () => '/settings/profile',
}

/** Builds the URL for a view. `id` is consumed by the path builder; any other
 * params (moduleId, status, priority, q) become a shareable query string, e.g.
 * /test-cases?moduleId=… so list pages can be deep-linked with filters on. */
export function pathForView(view: ViewKey, params: Record<string, string> = {}): string {
  const base = (PATHS[view] ?? PATHS.dashboard)(params)
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (key !== 'id' && value) query.set(key, value)
  }
  const qs = query.toString()
  return qs ? `${base}?${qs}` : base
}

// Ordered so literal segments always win over :id captures of the same prefix.
const ROUTE_PATTERNS: Array<{ pattern: RegExp; view: ViewKey }> = [
  { pattern: /^\/dashboard\/?$/, view: 'dashboard' },
  { pattern: /^\/modules\/?$/, view: 'modules' },
  { pattern: /^\/modules\/([^/]+)\/?$/, view: 'module-detail' },
  { pattern: /^\/integrations\/?$/, view: 'integrations' },
  { pattern: /^\/test-cases\/?$/, view: 'test-cases' },
  { pattern: /^\/test-cases\/([^/]+)\/?$/, view: 'test-case-detail' },
  { pattern: /^\/reviews\/?$/, view: 'reviews' },
  { pattern: /^\/reviews\/([^/]+)\/?$/, view: 'review-detail' },
  { pattern: /^\/module-reviews\/([^/]+)\/?$/, view: 'module-review-detail' },
  { pattern: /^\/wiki\/?$/, view: 'wiki' },
  { pattern: /^\/wiki\/([^/]+)\/?$/, view: 'wiki-doc' },
  { pattern: /^\/bugs\/?$/, view: 'bugs' },
  { pattern: /^\/tasks\/?$/, view: 'tasks' },
  { pattern: /^\/reports\/?$/, view: 'reports' },
  { pattern: /^\/activity-log\/?$/, view: 'activity-log' },
  { pattern: /^\/notifications\/?$/, view: 'notifications' },
  { pattern: /^\/settings\/users\/?$/, view: 'settings-users' },
  { pattern: /^\/settings\/permissions\/?$/, view: 'settings-permissions' },
  { pattern: /^\/settings\/profile\/?$/, view: 'settings-profile' },
]

/** Query-string keys that survive into view params (allowlist — anything else
 * in the URL is ignored so foreign query params can never poison the store). */
const QUERY_PARAM_KEYS = ['moduleId', 'status', 'priority', 'q'] as const

/** Derives {view, params} from a pathname (+ optional query string); null for
 * unknown routes. Query params merge AFTER the path id so deep links like
 * /test-cases?moduleId=… land on the list page pre-filtered. */
export function viewFromPath(
  pathname: string,
  search = ''
): { current: ViewKey; params: Record<string, string> } | null {
  for (const { pattern, view } of ROUTE_PATTERNS) {
    const m = pathname.match(pattern)
    if (!m) continue
    const params: Record<string, string> = m[1] ? { id: decodeURIComponent(m[1]) } : {}
    const sp = new URLSearchParams(search)
    for (const key of QUERY_PARAM_KEYS) {
      const value = sp.get(key)
      if (value) params[key] = value
    }
    return { current: view, params }
  }
  return null
}

/** Sidebar section a view belongs to — detail pages highlight their list item. */
const SECTION_OF: Partial<Record<ViewKey, ViewKey>> = {
  'test-case-detail': 'test-cases',
  'review-detail': 'reviews',
  'module-review-detail': 'reviews',
  'module-detail': 'modules',
  'wiki-doc': 'wiki',
}

export function sectionOf(view: ViewKey): ViewKey {
  return SECTION_OF[view] ?? view
}

// ---------- Router bridge ----------
// The zustand store lives outside React, so the Next router instance is
// handed over once by <RouteSync /> and navigate() delegates URL pushes to it.

type RouterBridge = { push: (path: string) => void }

let bridge: RouterBridge | null = null

export function setRouterBridge(next: RouterBridge | null): void {
  bridge = next
}

export function routerPush(path: string): void {
  if (bridge) bridge.push(path)
}

// ---------- Post-login destination ----------
// Shared by the login page and the auth form so both always navigate to the
// SAME target (no redirect race). Only same-origin relative paths are
// accepted: scheme-relative "//host" is an open redirect, "/login" itself
// would loop, and anything longer than 512 chars is abuse.

export function safeNextPath(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/login')) {
    return '/dashboard'
  }
  // Browsers read "\" as "/" and drop tabs/newlines, so "/\evil.com" or "/\t/evil.com"
  // would leave the site (security test 2026-10-17). Only plain same-origin paths pass.
  if (/[\\\s\u0000-\u001f\u007f]/.test(raw)) return '/dashboard'
  try {
    const base = 'http://tcms.invalid'
    if (new URL(raw, base).origin !== base) return '/dashboard'
  } catch {
    return '/dashboard'
  }
  return raw.slice(0, 512)
}

/** Reads the sanitized ?next= from the current URL (client-side only). */
export function nextFromLocation(): string {
  if (typeof window === 'undefined') return '/dashboard'
  return safeNextPath(new URLSearchParams(window.location.search).get('next'))
}
