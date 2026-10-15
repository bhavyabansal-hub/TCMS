// Shared types for the TCMS frontend — the API contract.
//
// NAMING CONVENTION (strict): every entity carries its proper primary-key
// name (userId, moduleId, testCaseId, bugId, ...) — never a generic "id".
// Nested references use the same convention inside their objects.

export type Role = 'vp' | 'manager' | 'product' | 'developer' | 'qa_engineer' | 'viewer'

export const ROLES: Role[] = ['vp', 'manager', 'product', 'developer', 'qa_engineer', 'viewer']

export const ROLE_LABELS: Record<Role, string> = {
  vp: 'VP',
  manager: 'Manager',
  product: 'Product',
  developer: 'Developer',
  qa_engineer: 'QA Engineer',
  viewer: 'Viewer',
}

/** Every togglable permission in the system (single source of truth). */
export const PERMISSION_ACTIONS = [
  'create_module',
  'edit_module',
  'create_test_case',
  'edit_own_test_case',
  'edit_any_test_case',
  'delete_test_case',
  'submit_review',
  'perform_review',
  'create_bug',
  'delete_bug',
  'assign_bug',
  'create_task_report',
  'view_all_task_reports',
  'view_activity_logs',
  'manage_integrations',
  'manage_users',
  'manage_permissions',
  'create_wiki_doc',
  'edit_own_wiki_doc',
  'edit_any_wiki_doc',
  'delete_wiki_doc',
] as const

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number]

export const PERMISSION_ACTION_LABELS: Record<PermissionAction, string> = {
  create_module: 'Create modules',
  edit_module: 'Edit modules',
  create_test_case: 'Create test cases',
  edit_own_test_case: 'Edit own test cases',
  edit_any_test_case: 'Edit any test case',
  delete_test_case: 'Delete test cases',
  submit_review: 'Submit for review',
  perform_review: 'Perform reviews',
  create_bug: 'Create bugs',
  delete_bug: 'Delete bugs',
  assign_bug: 'Assign bugs',
  create_task_report: 'Create task reports',
  view_all_task_reports: 'View all task reports',
  view_activity_logs: 'View activity logs',
  manage_integrations: 'Manage integrations (Crew Desk)',
  manage_users: 'Manage users',
  manage_permissions: 'Manage permissions',
  create_wiki_doc: 'Create wiki documents',
  edit_own_wiki_doc: 'Edit own wiki documents',
  edit_any_wiki_doc: 'Edit any wiki document',
  delete_wiki_doc: 'Delete wiki documents',
}

/** Test-case priority scale (single source of truth). */
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const
export type PriorityValue = (typeof PRIORITIES)[number]

/** Roles that can be assigned a bug (everybody except viewer). */
export const BUG_ASSIGNEE_ROLES: Role[] = ['vp', 'manager', 'product', 'qa_engineer']

/** Lightweight user ref served by GET /api/users?action=options — the picker
 *  endpoint for assignment/reviewer dropdowns. canPerformReview is computed
 *  from the LIVE permission matrix (perform_review), never from a static role
 *  list, so VP toggles immediately change who can be chosen as a reviewer. */
export interface UserOption {
  userId: string
  fullName: string
  role: Role
  canPerformReview: boolean
}

/** One effective cell of the permission matrix (API shape for /api/permissions). */
export interface PermissionToggle {
  role: Role
  action: PermissionAction
  enabled: boolean
  source: 'default' | 'override'
}

export interface User {
  userId: string
  email: string
  fullName: string
  role: Role
  isActive: boolean
  avatarUrl: string | null
  telegramChatId: string | null
  notifyEmail: boolean
  notifyTelegram: boolean
  notifyInapp: boolean
  createdAt: string
}

export interface UserRef {
  userId: string
  fullName: string
  email?: string
  /** Present only when the feeding SQL join selected `{prefix}_avatar_url`. */
  avatarUrl?: string | null
}

export interface Module {
  moduleId: string
  name: string
  description: string | null
  parentId: string | null
  path: string
  depth: number
  ownerId: string
  createdById: string
  updatedById?: string | null
  createdAt: string
  updatedAt: string
  testCaseCount?: number
  children?: Module[]
  owner?: { userId: string; fullName: string; email: string }
  createdBy?: UserRef
  updatedBy?: UserRef
}

export type TestCaseStatus =
  | 'draft'
  | 'in_review'
  | 'needs_revision'
  | 'approved'
  | 'active'
  | 'deprecated'

export type Priority = 'P0' | 'P1' | 'P2' | 'P3'

export interface TestCase {
  testCaseId: string
  moduleId: string | null
  title: string
  description: string | null
  preconditions: string | null
  expectedResult: string | null
  priority: Priority
  status: TestCaseStatus
  tags: string[]
  version: number
  authorId: string
  lastEditedById: string | null
  assigneeId: string | null
  attachments: unknown[]
  createdAt: string
  updatedAt: string
  module?: { moduleId: string; name: string; parentId: string | null } | null
  author?: UserRef | null
  lastEditedBy?: UserRef | null
  assignee?: UserRef | null
}

export interface TestCaseHistory {
  historyId: string
  testCaseId: string
  version: number
  snapshot: Record<string, unknown>
  changedById: string | null
  changeSummary: string | null
  createdAt: string
  changedBy?: UserRef | null
}

export type ReviewStatus = 'pending' | 'in_progress' | 'completed'
export type Verdict = 'approved' | 'failed' | 'needs_revision'

export interface ReviewEvent {
  reviewEventId: string
  reviewRequestId: string
  reviewerId: string
  verdict: Verdict
  comment: string | null
  flaggedFields: string[]
  createdAt: string
  reviewer?: UserRef
}

