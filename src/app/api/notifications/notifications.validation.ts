// Validation layer for the notifications resource.
//
// HONEST NOTE: the legacy notifications endpoints accept NO request bodies —
// every input arrives via query params (?page, ?pageSize, ?isRead, ?action,
// ?id), so there is no body schema to mirror. The file still exists for layout
// consistency and holds the only validation that is meaningful here:
//   - the "empty actions" guard for POST (?action=read-all is the resource's
//     single action; anything else is the legacy 400 'Unknown action',
//     charter §6.3),
//   - the ?id guard for PATCH/DELETE (legacy 400 'Missing notification id'),
//   - the ?isRead filter normalizer for GET (legacy semantics preserved:
//     any present value maps to `value === 'true'`, so ?isRead=no filters
//     unread notifications exactly like the old route).
// ?page/?pageSize are NOT zod-validated: like the reviews/task-reports waves,
// they flow through the shared getPagination() helper (garbage numbers now
// clamp to the defaults instead of crashing with a NaN skip/take).

import { z } from 'zod'
import { ApiError } from '@/lib/api'

const readAllActionSchema = z.object({ action: z.literal('read-all') })

/** POST ?action=... — the resource has exactly one action; anything else
 *  throws the legacy 'Unknown action' message (NOT 'Invalid input'). */
export function validateReadAllAction(q: Record<string, string>): void {
  const parsed = readAllActionSchema.safeParse(q)
  if (!parsed.success) throw ApiError.badRequest('Unknown action')
}

/** PATCH/DELETE ?id=... — legacy 400 'Missing notification id' when absent. */
export function validateNotificationIdParam(id: string | undefined): string {
  if (!id) throw ApiError.badRequest('Missing notification id')
  return id
}

/** GET ?isRead= — returns undefined when absent, else the legacy boolean. */
const isReadFilterSchema = z
  .string()
  .optional()
  .transform((value) => (value === undefined ? undefined : value === 'true'))

export function validateIsReadFilter(q: Record<string, string>): boolean | undefined {
  return isReadFilterSchema.parse(q.isRead)
}
