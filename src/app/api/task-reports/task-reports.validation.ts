// Validation layer for the task-reports resource.
// One dedicated validator per controller action; each THROWS the standard
// 400 ApiError so controllers stay thin and bad input never reaches services.

import { z } from 'zod'
import { ApiError, flattenZodError } from '@/lib/api'

/** A work-log entry: description is required, minutes bounded to one day,
 *  entity links are optional plain ids, linkUrl is an optional external URL
 *  (empty string = cleared). Bounds keep one bad client (or a script) from
 *  storing megabytes of text or nonsense minute counts. */
export const taskItemSchema = z.object({
  description: z.string().min(1, 'description is required').max(500),
  timeSpentMinutes: z
    .number()
    .int()
    .min(0)
    .max(1440, 'timeSpentMinutes cannot exceed one day (1440)'),
  moduleId: z.string().nullable().optional(),
  testCaseId: z.string().nullable().optional(),
  bugId: z.string().nullable().optional(),
  status: z.enum(['done', 'in_progress', 'blocked']),
  linkUrl: z
    .string()
    .trim()
    .max(500, 'linkUrl cannot exceed 500 characters')
    .refine((v) => v === '' || /^https?:\/\/\S+$/.test(v), 'linkUrl must be a valid http(s) URL')
    .nullable()
    .optional(),
})

// Legacy upsert body. `reportDate` now additionally must be date-parseable
// (legacy crashed with a 500 on garbage dates — task-prescribed validation).
// `tasks` has a CREATE default. Under zod 4, `.partial()` keeps `.default()`, so the
// update schema re-declares it as optional (deep-test T1-4: PUT {notes} wiped tasks).
const tasksField = z.array(taskItemSchema).max(100, 'a report holds at most 100 tasks')

export const upsertTaskReportSchema = z.object({
  reportDate: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), 'reportDate must be a valid date'),
  tasks: tasksField.default([]),
  notes: z.string().max(4000).optional(),
})

export const updateTaskReportSchema = upsertTaskReportSchema.partial().extend({ tasks: tasksField.optional() })

export type UpsertTaskReportInput = z.infer<typeof upsertTaskReportSchema>
export type UpdateTaskReportInput = z.infer<typeof updateTaskReportSchema>

function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw ApiError.badRequest('Invalid input', flattenZodError(parsed.error))
  return parsed.data
}

export function validateUpsertTaskReportBody(body: unknown) {
  return parseOrThrow(upsertTaskReportSchema, body)
}

export function validateUpdateTaskReportBody(body: unknown) {
  return parseOrThrow(updateTaskReportSchema, body)
}
