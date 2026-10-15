import type { ViewKey } from '@/store'

/**
 * Maps an activity-log / notification entity to the view that shows it.
 * Single source of truth shared by the Activity Log and Notifications views;
 * `navigate` is injected so this stays a pure, testable mapping.
 */
export function navigateForEntity(
  entityType: string | null,
  entityId: string | null,
  navigate: (view: ViewKey, params?: Record<string, string>) => void
): void {
  if (!entityId || !entityType) return
  switch (entityType) {
    case 'test_case':
      navigate('test-case-detail', { id: entityId })
      break
    case 'bug':
      navigate('bugs')
      break
    case 'module':
      navigate('modules')
      break
    case 'review':
      navigate('reviews')
      break
    default:
      break
  }
}
