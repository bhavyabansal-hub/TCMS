// ONE password rule for every place a password is set (owner request 2026-10-23):
// register, Settings -> Users (new account) and Settings -> Profile (change password).
// The server validators AND the forms import it, so the rule and its wording can
// never drift apart again. scripts/lib/first-vp.mjs keeps a stricter copy (12+) for
// the very first VP account, which is created on the server before the app runs.
// Existing passwords keep working: the rule applies when a password is set.

export const PASSWORD_MIN_LENGTH = 10
// bcrypt only reads the first 72 bytes: anything longer would be cut off silently.
export const PASSWORD_MAX_BYTES = 72

/** Short rule text for hints and placeholders. */
export const PASSWORD_RULE_TEXT = `At least ${PASSWORD_MIN_LENGTH} characters, with a letter and a number`

/** First broken rule as a user-facing message, or null when the password is fine. */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES) {
    return `Password is too long (at most ${PASSWORD_MAX_BYTES} bytes)`
  }
  if (!/[a-zA-Z]/.test(password)) return 'Password must contain a letter'
  if (!/[0-9]/.test(password)) return 'Password must contain a number'
  return null
}
