// Role-based permission engine — 6-role hierarchy with a VP-togglable matrix.
//
// HOW IT WORKS (clean, no module-level access):
//   1. DEFAULT_PERMISSIONS defines the sane default per role (below).
//   2. Overrides live in the `role_permissions` table (one row per toggled
//      cell) — the VP can enable/disable ANY action for ANY role at runtime
//      ("someone wants edit? just enable it").
//   3. `can(role, action)` is SYNC for the 15+ existing call sites: it reads
//      an in-memory override cache. The cache lazy-loads from the database
//      on first use and refreshes at most every PERMISSION_CACHE_TTL_MS.
//      Toggling a permission invalidates the cache immediately on the
//      instance that handled the update; other instances converge within
//      the TTL (3s — small enough that a VP toggle feels instant to every
//      user, cheap enough because reloads are one tiny indexed SELECT).
//
// Roles are pure role-based: no per-module grants anywhere in the system.

import { PERMISSION_ACTIONS, type PermissionAction, type PermissionToggle, type Role } from '@/types'
import {
  listRolePermissionOverrides,
  type RolePermissionOverride,
} from '@/lib/server/role-permission.repository'

// ---------- Hierarchy (highest -> lowest) ----------

export const ROLE_HIERARCHY: Record<Role, number> = {
  vp: 5,
  manager: 4,
  product: 3,
  developer: 2,
  qa_engineer: 1,
  viewer: 0,
}

// ---------- Defaults (every cell is togglable at runtime) ----------

export const DEFAULT_PERMISSIONS: Record<Role, PermissionAction[]> = {
  vp: [...PERMISSION_ACTIONS],
  manager: [
    'create_module', 'edit_module', 'create_test_case',
    'edit_own_test_case', 'edit_any_test_case', 'delete_test_case',
    'submit_review', 'perform_review', 'create_bug', 'delete_bug',
    'assign_bug', 'create_task_report', 'view_all_task_reports',
    'view_activity_logs', 'manage_integrations', 'manage_users',
    // Wiki mirrors the test-case matrix exactly (owner requirement:
    // "same permissions of delete all test cases").
    'create_wiki_doc', 'edit_own_wiki_doc', 'edit_any_wiki_doc', 'delete_wiki_doc',
  ],
  product: [
    'create_module', 'edit_module', 'create_test_case',
    'edit_own_test_case', 'submit_review', 'perform_review',
    'create_bug', 'create_task_report', 'view_all_task_reports',
    'view_activity_logs',
    'create_wiki_doc', 'edit_own_wiki_doc',
  ],
  developer: ['create_bug', 'create_task_report'],
  qa_engineer: [
    'create_test_case', 'edit_own_test_case', 'submit_review',
    'create_bug', 'create_task_report',
    'create_wiki_doc', 'edit_own_wiki_doc',
  ],
  viewer: [],
}

// ---------- Override cache (raw-SQL backed) ----------

// 3s: the max window a toggle can stay invisible to another process/route
// instance. Every requireUser() also refreshes (TTL-gated), so in practice
// the very next request after a toggle already sees the new matrix.
const PERMISSION_CACHE_TTL_MS = 3_000

// One cache per process on globalThis, so every route module copy sees the
// same matrix (a toggle reloads it for all routes at once). `generation` is
// bumped by every toggle: a load that STARTED before the toggle is thrown away
// instead of putting the old matrix back. Chaos test 2026-10-22.
interface PermissionCacheState {
  overrides: Map<string, boolean>
  loadedAt: number
  generation: number
  loadPromise: Promise<void> | null
  loadGeneration: number
}
const globalForPermissions = globalThis as unknown as { tcmsPermissionCache?: PermissionCacheState }
const cache: PermissionCacheState =
  globalForPermissions.tcmsPermissionCache ??
  (globalForPermissions.tcmsPermissionCache = { overrides: new Map(), loadedAt: 0, generation: 0, loadPromise: null, loadGeneration: -1 })

function cacheKey(role: string, action: string): string {
  return `${role}:${action}`
}

