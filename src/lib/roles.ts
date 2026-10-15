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
