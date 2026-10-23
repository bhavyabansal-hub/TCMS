// Validation layer for the reviews resource.
// One dedicated validator per controller action; each THROWS the standard
// 400 ApiError so controllers stay thin and bad input never reaches services.

import { z } from 'zod'
import { idField } from '@/lib/server/id-field'
import { ApiError, flattenZodError } from '@/lib/api'
import { expectedUpdatedAtField } from '@/lib/server/optimistic-lock'

const verdictSchema = z.object({
  verdict: z.enum(['approved', 'failed', 'needs_revision']),
  comment: z.string().optional(),
  flaggedFields: z.array(z.string()).default([]),
  expectedUpdatedAt: expectedUpdatedAtField,
})

export type VerdictInput = z.infer<typeof verdictSchema>

const forwardSchema = z.object({
  reviewerId: idField('Choose the user to forward this review to'),
  expectedUpdatedAt: expectedUpdatedAtField,
})

export type ForwardInput = z.infer<typeof forwardSchema>

function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw ApiError.badRequest('Invalid input', flattenZodError(parsed.error))
  return parsed.data
}

/** POST /api/reviews?id=... — the verdict a reviewer submits. */
export function validateVerdictBody(body: unknown): VerdictInput {
  return parseOrThrow(verdictSchema, body)
}

/** POST /api/reviews?id=...&action=forward — re-assign the review to another
 *  TCMS user (owner rule 2026-10-09: the approve permission is what lets a
 *  participant forward a request to someone else). */
export function validateForwardBody(body: unknown): ForwardInput {
  return parseOrThrow(forwardSchema, body)
}
