// Validation layer for the bugs resource.
// One dedicated validator per controller action; each THROWS the standard
// 400 ApiError so controllers stay thin and bad input never reaches services.

import { z } from 'zod'
import { idField, optionalIdField } from '@/lib/server/id-field'
import { ApiError, flattenZodError } from '@/lib/api'
import { expectedUpdatedAtField } from '@/lib/server/optimistic-lock'

// Fields with a CREATE default. Under zod 4, `.partial()` keeps `.default()`, so the
// update schema re-declares them as plain optionals — an omitted field must never be
// overwritten by its create default (deep-test T1-1: a Kanban drag reset severity).
const bugSeverityField = z.enum(['critical', 'high', 'medium', 'low'])

export const createBugSchema = z.object({
  // CAPS (audit 2026-10-09): mirror the test-case limits so no stored field
  // can be used as a multi-megabyte dump target.
  title: z.string().min(1).max(200),
  // Creation requires the essentials: a bug without a description or a
  // module is not actionable. Updates remain partial (see below).
  description: z.string().min(1).max(4_000),
  severity: bugSeverityField.default('medium'),
  environment: z.string().max(200).optional(),
  stepsToReproduce: z.string().max(4_000).optional(),
  expectedBehaviour: z.string().max(4_000).optional(),
  actualBehaviour: z.string().max(4_000).optional(),
  moduleId: idField(),
  assignedToId: optionalIdField(),
  testCaseIds: z.array(idField()).max(100).optional(),
})

export const updateBugSchema = createBugSchema.partial().extend({
  severity: bugSeverityField.optional(),
  status: z.enum(['open', 'in_progress', 'resolved', 'closed', 'wont_fix']).optional(),
  resolvedAt: z.string().nullable().optional(),
  expectedUpdatedAt: expectedUpdatedAtField,
})

const linkTestCaseSchema = z.object({ testCaseId: idField() })

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

// GET ?action=options — the light picker list (id + title only).
export const BUG_OPTIONS_MAX_LIMIT = 500
const bugOptionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(BUG_OPTIONS_MAX_LIMIT).default(BUG_OPTIONS_MAX_LIMIT),
})

export function validateBugOptionsQuery(query: unknown) {
  return parseOrThrow(bugOptionsQuerySchema, query)
}
