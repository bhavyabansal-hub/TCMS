// Validation layer for the module-reviews resource.
// One dedicated validator per controller action; each THROWS the standard
// 400 ApiError so controllers stay thin and bad input never reaches services.

import { z } from 'zod'
import { ApiError, flattenZodError } from '@/lib/api'

// POST ?id=...&action=approve-all — body is an optional comment. Legacy used a
// `typeof body.comment === 'string'` check with a default text; a missing or
// null comment falls back to that default in the service.
const approveAllSchema = z.object({
  comment: z.string().optional().nullable(),
})

// POST ?id=...&action=bulk-verdict — one verdict for every open case review.
// Comment is optional here (approve has a default text); the SERVICE requires
// a written comment for failed / needs_revision.
const bulkVerdictSchema = z.object({
  verdict: z.enum(['approved', 'failed', 'needs_revision']),
  comment: z.string().optional().nullable(),
})

// POST ?id=...&action=change-reviewer — the new reviewer's user id.
const changeReviewerSchema = z.object({
  reviewerId: z.string().min(1, 'Reviewer is required'),
})

function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw ApiError.badRequest('Invalid input', flattenZodError(parsed.error))
  return parsed.data
}

export function validateApproveAllBody(body: unknown) {
  return parseOrThrow(approveAllSchema, body)
}

export function validateBulkVerdictBody(body: unknown) {
  return parseOrThrow(bulkVerdictSchema, body)
}

export function validateChangeReviewerBody(body: unknown) {
  return parseOrThrow(changeReviewerSchema, body)
}

export type ApproveAllInput = z.infer<typeof approveAllSchema>
export type BulkVerdictInput = z.infer<typeof bulkVerdictSchema>
export type ChangeReviewerInput = z.infer<typeof changeReviewerSchema>
