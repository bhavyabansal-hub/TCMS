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

const overrides = new Map<string, boolean>()
let loadedAt = 0
let loadPromise: Promise<void> | null = null

function cacheKey(role: string, action: string): string {
  return `${role}:${action}`
}

async function loadOverrides(): Promise<void> {
  const rows: RolePermissionOverride[] = await listRolePermissionOverrides()
  overrides.clear()
  for (const row of rows) overrides.set(cacheKey(row.role, row.action), row.enabled)
  loadedAt = Date.now()
}

/** Called before any auth decision that can afford async work (login, me). */
export async function ensurePermissionsLoaded(force = false): Promise<void> {
  if (!force && loadedAt > 0 && Date.now() - loadedAt < PERMISSION_CACHE_TTL_MS) return
  if (!loadPromise) {
    loadPromise = loadOverrides()
      .catch(() => {
        // Cache load failure is non-fatal: defaults remain in effect.
      })
      .finally(() => {
        loadPromise = null
      })
  }
  await loadPromise
}

/** Invalidates immediately — called by the permissions service after a toggle.
 *  MUST also drop the stale override rows: keeping them would make `can()`
  *  keep serving the pre-toggle answer forever (loadedAt=0 alone never
 *  triggers a reload once the map is non-empty). */
export function invalidatePermissionCache(): void {
  loadedAt = 0
  overrides.clear()
}

// ---------- The decision function (sync, used everywhere) ----------

export function can(role: string, action: PermissionAction): boolean {
  if (loadedAt === 0) {
    // Cold or invalidated cache: serve defaults immediately and warm the
    // cache in the background (converges within one request).
    void ensurePermissionsLoaded()
  }
  const override = overrides.get(cacheKey(role, action))
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
  const rows = await listRolePermissionOverrides()
  overrides.clear()
  for (const row of rows) overrides.set(cacheKey(row.role, row.action), row.enabled)
  loadedAt = Date.now()
  return PERMISSION_ACTIONS.filter((action) => {
    const override = overrides.get(cacheKey(role, action))
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
      const override = overrides.get(cacheKey(role, action))
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
