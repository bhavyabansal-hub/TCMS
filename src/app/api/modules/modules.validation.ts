// Validation layer for the modules resource.
// One dedicated validator per controller action; each THROWS the standard
// 400 ApiError so controllers stay thin and bad input never reaches services.

import { z } from 'zod'
import { ApiError, flattenZodError } from '@/lib/api'
import { expectedUpdatedAtField } from '@/lib/server/optimistic-lock'

const createModuleSchema = z.object({
  // CAPS (audit 2026-10-09): consistent with test-cases/bugs.
  name: z.string().min(1).max(120),
  description: z.string().max(2_000).optional(),
  parentId: z.string().max(64).optional().nullable(),
  // ownerId is intentionally NOT accepted from the client — the creator is
  // always the owner (legacy rule, enforced by the service).
})

const updateModuleSchema = z.object({
  // Legacy accepted any typeof-string values here (including an empty name),
  // so no min(1) — behavior preservation over stricter validation.
  name: z.string().max(120).optional(),
  description: z.string().max(2_000).optional(),
  ownerId: z.string().max(64).optional(),
  expectedUpdatedAt: expectedUpdatedAtField,
})

const submitModuleReviewSchema = z.object({
  reviewerId: z.string().optional(),
  dueDate: z
    .string()
    .optional()
    .refine((v) => v === undefined || !Number.isNaN(Date.parse(v)), 'dueDate must be a valid date'),
  // If true, include test cases from all descendant submodules too.
  includeSubmodules: z.boolean().default(true),
})

function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw ApiError.badRequest('Invalid input', flattenZodError(parsed.error))
  return parsed.data
}

export function validateCreateModuleBody(body: unknown) {
  return parseOrThrow(createModuleSchema, body)
}

export function validateUpdateModuleBody(body: unknown) {
  return parseOrThrow(updateModuleSchema, body)
}

export function validateSubmitModuleReviewBody(body: unknown) {
  return parseOrThrow(submitModuleReviewSchema, body)
}
