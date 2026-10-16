'use client'

import type {
  User,
  UserOption,
  UserRef,
  Role,
  Module,
  TestCase,
  TestCaseHistory,
  ReviewRequest,
  ModuleReviewRequest,
  Bug,
  TaskReport,
  Notification,
  ActivityLog,
  Paginated,
  DashboardStats,
  ReportsStats,
  ImportTemplate,
  ImportTestCasesResult,
  GlobalSearchResult,
  WikiDocument,
} from '@/types'

// COOKIE-BASED SESSION: the access + refresh tokens live EXCLUSIVELY in
// httpOnly cookies written by the server (src/lib/server/auth-cookies.ts).
// JavaScript never sees them — a successful XSS cannot exfiltrate the session.
// localStorage keeps ONLY the non-sensitive display profile (tcms-user) so a
// boot can paint the shell instantly; the server /me call is the real check.
// Every request carries the `X-Requested-With: tcms` custom header — the CSRF
// proof that the call is first-party (cross-site JS cannot forge it).
const USER_KEY = 'tcms-user'
const CSRF_HEADER = 'X-Requested-With'
const CSRF_VALUE = 'tcms'

/** staleTime for reference data (modules tree, user options): changes only
 *  through user mutations, which already invalidate the owning query roots,
 *  so a longer cache is safe and cuts repeat round trips on every page that
 *  renders an assignment/module picker. */
export const REFERENCE_STALE_TIME_MS = 5 * 60 * 1000

/** Builds a request query string, skipping null/undefined/empty values so
 *  optional filters never arrive as empty `key=` pairs. One shared builder
 *  for every list-style endpoint (DRY — used to be 8 inline copies). */
function qs(params: object = {}): string {
  const sp = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue
    sp.set(key, String(value))
  }
  return sp.toString()
}

export function getStoredUser(): User | null {
  if (typeof window === 'undefined') return null
  const raw = localStorage.getItem(USER_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as User
  } catch {
    return null
  }
}

/** Persists the display profile after login/profile update. */
export function saveUser(user: User): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user))
}

/** Cheap client-side hint that a session MAY exist (cookie is the truth —
 *  the server validates it on boot via /api/auth). */
export function hasSessionHint(): boolean {
  return getStoredUser() !== null
}

/** Drops the local display profile. Cookies themselves are cleared by the
 *  SERVER (httpOnly — JS cannot expire them) via the logout endpoint, or by
 *  the browser once their Max-Age passes. */
export function clearStoredUser(): void {
  localStorage.removeItem(USER_KEY)
}

interface ApiError extends Error {
  status?: number
  data?: unknown
  /** True when the failure is transient (network down / 5xx) — the session
   *  itself is fine and callers must retry rather than discard it. */
  transient?: boolean
}

async function request<T>(
  url: string,
  options: RequestInit = {},
  retry = true
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // CSRF proof: cross-site JS cannot set this without a CORS preflight.
    [CSRF_HEADER]: CSRF_VALUE,
    ...(options.headers as Record<string, string>),
  }

  const res = await fetch(url, { ...options, headers, credentials: 'same-origin' })
  if (res.status === 401 && retry) {
    // Try to refresh (server reads the httpOnly refresh cookie)
    let outcome = await tryRefresh()
    if (outcome.hard) {
      // DEFENSIVE RETRY: a single definitive-looking 401 from the refresh
      // endpoint can still be a one-off glitch (proxy/gateway blip, a token
      // another tab rotated milliseconds ago, a momentary upstream error).
      // Killing the session on ONE signal is exactly the "hard refresh logged
      // me out" bug — so retry the exchange once before declaring death.
      await new Promise((r) => setTimeout(r, 600))
      outcome = await tryRefresh()
    }
    if (outcome.ok) return request<T>(url, options, false)
    if (outcome.hard) {
      // The server DEFINITIVELY rejected the refresh token (revoked / expired
      // / unknown) — the session is genuinely dead. Clear the local profile
      // and route to the login page WITH the current location so re-login
      // returns the user to the page they were on instead of silently
      // dumping them on the dashboard (a plain reload here reads as "I got
      // logged out and lost my place").
      clearStoredUser()
      if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
        const target = `${window.location.pathname}${window.location.search}`
        window.location.assign(`/login?next=${encodeURIComponent(target)}`)
      }
      throw new Error('Session expired')
    }
    // TRANSIENT failure (server unreachable / 5xx): keep the session — the
    // refresh token is still valid. A momentary hiccup while the user hard
    // refreshes must NEVER log them out.
    const err: ApiError = new Error(
      'Could not reach the server to extend your session. You are still signed in — please retry.'
    )
    err.transient = true
    err.status = 503
    throw err
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    // Surface validation details: the server's 400 body carries
    // details.fieldErrors (from zod) — e.g. { password: ['String must contain
    // at least 8 character(s)'] }. Show the first message per field so the
    // user learns exactly WHAT to fix instead of a generic "Invalid input".
    const d = data as {
      error?: string
      details?: { formErrors?: string[]; fieldErrors?: Record<string, string[]> }
    }
    const parts: string[] = []
    for (const [field, msgs] of Object.entries(d.details?.fieldErrors ?? {})) {
      if (msgs?.length) parts.push(`${field.charAt(0).toUpperCase() + field.slice(1)}: ${msgs[0]}`)
    }
    if (d.details?.formErrors?.length) parts.push(...d.details.formErrors)
    const err: ApiError = new Error(parts.length ? `${d.error ?? 'Invalid input'} — ${parts.join(' · ')}` : d.error ?? 'Request failed')
    err.status = res.status
    err.data = data
    throw err
  }
  // Some endpoints return no content
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