export interface ReviewRequest {
  reviewRequestId: string
  testCaseId: string
  reviewerId: string
  requesterId: string
  status: ReviewStatus
  dueDate: string | null
  cycle: number
  moduleReviewId?: string | null
  createdAt: string
  updatedAt: string
  testCase?: TestCase
  reviewer?: UserRef
  requester?: UserRef
  events?: ReviewEvent[]
}

// A module-level review groups many test-case reviews together.
export interface ModuleReviewRequest {
  moduleReviewRequestId: string
  moduleId: string
  reviewerId: string
  requesterId: string
  status: ReviewStatus
  dueDate: string | null
  cycle: number
  createdAt: string
  updatedAt: string
  module?: { moduleId: string; name: string; parentId: string | null }
  reviewer?: UserRef
  requester?: UserRef
  caseReviews?: (ReviewRequest & {
    testCase: TestCase | null
    events: ReviewEvent[]
  })[]
  caseCount?: number
}

export type BugStatus = 'open' | 'in_progress' | 'resolved' | 'closed' | 'wont_fix'
export type Severity = 'critical' | 'high' | 'medium' | 'low'

export interface Bug {
  bugId: string
  title: string
  description: string | null
  severity: Severity
  status: BugStatus
  environment: string | null
  stepsToReproduce: string | null
  expectedBehaviour: string | null
  actualBehaviour: string | null
  reportedById: string
  assignedToId: string | null
  moduleId: string | null
  attachments: unknown[]
  resolvedAt: string | null
  createdAt: string
  updatedAt: string
  module?: { moduleId: string; name: string } | null
  reportedBy?: UserRef | null
  assignedTo?: UserRef | null
}

export interface TaskItem {
  description: string
  timeSpentMinutes: number
  moduleId: string | null
  testCaseId: string | null
  bugId: string | null
  status: 'done' | 'in_progress' | 'blocked'
  /** Optional external reference (e.g. a ticket, doc or PR URL). */
  linkUrl?: string | null
}

export interface TaskReport {
  taskReportId: string
  reportedById: string
  reportDate: string
  tasks: TaskItem[]
  notes: string | null
  totalMinutes: number
  createdAt: string
  updatedAt: string
  reportedBy?: UserRef
}

export type NotificationType =
  | 'review_assigned'
  | 'review_approved'
  | 'review_failed'
  | 'review_needs_revision'
  | 'comment_added'
  | 'bug_assigned'
  | 'test_case_updated'
  | 'module_created'
  | 'password_changed'
  | 'daily_report_submitted'
  | 'daily_summary'

export interface Notification {
  notificationId: string
  userId: string
  type: NotificationType
  title: string
  body: string | null
  entityType: string | null
  entityId: string | null
  isRead: boolean
  createdAt: string
}

export interface ActivityLog {
  activityLogId: string
  userId: string | null
  action: string
  entityType: string
  entityId: string | null
  entityName: string | null
  beforeSnapshot: Record<string, unknown> | null
  afterSnapshot: Record<string, unknown> | null
  diff: Record<string, { before: unknown; after: unknown }> | null
  ipAddress: string | null
  userAgent: string | null
  createdAt: string
  user?: { userId: string; fullName: string; avatarUrl: string | null } | null
}

export interface Paginated<T> {
  data: T[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export interface DashboardStats {
  totalTestCases: number
  statusBreakdown: { status: string; count: number }[]
  openBugs: number
  severityBreakdown: { severity: string; count: number }[]
  myPendingReviews: number
  recentActivity: ActivityLog[]
  /** Additive Command Center aggregates — optional so older payloads stay valid. */
  bugStatusBreakdown?: { status: string; count: number }[]
  priorityBreakdown?: { priority: string; count: number }[]
}

/** Outcome of ONE row of a test-case CSV import. */
export interface ImportRowResult {
  /** 1-based data-row number inside the CSV (header/comments excluded). */
  row: number
  title: string
  status: 'created' | 'failed'
  testCaseId?: string
  error?: string
}

/** Summary returned by POST /api/test-cases?action=import. */
export interface ImportTestCasesResult {
  moduleId: string
  moduleName: string
  totalRows: number
  imported: number
  failed: number
  results: ImportRowResult[]
}

/** Payload of GET /api/test-cases?action=import-template. */
export interface ImportTemplate {
  fileName: string
  csv: string
}

export interface ReportsStats {
  testCasesByStatus: { status: string; count: number }[]
  testCasesByPriority: { priority: string; count: number }[]
  bugsByStatus: { status: string; count: number }[]
  weeklyHours: { user: string; week: string; hours: number }[]
}

/** Wiki document — written (rich-text HTML) or uploaded file. `fileData`
 *  NEVER crosses the API: files stream through the dedicated download route. */
export interface WikiDocument {
  wikiDocumentId: string
  title: string
  kind: 'written' | 'file'
  content: string | null
  fileName: string | null
  fileType: string | null
  fileSize: number | null
  tags: string[]
  authorId: string
  lastEditedById: string | null
  author: UserRef | null
  lastEditedBy: UserRef | null
  createdAt: string
  updatedAt: string
}

/** Grouped results of GET /api/search (global Ctrl+K search). */
export interface GlobalSearchResult {
  modules: { moduleId: string; name: string; path: string }[]
  testCases: {
    testCaseId: string
    title: string
    status: string
    priority: string
    moduleName: string | null
  }[]
  bugs: { bugId: string; title: string; status: string; severity: string }[]
  wiki: { wikiDocumentId: string; title: string; kind: string }[]
  empty: boolean
}
