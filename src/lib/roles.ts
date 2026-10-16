import type { Role } from '@/types'

/**
 * Single source of truth for the six TCMS roles.
 * Every role picker in the app (register form, invite dialog, user-table
 * role editor) must render from this constant — never duplicate the list.
 */
export const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: 'vp', label: 'VP' },
  { value: 'manager', label: 'Manager' },
  { value: 'product', label: 'Product' },
  { value: 'developer', label: 'Developer' },
  { value: 'qa_engineer', label: 'QA Engineer' },
  { value: 'viewer', label: 'Viewer' },
]

/** Role every manage_users holder may grant when creating an account (least privilege). */
export const DEFAULT_INVITE_ROLE: Role = 'viewer'

/**
 * Role-assignment rule (owner, 2026-10-16, deep-test R2-3): only a VP may set or
 * change roles — any role on create other than DEFAULT_INVITE_ROLE, and every role
 * change on edit. Nobody may change their own role (enforced in users.service).
 * Shared by the users service (the law) and the Users page (UX).
 */
export function canAssignRoles(actorRole: Role | string): boolean {
  return actorRole === 'vp'
}
