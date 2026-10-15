// Validation layer for the global search endpoint.
// Keeps the query bounded so a user cannot hammer the DB with giant or
// empty (full-table) ILIKE patterns. THROWS the standard 400 ApiError so
// the controller stays thin, matching every other resource's validation.

import { z } from 'zod'
import { ApiError, flattenZodError } from '@/lib/api'

const searchQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(2, 'Query must be at least 2 characters')
    .max(100, 'Query must be at most 100 characters'),
  /** Per-entity result cap — small enough to stay fast, big enough to be useful. */
  limit: z.coerce.number().int().min(1).max(10).default(5),
})

export type SearchQuery = z.infer<typeof searchQuerySchema>

function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown, message = 'Invalid search query'): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw ApiError.badRequest(message, flattenZodError(parsed.error))
  return parsed.data
}

export function validateSearchQuery(params: Record<string, string>): SearchQuery {
  return parseOrThrow(searchQuerySchema, { q: params.q ?? '', limit: params.limit ?? 5 })
}
