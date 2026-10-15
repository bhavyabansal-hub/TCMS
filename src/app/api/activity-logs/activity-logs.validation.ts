// Validation layer for the activity-logs resource.
//
// The legacy endpoint parses no request body — every input is query-derived.
// One dedicated validator per controller action; each THROWS the standard
// 400 ApiError so bad input never reaches services. Kept minimal on purpose:
// plain string filters (userId/entityType/action) need no schema — only inputs
// that can be semantically invalid (identifier params, date-range bounds) are
// validated.

import { z } from 'zod'
import { ApiError, flattenZodError } from '@/lib/api'

const entityActivityQuerySchema = z.object({
  type: z.string().min(1, 'type is required'),
  id: z.string().min(1, 'id is required'),
})

const userActivityQuerySchema = z.object({
  id: z.string().min(1, 'id is required'),
})

/** Date bounds: absent (undefined or legacy empty-string) passes; a garbage
 *  value now 400s instead of the legacy Invalid Date crash. */
const listDateBoundsSchema = z.object({
  dateFrom: optionalDateString('dateFrom'),
  dateTo: optionalDateString('dateTo'),
})

function optionalDateString(field: string) {
  return z
    .string()
    .optional()
    .refine(
      (v) => v === undefined || v === '' || !Number.isNaN(Date.parse(v)),
      `${field} must be a valid date`
    )
}

function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw ApiError.badRequest('Invalid input', flattenZodError(parsed.error))
  return parsed.data
}

/** GET ?action=entity&type=...&id=... — entity feed params. */
export function validateEntityActivityQuery(q: Record<string, string>) {
  return parseOrThrow(entityActivityQuerySchema, q)
}

/** GET ?action=user&id=... — per-user feed params. */
export function validateUserActivityQuery(q: Record<string, string>) {
  return parseOrThrow(userActivityQuerySchema, q)
}

/** GET (paginated list) — gates the date-range bounds; returns the query
 *  unchanged for the service's filter/pagination assembly (all values are
 *  strings by construction — getQueryParams output). */
export function validateActivityLogListQuery(q: Record<string, string>): Record<string, string> {
  parseOrThrow(listDateBoundsSchema, q)
  return q
}
