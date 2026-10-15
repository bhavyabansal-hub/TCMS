// Validation layer for the auth resource — one dedicated validator per
// controller action. Validators THROW the standard 400 ApiError.

import { z } from 'zod'
import { ApiError, flattenZodError } from '@/lib/api'

const loginSchema = z.object({
  // trim+toLowerCase parity with register (task mysql-backup-1): an email
  // typed as " Admin@TCMS.com " must log in the same account as
  // "admin@tcms.com" — and every lookup (brute-force guard, refresh-token
  // owner, user row) keys off the SAME normalized value.
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
})

// Self-signup (owner decision 2026-10-09, tightened 2026-10-14): every new
// account is created in the least-privileged 'viewer' group. The register
// schema intentionally has NO role field — zod strips unknown keys, so even
// a hand-crafted request carrying role:'vp' can never reach the service
// (which hard-codes the role again, defense in depth). The WHOLE endpoint is
// additionally gated server-side by TCMS_ALLOW_SIGNUP (fail-closed 403 when
// unset/false — see auth.service.ts isSignupAllowed). Only a
// manage_users/permission holder can change roles afterwards (Users
// page -> /api/users PATCH).
const registerSchema = z.object({
  fullName: z.string().trim().min(2, 'Full name is too short').max(80),
  email: z.string().trim().toLowerCase().email(),
  password: z
    .string()
    .min(6, 'Password must be at least 6 characters')
    .regex(/[a-zA-Z]/, 'Password must contain a letter')
    .regex(/[0-9]/, 'Password must contain a number'),
})

const refreshSchema = z.object({
  // The refresh token normally travels in its httpOnly cookie; the body
  // field is optional and exists only for non-browser API consumers.
  refreshToken: z.string().min(1).optional(),
})

const logoutSchema = z.object({
  refreshToken: z.string().optional(),
})

const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1),
  // PARITY with the register policy (audit 2026-10-09): a change could
  // previously downgrade to a 6-char letters-only password that signup
  // itself would reject.
  newPassword: z
    .string()
    .min(6, 'Password must be at least 6 characters')
    .regex(/[a-zA-Z]/, 'Password must contain a letter')
    .regex(/[0-9]/, 'Password must contain a number'),
})

const profileUpdateSchema = z.object({
  fullName: z.string().min(1).optional(),
  avatarUrl: z.string().nullable().optional(),
  telegramChatId: z.string().nullable().optional(),
  notifyEmail: z.boolean().optional(),
  notifyTelegram: z.boolean().optional(),
  notifyInapp: z.boolean().optional(),
})

function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw ApiError.badRequest('Invalid input', flattenZodError(parsed.error))
  return parsed.data
}

export function validateLoginBody(body: unknown) {
  return parseOrThrow(loginSchema, body)
}

export function validateRegisterBody(body: unknown) {
  return parseOrThrow(registerSchema, body)
}

export function validateRefreshBody(body: unknown) {
  return parseOrThrow(refreshSchema, body)
}

export function validateLogoutBody(body: unknown) {
  return parseOrThrow(logoutSchema, body)
}

export function validatePasswordChangeBody(body: unknown) {
  return parseOrThrow(passwordChangeSchema, body)
}

export function validateProfileUpdateBody(body: unknown) {
  return parseOrThrow(profileUpdateSchema, body)
}