interface RefreshOutcome {
  ok: boolean
  /** true  = the server definitively rejected the refresh token → session dead.
   *  false = transient failure (network / 5xx) → safe to retry later. */
  hard: boolean
}

/**
 * Silently extends the session: POST /api/auth?path=refresh with NO body —
 * the server reads the rotating refresh token from its httpOnly cookie and
 * sets the fresh pair back as new cookies. All tabs share the browser's cookie
 * jar, so the old localStorage-based multi-tab rescue is unnecessary: whatever
 * tab refreshes first re-arms the shared cookie for every other tab.
 */
async function exchangeRefreshToken(): Promise<RefreshOutcome> {
  try {
    const res = await fetch('/api/auth?path=refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: CSRF_VALUE },
      credentials: 'same-origin',
      body: '{}',
    })
    if (res.ok) return { ok: true, hard: false }
    if (res.status === 401) {
      // Server definitively rejected the refresh cookie (revoked / expired /
      // unknown) — the session is genuinely dead.
      return { ok: false, hard: true }
    }
    // 5xx / unexpected status — transient, the token itself may be fine.
    return { ok: false, hard: false }
  } catch {
    // Network failure (server down, offline) — transient.
    return { ok: false, hard: false }
  }
}

/** Deduped refresh: concurrent 401 handlers share a single exchange. */
let refreshing: Promise<RefreshOutcome> | null = null
async function tryRefresh(): Promise<RefreshOutcome> {
  if (refreshing) return refreshing
  refreshing = exchangeRefreshToken().finally(() => {
    refreshing = null
  })
  return refreshing
}

/** FormData variant of request() — multipart uploads must NOT carry a
 *  hand-set Content-Type (the browser supplies the boundary). Everything
 *  else (CSRF header, credentials, 401 refresh-and-retry) is identical. */
async function requestForm<T>(url: string, options: RequestInit = {}, retry = true): Promise<T> {
  const headers: Record<string, string> = {
    [CSRF_HEADER]: CSRF_VALUE,
    ...(options.headers as Record<string, string>),
  }
  delete headers['Content-Type']
  const res = await fetch(url, { ...options, headers, credentials: 'same-origin' })
  if (res.status === 401 && retry) {
    const outcome = await tryRefresh()
    if (outcome.ok) return requestForm<T>(url, options, false)
    if (outcome.hard) clearStoredUser()
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    const err: ApiError = new Error((data as { error?: string }).error ?? 'Request failed')
    err.status = res.status
    err.data = data
    throw err
  }
  return res.json() as Promise<T>
}

// ---------- Auth ----------
// NOTE: unlike the pre-cookie era, login/refresh responses carry NO
// tokens — the server sets httpOnly cookies. The body is profile + permissions.
interface AuthSessionResponse {
  user: User
  permissions: string[]
}