/** Swaps in a freshly read matrix — unless a toggle happened while it was read. */
function commitOverrides(rows: RolePermissionOverride[], generation: number): void {
  if (generation !== cache.generation) return
  cache.overrides = new Map(rows.map((row) => [cacheKey(row.role, row.action), row.enabled]))
  cache.loadedAt = Date.now()
}

async function loadOverrides(generation: number): Promise<void> {
  commitOverrides(await listRolePermissionOverrides(), generation)
}

/** Called before any auth decision that can afford async work (login, me). */
export async function ensurePermissionsLoaded(force = false): Promise<void> {
  if (!force && cache.loadedAt > 0 && Date.now() - cache.loadedAt < PERMISSION_CACHE_TTL_MS) return
  // Join a load only when it started after the latest toggle.
  if (!cache.loadPromise || cache.loadGeneration !== cache.generation) {
    const generation = cache.generation
    const promise: Promise<void> = loadOverrides(generation)
      .catch(() => {
        // Cache load failure is non-fatal: the last known matrix stays in effect.
      })
      .finally(() => {
        if (cache.loadPromise === promise) cache.loadPromise = null
      })
    cache.loadPromise = promise
    cache.loadGeneration = generation
  }
  await cache.loadPromise
}

/** Invalidates immediately — called by the permissions service after a toggle.
 *  Keeps the last known overrides (never falls back to bare defaults for the
 *  other cells) and makes every in-flight load stale; the caller then forces a
 *  reload, and `can()` reloads in the background until it lands. */
export function invalidatePermissionCache(): void {
  cache.generation++
  cache.loadedAt = 0
}

// ---------- The decision function (sync, used everywhere) ----------

export function can(role: string, action: PermissionAction): boolean {
  if (cache.loadedAt === 0) {
    // Cold or invalidated cache: serve the last known matrix (defaults when
    // cold) and warm the cache in the background (converges within one request).
    void ensurePermissionsLoaded()
  }
  const override = cache.overrides.get(cacheKey(role, action))
  if (override !== undefined) return override
  return (DEFAULT_PERMISSIONS[role as Role] ?? []).includes(action)
}

/** The full effective matrix for one role — used by login/me and the UI. */
export function effectivePermissionsFor(role: string): PermissionAction[] {
  return PERMISSION_ACTIONS.filter((action) => can(role, action))
}

/** Authoritative variant for SESSION ISSUANCE (login / register / me):
 *  re-reads the override table on every call instead of trusting the
 *  instance cache, so a toggle made in any process instance is reflected
 *  in the very next session. Also refreshes the local cache as a bonus. */
export async function effectivePermissionsFresh(role: string): Promise<PermissionAction[]> {
  const generation = cache.generation
  const rows = await listRolePermissionOverrides()
  commitOverrides(rows, generation)
  const fresh = new Map(rows.map((row) => [cacheKey(row.role, row.action), row.enabled]))
  return PERMISSION_ACTIONS.filter((action) => {
    const override = fresh.get(cacheKey(role, action))
    return override ?? (DEFAULT_PERMISSIONS[role as Role] ?? []).includes(action)
  })
}

/** True when the role holds AT LEAST ONE of the actions (feature-level gates
 *  that span two actions, e.g. Reviews = perform_review OR submit_review). */
export function canAny(role: string, actions: PermissionAction[]): boolean {
  return actions.some((action) => can(role, action))
}

/** The full effective matrix for every role — /api/permissions GET shape. */
export function effectiveMatrix(): PermissionToggle[] {
  const toggles: PermissionToggle[] = []
  for (const role of Object.keys(ROLE_HIERARCHY)) {
    for (const action of PERMISSION_ACTIONS) {
      const override = cache.overrides.get(cacheKey(role, action))
      toggles.push({
        role: role as Role,
        action,
        enabled: override ?? DEFAULT_PERMISSIONS[role as Role]?.includes(action) ?? false,
        source: override === undefined ? 'default' : 'override',
      })
    }
  }
  return toggles
}
