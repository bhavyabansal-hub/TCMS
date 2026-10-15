// Validation layer for the stats resource.
//
// The stats API has NO request body (legacy parsed none) — its ONLY input is
// the ?action= query parameter. This guard is intentionally minimal and
// honest: the action value must be a string or be absent. Dispatching unknown
// action values is NOT done here — the controller answers 400 'Unknown action'
// (charter §6.3; legacy answered 200 {error}).

import { z } from 'zod'
import { ApiError, flattenZodError } from '@/lib/api'

const statsActionSchema = z.object({
  action: z.string().optional(),
})

export interface StatsActionQuery {
  action?: string
}

export function validateStatsActionQuery(q: Record<string, string>): StatsActionQuery {
  const parsed = statsActionSchema.safeParse(q)
  if (!parsed.success) throw ApiError.badRequest('Invalid input', flattenZodError(parsed.error))
  return parsed.data
}