export const authApi = {
  // login/logout pass retry=false: a 401 from these endpoints is a genuine
  // credential/revocation answer and must NOT trigger the token refresh path
  // (which would pointlessly rotate a perfectly good refresh token on every
  // wrong-password attempt).
  login: (body: { email: string; password: string }) =>
    request<AuthSessionResponse>('/api/auth?path=login', {
      method: 'POST',
      body: JSON.stringify(body),
    }, false),
  // Self-signup (owner decision 2026-10-09): NO group choice — every new
  // account is created in the least-privileged 'viewer' group server-side;
  // a permission holder promotes roles afterwards from the Users page.
  register: (body: { fullName: string; email: string; password: string }) =>
    request<AuthSessionResponse>('/api/auth?path=register', {
      method: 'POST',
      body: JSON.stringify(body),
    }, false),
  // The server reads the refresh cookie, revokes it and clears BOTH cookies.
  logout: () =>
    request<{ success: boolean }>('/api/auth?path=logout', {
      method: 'POST',
      body: '{}',
    }, false),
  me: () => request<{ user: User; permissions: string[] }>('/api/auth'),
  updateMe: (body: Partial<User>) =>
    request<User>('/api/auth', { method: 'PUT', body: JSON.stringify(body) }),
  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    request<{ success: boolean }>('/api/auth?path=password', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
}

// ---------- Permissions (runtime-togglable role matrix) ----------
export const permissionsApi = {
  matrix: () => request<import('@/types').PermissionToggle[]>('/api/permissions'),
  toggle: (body: { role: string; action: string; enabled: boolean }) =>
    request<import('@/types').PermissionToggle>('/api/permissions', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
}

// ---------- Users ----------
export const usersApi = {
  list: (params: Record<string, string> = {}) =>
    request<Paginated<User>>(`/api/users?${qs(params)}`),
  /** Picker rows for assignment/reviewer dropdowns — any authenticated user. */
  options: () => request<UserOption[]>('/api/users?action=options'),
  create: (body: { email: string; fullName: string; password: string; role: string }) =>
    request<User>('/api/users', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: Partial<User>) =>
    request<User>(`/api/users?id=${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  delete: (id: string) =>
    request<{ success: boolean }>(`/api/users?id=${id}`, { method: 'DELETE' }),
}

// ---------- Modules ----------
/** Optimistic lock (B2): send the `updatedAt` you loaded; a stale save gets 409. */
type Guarded = { expectedUpdatedAt?: string }

/** Builds the nested tree from the flat list the API sends (each module once). */
function buildModuleTree(flat: Module[]): { tree: Module[]; flat: Module[] } {
  const nodes = flat.map((m) => ({ ...m, children: [] as Module[] }))
  const byId = new Map(nodes.map((n) => [n.moduleId, n]))
  const tree: Module[] = []
  for (const node of nodes) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined
    if (parent) parent.children.push(node)
    else tree.push(node)
  }
  return { tree, flat: nodes }
}

export const modulesApi = {
  tree: async () => buildModuleTree((await request<{ flat: Module[] }>('/api/modules')).flat),
  get: (id: string, caseOffset = 0) =>
    request<{ module: Module & { createdBy?: UserRef; updatedBy?: UserRef; permissions?: unknown[] }; testCases: TestCase[]; subtreeTestCases: TestCase[]; submodules: Module[]; casePage: { limit: number; offset: number; total: number; directTotal: number; hasMore: boolean } }>(`/api/modules?id=${id}&caseOffset=${caseOffset}`),
  create: (body: { name: string; description?: string; parentId?: string | null }) =>
    request<Module>('/api/modules', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: Partial<Module> & Guarded) =>
    request<Module>(`/api/modules?id=${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  delete: (id: string) =>
    request<{ success: boolean }>(`/api/modules?id=${id}`, { method: 'DELETE' }),
  // Submit an entire module (with its test cases) for review.
  submitReview: (id: string, body: { reviewerId?: string; dueDate?: string; includeSubmodules?: boolean }) =>
    request<{ moduleReview: import('@/types').ModuleReviewRequest; caseReviewCount: number; testCaseIds: string[] }>(`/api/modules?id=${id}&action=submit-review`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
}

// ---------- Test Cases ----------
export interface TestCaseFilters {
  moduleId?: string
  status?: string
  priority?: string
  authorId?: string
  search?: string
  page?: number
  pageSize?: number
}

/** Light picker rows (GET ?action=options): id + title only. */
export type TestCaseOption = { testCaseId: string; title: string }
export type BugOption = { bugId: string; title: string }

export const testCasesApi = {
  options: () => request<TestCaseOption[]>('/api/test-cases?action=options'),
  list: (filters: TestCaseFilters = {}) =>
    request<Paginated<TestCase>>(`/api/test-cases?${qs(filters)}`),
  get: (id: string) => request<TestCase>(`/api/test-cases?id=${id}`),
  history: (id: string) => request<TestCaseHistory[]>(`/api/test-cases?id=${id}&action=history`),
  reviews: (id: string) => request<ReviewRequest[]>(`/api/test-cases?id=${id}&action=reviews`),
  create: (body: Partial<TestCase> & { title: string }) =>
    request<TestCase>('/api/test-cases', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: Partial<TestCase> & Guarded) =>
    request<TestCase>(`/api/test-cases?id=${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  submitReview: (id: string, body: { reviewerId?: string; dueDate?: string }) =>
    request<ReviewRequest>(`/api/test-cases?id=${id}&action=submit-review`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /** Permanent bulk delete — ticked rows (or the whole page) at once. */
  bulkDelete: (ids: string[]) =>
    request<{ deleted: number; missing: string[] }>('/api/test-cases?action=bulk-delete', {
      method: 'DELETE',
      body: JSON.stringify({ ids }),
    }),
  delete: (id: string) =>
    request<{ success: boolean }>(`/api/test-cases?id=${id}`, { method: 'DELETE' }),
  /** Sample CSV for the Import tab (headers + instructions + examples). */
  importTemplate: () =>
    request<ImportTemplate>('/api/test-cases?action=import-template'),
  /** Bulk-create draft test cases inside one module from a CSV document. */
  importCsv: (body: { moduleId: string; fileName: string; csv: string }) =>
    request<ImportTestCasesResult>('/api/test-cases?action=import', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
}

// ---------- Reviews ----------
export const reviewsApi = {
  queue: () => request<ReviewRequest[]>('/api/reviews?action=queue'),
  list: (params: Record<string, string> = {}) =>
    request<Paginated<ReviewRequest>>(`/api/reviews?${qs(params)}`),
  get: (id: string) => request<ReviewRequest & { testCase: TestCase }>(`/api/reviews?id=${id}`),
  verdict: (id: string, body: { verdict: string; comment?: string; flaggedFields?: string[] } & Guarded) =>
    request<{ event: unknown; reviewStatus: string; testCaseStatus: string; moduleReviewCompleted?: boolean }>(`/api/reviews?id=${id}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Forward (re-assign) an OPEN review to another TCMS user — requester or
   *  assigned reviewer, perform_review required (server enforces both). */
  forward: (id: string, reviewerId: string, expectedUpdatedAt?: string) =>
    request<ReviewRequest>(`/api/reviews?id=${id}&action=forward`, {
      method: 'POST',
      body: JSON.stringify({ reviewerId, expectedUpdatedAt }),
    }),
}

// ---------- Module Reviews ----------
export const moduleReviewsApi = {
  queue: () => request<ModuleReviewRequest[]>('/api/module-reviews?action=queue'),
  all: () => request<ModuleReviewRequest[]>('/api/module-reviews?action=all'),
  get: (id: string) => request<ModuleReviewRequest>(`/api/module-reviews?id=${id}`),
  approveAll: (id: string, body: { comment?: string } & Guarded) =>
    request<{ approvedCount: number; moduleReviewStatus: string }>(`/api/module-reviews?id=${id}&action=approve-all`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** One verdict (approve / fail / needs-revision) for every open case review. */
  bulkVerdict: (id: string, body: { verdict: 'approved' | 'failed' | 'needs_revision'; comment?: string } & Guarded) =>
    request<{ verdict: string; affectedCount: number; moduleReviewStatus: string }>(`/api/module-reviews?id=${id}&action=bulk-verdict`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Reassign the module review (and its open case reviews) to another user. */
  changeReviewer: (id: string, reviewerId: string) =>
    request<ModuleReviewRequest>(`/api/module-reviews?id=${id}&action=change-reviewer`, {
      method: 'POST',
      body: JSON.stringify({ reviewerId }),
    }),
}

// ---------- Bugs ----------
export const bugsApi = {
  options: () => request<BugOption[]>('/api/bugs?action=options'),
  list: (filters: Record<string, string> = {}) =>
    request<Paginated<Bug>>(`/api/bugs?${qs(filters)}`),
  get: (id: string) => request<Bug>(`/api/bugs?id=${id}`),
  create: (body: Partial<Bug> & { title: string }) =>
    request<Bug>('/api/bugs', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: Partial<Bug> & { testCaseIds?: string[] } & Guarded) =>
    request<Bug>(`/api/bugs?id=${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  delete: (id: string) => request<{ success: boolean }>(`/api/bugs?id=${id}`, { method: 'DELETE' }),
  linkTc: (id: string, testCaseId: string) =>
    request<{ success: boolean }>(`/api/bugs?id=${id}&action=link-tc`, {
      method: 'PUT',
      body: JSON.stringify({ testCaseId }),
    }),
}

// ---------- Task Reports ----------
export const taskReportsApi = {
  list: (params: Record<string, string> = {}) =>
    request<Paginated<TaskReport>>(`/api/task-reports?${qs(params)}`),
  my: () => request<TaskReport[]>('/api/task-reports?action=my'),
  summary: (params: Record<string, string> = {}) =>
    request<{ range: { from: string; to: string }; users: { userId: string; userName: string; totalMinutes: number; days: number; hours: number }[] }>(`/api/task-reports?action=summary&${qs(params)}`),
  /** One user's full month of daily reports (JSON; CSV is built client-side).
   *  view_all_task_reports holders may pass userId for anyone; other users
   *  always get their own month regardless of the requested id. */
  exportMonth: (month: string, userId?: string) =>
    request<{ user: { userId: string; fullName: string }; month: string; reports: TaskReport[] }>(
      `/api/task-reports?action=export&month=${encodeURIComponent(month)}${userId ? `&userId=${encodeURIComponent(userId)}` : ''}`
    ),
  get: (id: string) => request<TaskReport>(`/api/task-reports?id=${id}`),
  upsert: (body: { reportDate: string; tasks: unknown[]; notes?: string }) =>
    request<TaskReport>('/api/task-reports', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: Partial<TaskReport>) =>
    request<TaskReport>(`/api/task-reports?id=${id}`, { method: 'PUT', body: JSON.stringify(body) }),
}

// ---------- Notifications ----------
export const notificationsApi = {
  list: (params: Record<string, string> = {}) =>
    request<Paginated<Notification>>(`/api/notifications?${qs(params)}`),
  readAll: () => request<{ success: boolean }>('/api/notifications?action=read-all', { method: 'POST' }),
  read: (id: string) => request<Notification>(`/api/notifications?id=${id}`, { method: 'PATCH' }),
  delete: (id: string) => request<{ success: boolean }>(`/api/notifications?id=${id}`, { method: 'DELETE' }),
  /** 60-second single-purpose ticket proving the session to the WS service. */
  wsTicket: () => request<{ ticket: string; ttlSeconds: number }>('/api/auth?path=ws-ticket'),
}

// ---------- Activity Logs ----------
export const activityLogsApi = {
  list: (params: Record<string, string> = {}) =>
    request<Paginated<ActivityLog>>(`/api/activity-logs?${qs(params)}`),
  entity: (type: string, id: string) =>
    request<ActivityLog[]>(`/api/activity-logs?action=entity&type=${type}&id=${id}`),
}

// ---------- Stats ----------
export const statsApi = {
  dashboard: () => request<DashboardStats>('/api/stats?action=dashboard'),
  reports: () => request<ReportsStats>('/api/stats?action=reports'),
}

// ---------- Crew Desk Integrations ----------
/** Serialized link row (mirrors the server's SerializedCrewDeskLink). */
export interface CrewDeskLink {
  linkId: string
  moduleId: string
  moduleName: string
  ticketId: string
  ticketTitle: string | null
  ticketStatus: string | null
  crewdeskCommentId: string | null
  status: 'posted' | 'failed' | 'manual'
  lastError: string | null
  linkedById: string
  linkedByName: string
  note: string | null
  createdAt: string
  updatedAt: string
}

export interface CrewDeskConfigInfo {
  mode: 'manual' | 'test' | 'live'
  baseUrlSet: boolean
  /** 'token' = fixed CREWDESK_TOKEN, 'login' = email/password, 'none' = not configured. */
  authMode: 'token' | 'login' | 'none'
  authConfigured: boolean
  timeoutMs: number
  testTicketId: string
  /** Email of the SHARED Crew Desk service account that posts all comments. */
  accountEmail: string | null
  /** Fixed-token mode only: ISO expiry of the credential (display-only). Login mode: null. */
  credentialExpiresAt: string | null
}

export interface CrewDeskEmailCheck {
  status: 'verified' | 'not_found'
  crewdeskUserId: string | null
  checkedAt: string | null
  mode: 'manual' | 'test' | 'live'
}

export interface CrewDeskTicketPreview {
  ticketId: string
  title: string
  status: string
  mode: 'manual' | 'test' | 'live'
  canLinkInCurrentMode: boolean
}

export const crewdeskApi = {
  config: () => request<CrewDeskConfigInfo>('/api/integrations/crewdesk?path=config'),
  list: (params: Record<string, string> = {}) =>
    request<Paginated<CrewDeskLink>>(`/api/integrations/crewdesk?${qs(params)}`),
  emailCheck: () =>
    request<CrewDeskEmailCheck>('/api/integrations/crewdesk?path=email-check'),
  /** Rebuilt comment text of a history row (Copy comment button). The
   *  browser's own origin rides along because GET requests carry no Origin
   *  header and the server's proxy fallback host would build a wrong link. */
  commentFor: (linkId: string) =>
    request<{ comment: string; moduleUrl: string }>(
      `/api/integrations/crewdesk?path=comment&linkId=${encodeURIComponent(linkId)}&origin=${encodeURIComponent(window.location.origin)}`
    ),
  /** Pre-link copy support: the EXACT comment a link would post — built from
   *  the module + your identity + the note. No Crew Desk call, no row. The
   *  browser origin is sent explicitly (see commentFor) so the module URL in
   *  the copied text is the address you are actually browsing. */
  previewComment: (moduleId: string, note?: string | null) =>
    request<{ comment: string; moduleUrl: string }>(
      `/api/integrations/crewdesk?path=preview-comment&moduleId=${encodeURIComponent(moduleId)}&note=${encodeURIComponent(note ?? '')}&origin=${encodeURIComponent(window.location.origin)}`
    ),
  lookup: (ticketId: string) =>
    request<CrewDeskTicketPreview>('/api/integrations/crewdesk?path=lookup', {
      method: 'POST',
      body: JSON.stringify({ ticketId }),
    }),
  create: (body: { moduleId: string; ticketId: string; note?: string | null }) =>
    request<CrewDeskLink>('/api/integrations/crewdesk', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  retry: (linkId: string) =>
    request<CrewDeskLink>(`/api/integrations/crewdesk?path=retry&linkId=${encodeURIComponent(linkId)}`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
}

// ---------- Wiki ----------
export const wikiApi = {
  list: (filters: Record<string, string | number> = {}) =>
    request<Paginated<WikiDocument>>(`/api/wiki?${qs(filters)}`),
  get: (id: string) => request<WikiDocument>(`/api/wiki?id=${id}`),
  createWritten: (body: { title: string; content?: string; tags?: string[] }) =>
    request<WikiDocument>('/api/wiki', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: { title?: string; content?: string; tags?: string[] }) =>
    request<WikiDocument>(`/api/wiki?id=${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  upload: (body: { file: File; title?: string; tags?: string[] }) => {
    const fd = new FormData()
    fd.set('file', body.file)
    if (body.title) fd.set('title', body.title)
    if (body.tags) fd.set('tags', JSON.stringify(body.tags))
    return requestForm<WikiDocument>('/api/wiki?action=upload', { method: 'POST', body: fd })
  },
  replaceFile: (id: string, body: { file: File; title?: string; tags?: string[] }) => {
    const fd = new FormData()
    fd.set('file', body.file)
    if (body.title) fd.set('title', body.title)
    if (body.tags) fd.set('tags', JSON.stringify(body.tags))
    return requestForm<WikiDocument>(`/api/wiki?id=${id}&action=upload`, { method: 'PUT', body: fd })
  },
  remove: (id: string) =>
    request<{ success: boolean }>(`/api/wiki?id=${id}`, { method: 'DELETE' }),
  /** Same-origin URL — the browser streams the httpOnly-cookie-authed file. */
  downloadUrl: (id: string) => `/api/wiki?id=${id}&action=download`,
}

// ---------- Global Search (Ctrl/Cmd+K) ----------
export const searchApi = {
  global: (q: string, limit = 5) =>
    request<GlobalSearchResult>(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`),
}

// ---------- Seed ----------
export const seedApi = {
  seed: () => request<{ seeded: boolean; message?: string }>('/api/seed', { method: 'POST' }),
}
