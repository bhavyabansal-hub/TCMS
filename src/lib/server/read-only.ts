// Maintenance mode (backlog B5): with TCMS_READ_ONLY=true every API write answers 503
// so the database stays unchanged (backup, migration, incident), while people can still
// sign in and read. Pure module — withApi applies it, scripts/verify-safety.mjs tests it.

export const READ_ONLY_MESSAGE = 'TCMS is in read-only maintenance mode — changes are paused, try again later.'

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
/** Writes that stay open so users can still sign in to read: POST /api/auth?path=… */
const ALLOWED_AUTH_PATHS = new Set(['login', 'refresh', 'logout'])

/** True when this request must be refused while the app is read-only. */
export function isBlockedInReadOnly(method: string, pathname: string, searchParams: URLSearchParams): boolean {
  if (READ_METHODS.has(method.toUpperCase())) return false
  const isAuthSession = pathname === '/api/auth' && method.toUpperCase() === 'POST' && ALLOWED_AUTH_PATHS.has(searchParams.get('path') ?? '')
  return !isAuthSession
}
