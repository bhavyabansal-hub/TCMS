// Validation layer for the test-cases resource.
// One dedicated validator per controller action; each THROWS the standard
// 400 ApiError so controllers stay thin and bad input never reaches services.

import { z } from 'zod'
import { idField, optionalIdField } from '@/lib/server/id-field'
import { ApiError, flattenZodError } from '@/lib/api'
import { expectedUpdatedAtField } from '@/lib/server/optimistic-lock'

// Fields with a CREATE default. Under zod 4, `.partial()` keeps `.default()`, so the
// update schema re-declares them as plain optionals (deep-test T1-3: a partial PUT
// reset priority to P2 and tags to []).
const priorityField = z.enum(['P0', 'P1', 'P2', 'P3'])
const tagsField = z.array(z.string().max(40)).max(10)

const createTestCaseSchema = z.object({
  // title + module + description are the required core of every test case;
  // everything else is optional so creation stays fast. NOTE: the update
  // schema derives via .partial(), so edits keep working with legacy rows
  // whose description/module were never set.
  // CAPS (audit 2026-10-09): these fields used to be length-unbounded — a
  // single request could store a 60 MB title (and duplicate it into the
  // activity log). The caps mirror the DB-friendly limits used by the UI.
  moduleId: idField('Module is required'),
  title: z.string().min(1, 'Title is required').max(200),
  description: z.string().min(1, 'Description is required').max(2_000),
  preconditions: z.string().max(2_000).optional(),
  expectedResult: z.string().max(2_000).optional(),
  priority: priorityField.default('P2'),
  tags: tagsField.default([]),
  assigneeId: optionalIdField('Invalid assignee'),
})

const updateTestCaseSchema = createTestCaseSchema.partial().extend({
  priority: priorityField.optional(),
  tags: tagsField.optional(),
  expectedUpdatedAt: expectedUpdatedAtField,
})

const submitReviewSchema = z.object({
  reviewerId: optionalIdField('Invalid reviewer'),
  dueDate: z
    .string()
    .optional()
    .nullable()
    .refine(
      (v) => v == null || !Number.isNaN(Date.parse(v)),
      'dueDate must be a valid date',
    ),
})

/** Import: the body carries the target module plus the raw CSV document.
 *  Row-level correctness (title present, priority enum, step format) is the
 *  service's job — here we only guarantee the REQUEST itself is sound. */
const importTestCasesSchema = z.object({
  moduleId: idField('Choose the module or submodule to import into'),
  fileName: z
    .string()
    .refine((v) => v.toLowerCase().endsWith('.csv'), 'Only .csv files can be imported'),
  csv: z
    .string()
    .min(1, 'The CSV file is empty')
    .max(1_000_000, 'The CSV file is too large (max 1 MB)'),
})

function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw ApiError.badRequest('Invalid input', flattenZodError(parsed.error))
  return parsed.data
}

export function validateCreateTestCaseBody(body: unknown) {
  return parseOrThrow(createTestCaseSchema, body)
}

export function validateUpdateTestCaseBody(body: unknown) {
  return parseOrThrow(updateTestCaseSchema, body)
}

export function validateSubmitReviewBody(body: unknown) {
  return parseOrThrow(submitReviewSchema, body)
}

export function validateImportTestCasesBody(body: unknown) {
  return parseOrThrow(importTestCasesSchema, body)
}

// DELETE ?action=bulk-delete — the ids of the selected test cases.
const bulkDeleteSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, 'Select at least one test case to delete'),
})

export function validateBulkDeleteBody(body: unknown) {
  return parseOrThrow(bulkDeleteSchema, body)
}

export type BulkDeleteInput = z.infer<typeof bulkDeleteSchema>

// GET ?action=options — the light picker list (id + title only).
export const OPTIONS_MAX_LIMIT = 500
const optionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(OPTIONS_MAX_LIMIT).default(OPTIONS_MAX_LIMIT),
})

export function validateTestCaseOptionsQuery(query: unknown) {
  return parseOrThrow(optionsQuerySchema, query)
}
