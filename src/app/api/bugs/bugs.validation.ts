// Validation layer for the bugs resource.
// One dedicated validator per controller action; each THROWS the standard
// 400 ApiError so controllers stay thin and bad input never reaches services.

import { z } from 'zod'
import { ApiError, flattenZodError } from '@/lib/api'
import { expectedUpdatedAtField } from '@/lib/server/optimistic-lock'

export const createBugSchema = z.object({
  // CAPS (audit 2026-10-09): mirror the test-case limits so no stored field
  // can be used as a multi-megabyte dump target.
  title: z.string().min(1).max(200),
  // Creation requires the essentials: a bug without a description or a
  // module is not actionable. Updates remain partial (see below).
  description: z.string().min(1).max(4_000),
  severity: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
  environment: z.string().max(200).optional(),
  stepsToReproduce: z.string().max(4_000).optional(),
  expectedBehaviour: z.string().max(4_000).optional(),
  actualBehaviour: z.string().max(4_000).optional(),
  moduleId: z.string().min(1).max(64),
  assignedToId: z.string().max(64).optional().nullable(),
  testCaseIds: z.array(z.string().max(64)).max(100).optional(),
})

export const updateBugSchema = createBugSchema.partial().extend({
  status: z.enum(['open', 'in_progress', 'resolved', 'closed', 'wont_fix']).optional(),
  resolvedAt: z.string().nullable().optional(),
  expectedUpdatedAt: expectedUpdatedAtField,
})

const linkTestCaseSchema = z.object({ testCaseId: z.string().min(1) })

export type CreateBugInput = z.infer<typeof createBugSchema>
export type UpdateBugInput = z.infer<typeof updateBugSchema>

function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown, message = 'Invalid input'): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw ApiError.badRequest(message, flattenZodError(parsed.error))
  return parsed.data
}

export function validateCreateBugBody(body: unknown) {
  return parseOrThrow(createBugSchema, body)
}

export function validateUpdateBugBody(body: unknown) {
  return parseOrThrow(updateBugSchema, body)
}

/** Legacy error message preserved: a missing/empty testCaseId answered
 *  'Missing testCaseId', not the generic 'Invalid input'. */
export function validateLinkTestCaseBody(body: unknown) {
  return parseOrThrow(linkTestCaseSchema, body, 'Missing testCaseId')
}
