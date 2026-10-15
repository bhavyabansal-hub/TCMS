'use client'

import { toast } from 'sonner'

// Standardised API error handling.
// Use this in every catch block instead of repeating
//   `toast.error(err instanceof Error ? err.message : 'Failed')`
//
// The API client throws errors with `.status` and `.data` attached
// (see src/lib/client/api.ts → ApiError). We map common statuses to
// user-friendly messages so the UX is consistent everywhere.

interface ApiErrorLike extends Error {
  status?: number
  data?: { error?: string; details?: unknown }
}

export function getApiErrorMessage(err: unknown, fallback = 'Something went wrong'): string {
  const e = err as ApiErrorLike
  if (!e) return fallback
  // Network errors / aborted requests
  if (e.name === 'TypeError' && /fetch/i.test(e.message)) {
    return 'Network error — please check your connection.'
  }
  // Server-provided message
  if (e.data?.error) return e.data.error
  if (e.message && e.message !== 'Failed') return e.message
  // Status-based fallback
  switch (e.status) {
    case 400:
      return 'Invalid input. Please check your entries.'
    case 401:
      return 'Your session has expired. Please sign in again.'
    case 403:
      return 'You do not have permission to do this.'
    case 404:
      return 'This item no longer exists.'
    case 500:
      return 'Server error. Please try again in a moment.'
    default:
      return fallback
  }
}

export function handleApiError(err: unknown, fallback = 'Something went wrong'): void {
  toast.error(getApiErrorMessage(err, fallback))
}

// For mutations where we want a custom success message too.
export function handleMutation(
  promise: Promise<unknown>,
  opts: { success: string; fallbackError?: string }
): Promise<boolean> {
  return promise
    .then(() => {
      toast.success(opts.success)
      return true
    })
    .catch((err) => {
      handleApiError(err, opts.fallbackError ?? 'Operation failed')
      return false
    })
}
