// Validation layer for the users resource — one dedicated validator per
// controller action. Validators THROW the standard 400 ApiError so bad input
// never reaches the service.

import { z } from 'zod'
import { ApiError, flattenZodError } from '@/lib/api'

const roleSchema = z.enum(['vp', 'manager', 'product', 'developer', 'qa_engineer', 'viewer'])

const createUserSchema = z.object({
  // trim+toLowerCase parity with register/login (task mysql-backup-1): admin-
  // created accounts normalize emails the same way, so a value like
  // " QA1@TCMS.com " can never create a second identity for qa1@tcms.com.
  email: z.string().trim().toLowerCase().email(),
  fullName: z.string().min(2),
  password: z.string().min(6),
  role: roleSchema,
})

const updateUserSchema = z.object({
  fullName: z.string().min(2).optional(),
  role: roleSchema.optional(),
  isActive: z.boolean().optional(),
  avatarUrl: z.string().nullable().optional(),
})

function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw ApiError.badRequest('Invalid input', flattenZodError(parsed.error))
  return parsed.data
}

export function validateCreateUserBody(body: unknown) {
  return parseOrThrow(createUserSchema, body)
}

export function validateUpdateUserBody(body: unknown) {
  return parseOrThrow(updateUserSchema, body)
}
