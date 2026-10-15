// Crew Desk validation — zod schemas + param guards for the integrations API.

import { z } from 'zod'
import { ApiError } from '@/lib/api'

export const NOTE_MAX_LENGTH = 300

/**
 * Note sanitizer (product spec): PLAIN TEXT ONLY. Control characters
 * (incl. tabs/newlines/DEL/C1) are removed, whitespace is collapsed, and
 * the result is hard-capped at 300 characters. Runs server-side so the
 * stored note and the posted comment are always clean.
 */
export function sanitizeNote(input: string | null | undefined): string | null {
  if (!input) return null
  const cleaned = input
    .replace(/\u0000-\u0008|\u000B|\u000C|\u000E-\u001F|\u007F|\u0080-\u009F/g, '') // control chars
    .replace(/[\t\r\n]+/g, ' ') // newlines/tabs collapse to spaces
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, NOTE_MAX_LENGTH)
  return cleaned || null
}

/** Crew Desk ticket ids are short opaque tokens (e.g. 1355). */
export const ticketIdSchema = z
  .string()
  .trim()
  .min(1, 'Crew Desk ticket ID is required')
  .max(64, 'Crew Desk ticket ID is too long')
  .regex(/^[A-Za-z0-9_-]+$/, 'Crew Desk ticket ID may only contain letters, digits, dashes and underscores')

/** Manual mode skips Crew Desk entirely, so the ticket id is optional there. */
export const optionalTicketIdSchema = z
  .string()
  .trim()
  .max(64, 'Crew Desk ticket ID is too long')
  .regex(/^[A-Za-z0-9_-]*$/, 'Crew Desk ticket ID may only contain letters, digits, dashes and underscores')
  .default('')

export const linkCreateSchema = z.object({
  moduleId: z.string().trim().min(1, 'Module is required').max(64),
  ticketId: ticketIdSchema,
  // Free text the linker wants visible on the ticket (name/email/anything).
  // Optional; sanitized (control chars removed) and capped at 300 chars.
  note: z.string().max(NOTE_MAX_LENGTH * 4, 'Note is limited to 300 characters').optional().nullable(),
})

export const lookupSchema = z.object({
  ticketId: ticketIdSchema,
})

export const retrySchema = z.object({
  linkId: z.string().trim().uuid('Invalid link id'),
})

export function parseLinkCreate(body: unknown): { moduleId: string; ticketId: string; note: string | null } {
  const parsed = linkCreateSchema.safeParse(body)
  if (!parsed.success) throw ApiError.badRequest('Invalid Crew Desk link payload', parsed.error.flatten())
  return { moduleId: parsed.data.moduleId, ticketId: parsed.data.ticketId, note: sanitizeNote(parsed.data.note) }
}

/** Manual-mode variant: ticket id optional, note sanitized the same way. */
export function parseManualCreate(body: unknown): { moduleId: string; ticketId: string; note: string | null } {
  const schema = linkCreateSchema.extend({ ticketId: optionalTicketIdSchema })
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw ApiError.badRequest('Invalid manual link payload', parsed.error.flatten())
  return { moduleId: parsed.data.moduleId, ticketId: parsed.data.ticketId, note: sanitizeNote(parsed.data.note) }
}

export function parseLookup(body: unknown): { ticketId: string } {
  const parsed = lookupSchema.safeParse(body)
  if (!parsed.success) throw ApiError.badRequest('A Crew Desk ticket ID is required', parsed.error.flatten())
  return parsed.data
}

export function validateRetryLinkId(linkId: string | undefined): string {
  const parsed = retrySchema.safeParse({ linkId: linkId ?? '' })
  if (!parsed.success) throw ApiError.badRequest('A valid link id is required for retry', parsed.error.flatten())
  return parsed.data.linkId
}
