// Validation layer for the permissions resource — one dedicated validator
// per controller action. Validators THROW the standard 400 ApiError so bad
// input never reaches the service.

import { z } from 'zod'
import { ApiError, flattenZodError } from '@/lib/api'
import { PERMISSION_ACTIONS, ROLES } from '@/types'

const toggleSchema = z.object({
  role: z.enum(ROLES as unknown as [string, ...string[]]),
  action: z.enum(PERMISSION_ACTIONS as unknown as [string, ...string[]]),
  enabled: z.boolean(),
})

export interface TogglePermissionInput {
  role: string
  action: string
  enabled: boolean
}

/** PUT /api/permissions — toggle one matrix cell. */
export function validateTogglePermissionBody(body: unknown): TogglePermissionInput {
  const parsed = toggleSchema.safeParse(body)
  if (!parsed.success) {
    throw ApiError.badRequest('Invalid input', flattenZodError(parsed.error))
  }
  return parsed.data
}
