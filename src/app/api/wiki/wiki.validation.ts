// Validation layer for the wiki resource (JSON bodies).
// Upload requests arrive as multipart/form-data and are validated in the
// service (file name/size/extension checks need the raw File object).

import { z } from 'zod'
import { ApiError, flattenZodError } from '@/lib/api'

export const createWikiDocSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  // Rich-text HTML from the editor. Sanitized server-side before storage.
  content: z.string().max(2_000_000).optional().default(''),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).optional().default([]),
})

export const updateWikiDocSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().max(2_000_000).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
})

export type CreateWikiDocInput = z.infer<typeof createWikiDocSchema>
export type UpdateWikiDocInput = z.infer<typeof updateWikiDocSchema>

function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown, message = 'Invalid input'): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw ApiError.badRequest(message, flattenZodError(parsed.error))
  return parsed.data
}

export function validateCreateWikiDocBody(body: unknown) {
  return parseOrThrow(createWikiDocSchema, body)
}

export function validateUpdateWikiDocBody(body: unknown) {
  return parseOrThrow(updateWikiDocSchema, body)
}
