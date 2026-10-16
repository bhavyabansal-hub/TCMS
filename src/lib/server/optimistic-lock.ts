// Optimistic locking for edits (backlog B2): an UPDATE only applies while the row still
// carries the `updated_at` the client loaded. Two users editing the same record can then
// never silently overwrite each other — the second save gets 409 ApiError.staleEdit().
//
// Contract:
//   - The client sends `expectedUpdatedAt` = the `updatedAt` it rendered (ISO string).
//   - Without it (older API callers) the service guards with the value it just read,
//     which still closes the read → write race inside the request.
//   - Repositories add `AND updated_at = ${expected}` and return the affected-row count;
//     0 rows on an existing record = stale → the service throws ApiError.staleEdit().

import { z } from 'zod'

/** Zod field shared by every guarded update body. */
export const expectedUpdatedAtField = z
  .string()
  .datetime({ offset: true, message: 'expectedUpdatedAt must be an ISO date-time' })
  .optional()

/** The `updated_at` value the guarded UPDATE must still find on the row. */
export function resolveExpectedUpdatedAt(clientValue: string | undefined, currentRowValue: Date): Date {
  return clientValue ? new Date(clientValue) : currentRowValue
}
