// Centralized serializers — the ONLY boundary between database rows and API JSON.
//
// WHY THIS EXISTS:
//   1. The database uses snake_case tables/columns with entity-named primary
//      keys (users.user_id, test_cases.test_case_id, ...). Raw-SQL repositories
//      return rows in that shape. The API speaks camelCase with the same proper
//      key names (userId, testCaseId, ...). Every row is mapped EXACTLY ONCE,
//      here — never ad-hoc inside a service or controller.
//   2. JSONB columns (steps, tags, attachments, snapshot, diff, tasks,
//      flagged_fields) may arrive as parsed objects or legacy JSON strings;
//      parseJson() normalizes them exactly once per response.
//   3. Joined columns follow the `<relation>_<column>` alias convention and are
//      optional — the serializer emits the nested object only when present.
//
// RULES FOR SERVICES/CONTROLLERS:
//   - Never return a raw SQL row to the client — always pass it through the
//     matching serializer here.
//   - Adding a new JSON column or join only requires updating this file.

import { parseJson } from './activity'
import type {
  UserSqlRow,
  ModuleSqlRow,
  TestCaseSqlRow,
  TestCaseHistorySqlRow,
  ReviewRequestSqlRow,
  ReviewEventSqlRow,
  ModuleReviewRequestSqlRow,
  BugSqlRow,
  TaskReportSqlRow,
  NotificationSqlRow,
  ActivityLogSqlRow,
  WikiDocumentSqlRow,
} from '@/types/sql-rows'
import type { UserRef } from '@/types'

// ---------- Shared reference shapes ----------

// Canonical UserRef lives in @/types (with optional avatarUrl); re-exported
// here so serializer consumers keep their historical import path.
export type { UserRef }

function userRef(row: Record<string, unknown>, prefix: string): UserRef | null {
  const id = row[`${prefix}_user_id`]
  if (typeof id !== 'string') return null
  const ref: UserRef = { userId: id, fullName: String(row[`${prefix}_full_name`] ?? '') }
  const email = row[`${prefix}_email`]
  if (typeof email === 'string') ref.email = email
  // Optional projection: joins that select `{prefix}_avatar_url` surface the
  // user's avatar; joins that omit the column leave it undefined (not null)
  // so callers cannot mistake "not selected" for "user has no avatar".
  const avatarUrl = row[`${prefix}_avatar_url`]
  if (typeof avatarUrl === 'string' || avatarUrl === null) ref.avatarUrl = avatarUrl
  return ref
}

function moduleRef(row: Record<string, unknown>, prefix = 'module'): { moduleId: string; name: string; parentId: string | null } | null {
  const id = row[`${prefix}_module_id`]
  if (typeof id !== 'string') return null
  return { moduleId: id, name: String(row[`${prefix}_name`] ?? ''), parentId: (row[`${prefix}_parent_id`] as string | null) ?? null }
}

function shortModuleRef(row: Record<string, unknown>, prefix = 'module'): { moduleId: string; name: string } | null {
  const ref = moduleRef(row, prefix)
  return ref ? { moduleId: ref.moduleId, name: ref.name } : null
}

// ---------- User (public shape — NEVER exposes password_hash) ----------

export interface SerializedUser {
  userId: string
  email: string
  fullName: string
  role: string
  isActive: boolean
  avatarUrl: string | null
  telegramChatId: string | null
  notifyEmail: boolean
  notifyTelegram: boolean
  notifyInapp: boolean
  createdAt: Date
}

export function serializeUser(u: UserSqlRow): SerializedUser {
  return {
    userId: u.user_id,
    email: u.email,
    fullName: u.full_name,
    role: u.role,
    // MySQL raw rows return TINYINT(1) as 1/0 — normalize to real booleans
    // so the API JSON always carries true/false.
    isActive: Boolean(u.is_active),
    avatarUrl: u.avatar_url,
    telegramChatId: u.telegram_chat_id,
    notifyEmail: Boolean(u.notify_email),
    notifyTelegram: Boolean(u.notify_telegram),
    notifyInapp: Boolean(u.notify_inapp),
    createdAt: u.created_at,
  }
}

// ---------- Module ----------

export interface SerializedModule {
  moduleId: string
  name: string
  description: string | null
  parentId: string | null
  path: string
  depth: number
  ownerId: string
  createdById: string
  updatedById: string | null
  createdAt: Date
  updatedAt: Date
  testCaseCount?: number
  owner?: { userId: string; fullName: string; email: string } | null
  createdBy?: UserRef | null
  updatedBy?: UserRef | null
}

export function serializeModule(m: ModuleSqlRow): SerializedModule {
  const result: SerializedModule = {
    moduleId: m.module_id,
    name: m.name,
    description: m.description,
    parentId: m.parent_id,
    path: m.path,
    depth: m.depth,
    ownerId: m.owner_id,
    createdById: m.created_by_id,
    updatedById: m.updated_by_id,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
  }
  if (m.test_case_count !== undefined) result.testCaseCount = m.test_case_count
  return result
}

// Owner / createdBy / updatedBy joins use the standard alias convention and
// are emitted only when the repository JOINed them.
export function serializeModuleWithJoins(m: ModuleSqlRow): SerializedModule {
  const result = serializeModule(m)
  const row = m as unknown as Record<string, unknown>
  if (row['owner_user_id'] !== undefined) {
    result.owner = {
      userId: String(row['owner_user_id']),
      fullName: String(row['owner_full_name'] ?? ''),
      email: String(row['owner_email'] ?? ''),
    }
  }
  if (row['created_by_user_id'] !== undefined) {
    result.createdBy = userRef(row, 'created_by')
  }
  if (row['updated_by_user_id'] !== undefined) {
    result.updatedBy = userRef(row, 'updated_by')
  }
  return result
}

// ---------- Test Case ----------

export interface SerializedTestCase {
  testCaseId: string
  moduleId: string | null
  title: string
  description: string | null
  preconditions: string | null
  expectedResult: string | null
  priority: string
  status: string
  tags: string[]
  version: number
  authorId: string
  lastEditedById: string | null
  assigneeId: string | null
  attachments: unknown[]
  createdAt: Date
  updatedAt: Date
  module?: { moduleId: string; name: string; parentId: string | null } | null
  author?: UserRef | null
  lastEditedBy?: UserRef | null
  assignee?: UserRef | null
}

export function serializeTestCase(tc: TestCaseSqlRow): SerializedTestCase {
  const result: SerializedTestCase = {
    testCaseId: tc.test_case_id,
    moduleId: tc.module_id,
    title: tc.title,
    description: tc.description,
    preconditions: tc.preconditions,
    expectedResult: tc.expected_result,
    priority: tc.priority,
    status: tc.status,
    tags: parseJson<string[]>(tc.tags, []),
    version: tc.version,
    authorId: tc.author_id,
    lastEditedById: tc.last_edited_by_id,
    assigneeId: tc.assignee_id,
    attachments: parseJson<unknown[]>(tc.attachments, []),
    createdAt: tc.created_at,
    updatedAt: tc.updated_at,
  }
  const row = tc as unknown as Record<string, unknown>
  if (row['module_module_id'] !== undefined) result.module = moduleRef(row)
  if (row['author_user_id'] !== undefined) result.author = userRef(row, 'author')
  if (row['last_edited_by_user_id'] !== undefined) result.lastEditedBy = userRef(row, 'last_edited_by')
  if (row['assignee_user_id'] !== undefined) result.assignee = userRef(row, 'assignee')
  return result
}

// ---------- Test Case History ----------

export interface SerializedTestCaseHistory {
  historyId: string
  testCaseId: string
  version: number
  snapshot: Record<string, unknown>
  changedById: string | null
  changeSummary: string | null
  createdAt: Date
  changedBy?: UserRef | null
}

export function serializeTestCaseHistory(h: TestCaseHistorySqlRow): SerializedTestCaseHistory {
  const result: SerializedTestCaseHistory = {
    historyId: h.history_id,
    testCaseId: h.test_case_id,
    version: h.version,
    snapshot: parseJson<Record<string, unknown>>(h.snapshot, {}),
    changedById: h.changed_by_id,
    changeSummary: h.change_summary,
    createdAt: h.created_at,
  }
  const row = h as unknown as Record<string, unknown>
  if (row['changed_by_user_id'] !== undefined) result.changedBy = userRef(row, 'changed_by')
  return result
}

// ---------- Review Event ----------

export interface SerializedReviewEvent {
  reviewEventId: string
  reviewRequestId: string
  reviewerId: string
  verdict: string
  comment: string | null
  flaggedFields: string[]
  createdAt: Date
  reviewer?: UserRef | null
}

export function serializeReviewEvent(e: ReviewEventSqlRow): SerializedReviewEvent {
  const result: SerializedReviewEvent = {
    reviewEventId: e.review_event_id,
    reviewRequestId: e.review_request_id,
    reviewerId: e.reviewer_id,
    verdict: e.verdict,
    comment: e.comment,
    flaggedFields: parseJson<string[]>(e.flagged_fields, []),
    createdAt: e.created_at,
  }
  const row = e as unknown as Record<string, unknown>
  if (row['reviewer_user_id'] !== undefined) result.reviewer = userRef(row, 'reviewer')
  return result
}

// ---------- Review Request ----------

export interface SerializedReviewRequest {
  reviewRequestId: string
  testCaseId: string
  reviewerId: string
  requesterId: string
  status: string
  dueDate: Date | null
  cycle: number
  moduleReviewId: string | null
  createdAt: Date
  updatedAt: Date
  reviewer?: UserRef | null
  requester?: UserRef | null
  testCase?: SerializedTestCase | null
  events?: SerializedReviewEvent[]
}

export function serializeReviewRequest(
  r: ReviewRequestSqlRow & {
    testCase?: TestCaseSqlRow | null
    events?: ReviewEventSqlRow[]
  }
): SerializedReviewRequest {
  const result: SerializedReviewRequest = {
    reviewRequestId: r.review_request_id,
    testCaseId: r.test_case_id,
    reviewerId: r.reviewer_id,
    requesterId: r.requester_id,
    status: r.status,
    dueDate: r.due_date,
    cycle: r.cycle,
    moduleReviewId: r.module_review_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
  const row = r as unknown as Record<string, unknown>
  if (row['reviewer_user_id'] !== undefined) result.reviewer = userRef(row, 'reviewer')
  if (row['requester_user_id'] !== undefined) result.requester = userRef(row, 'requester')
  if (r.testCase !== undefined) result.testCase = r.testCase ? serializeTestCase(r.testCase) : null
  if (r.events !== undefined) result.events = r.events.map(serializeReviewEvent)
  return result
}

// ---------- Module Review Request ----------

export interface SerializedModuleReviewRequest {
  moduleReviewRequestId: string
  moduleId: string
  reviewerId: string
  requesterId: string
  status: string
  dueDate: Date | null
  cycle: number
  createdAt: Date
  updatedAt: Date
  module?: { moduleId: string; name: string; parentId: string | null } | null
  reviewer?: UserRef | null
  requester?: UserRef | null
  caseReviews?: SerializedReviewRequest[]
  caseCount?: number
}

export function serializeModuleReviewRequest(
  r: ModuleReviewRequestSqlRow & {
    caseReviews?: Array<ReviewRequestSqlRow & { testCase?: TestCaseSqlRow | null; events?: ReviewEventSqlRow[] }>
  }
): SerializedModuleReviewRequest {
  const result: SerializedModuleReviewRequest = {
    moduleReviewRequestId: r.module_review_request_id,
    moduleId: r.module_id,
    reviewerId: r.reviewer_id,
    requesterId: r.requester_id,
    status: r.status,
    dueDate: r.due_date,
    cycle: r.cycle,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
  const row = r as unknown as Record<string, unknown>
  if (row['module_module_id'] !== undefined) result.module = moduleRef(row)
  if (row['reviewer_user_id'] !== undefined) result.reviewer = userRef(row, 'reviewer')
  if (row['requester_user_id'] !== undefined) result.requester = userRef(row, 'requester')
  if (r.caseReviews !== undefined) {
    result.caseReviews = r.caseReviews.map((cr) => serializeReviewRequest(cr))
    result.caseCount = r.caseReviews.length
  }
  return result
}

// ---------- Bug ----------

export interface SerializedBug {
  bugId: string
  title: string
  description: string | null
  severity: string
  status: string
  environment: string | null
  stepsToReproduce: string | null
  expectedBehaviour: string | null
  actualBehaviour: string | null
  reportedById: string
  assignedToId: string | null
  moduleId: string | null
  attachments: unknown[]
  resolvedAt: Date | null
  createdAt: Date
  updatedAt: Date
  module?: { moduleId: string; name: string } | null
  reportedBy?: UserRef | null
  assignedTo?: UserRef | null
}

export function serializeBug(b: BugSqlRow): SerializedBug {
  const result: SerializedBug = {
    bugId: b.bug_id,
    title: b.title,
    description: b.description,
    severity: b.severity,
    status: b.status,
    environment: b.environment,
    stepsToReproduce: b.steps_to_reproduce,
    expectedBehaviour: b.expected_behaviour,
    actualBehaviour: b.actual_behaviour,
    reportedById: b.reported_by_id,
    assignedToId: b.assigned_to_id,
    moduleId: b.module_id,
    attachments: parseJson<unknown[]>(b.attachments, []),
    resolvedAt: b.resolved_at,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
  }
  const row = b as unknown as Record<string, unknown>
  if (row['module_module_id'] !== undefined) result.module = shortModuleRef(row)
  if (row['reported_by_user_id'] !== undefined) result.reportedBy = userRef(row, 'reported_by')
  if (row['assigned_to_user_id'] !== undefined) result.assignedTo = userRef(row, 'assigned_to')
  return result
}

// ---------- Task Report ----------

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

export interface SerializedTaskReport {
  taskReportId: string
  reportedById: string
  reportDate: Date
  tasks: TaskItem[]
  notes: string | null
  totalMinutes: number
  createdAt: Date
  updatedAt: Date
  reportedBy?: UserRef | null
}

export function serializeTaskReport(r: TaskReportSqlRow): SerializedTaskReport {
  const result: SerializedTaskReport = {
    taskReportId: r.task_report_id,
    reportedById: r.reported_by_id,
    reportDate: r.report_date,
    tasks: parseJson<TaskItem[]>(r.tasks, []),
    notes: r.notes,
    totalMinutes: r.total_minutes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
  const row = r as unknown as Record<string, unknown>
  if (row['reported_by_user_id'] !== undefined) result.reportedBy = userRef(row, 'reported_by')
  return result
}

// ---------- Notification ----------

export interface SerializedNotification {
  notificationId: string
  userId: string
  type: string
  title: string
  body: string | null
  entityType: string | null
  entityId: string | null
  isRead: boolean
  createdAt: Date
}

export function serializeNotification(n: NotificationSqlRow): SerializedNotification {
  return {
    notificationId: n.notification_id,
    userId: n.user_id,
    type: n.type,
    title: n.title,
    body: n.body,
    entityType: n.entity_type,
    entityId: n.entity_id,
    isRead: Boolean(n.is_read),
    createdAt: n.created_at,
  }
}

// ---------- Activity Log ----------

export interface SerializedActivityLog {
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
  createdAt: Date
  user?: { userId: string; fullName: string; avatarUrl: string | null } | null
}

export function serializeActivityLog(l: ActivityLogSqlRow): SerializedActivityLog {
  const result: SerializedActivityLog = {
    activityLogId: l.activity_log_id,
    userId: l.user_id,
    action: l.action,
    entityType: l.entity_type,
    entityId: l.entity_id,
    entityName: l.entity_name,
    beforeSnapshot: l.before_snapshot ? parseJson<Record<string, unknown>>(l.before_snapshot, {}) : null,
    afterSnapshot: l.after_snapshot ? parseJson<Record<string, unknown>>(l.after_snapshot, {}) : null,
    diff: l.diff ? parseJson<Record<string, { before: unknown; after: unknown }>>(l.diff, {}) : null,
    ipAddress: l.ip_address,
    userAgent: l.user_agent,
    createdAt: l.created_at,
  }
  const row = l as unknown as Record<string, unknown>
  if (row['user_user_id'] !== undefined) {
    result.user = row['user_user_id']
      ? { userId: String(row['user_user_id']), fullName: String(row['user_full_name'] ?? ''), avatarUrl: (row['user_avatar_url'] as string | null) ?? null }
      : null
  }
  return result
}

// ---------- Wiki ----------

export interface SerializedWikiDocument {
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
  createdAt: Date
  updatedAt: Date
  author?: UserRef | null
  lastEditedBy?: UserRef | null
}

export function serializeWikiDocument(w: WikiDocumentSqlRow): SerializedWikiDocument {
  const result: SerializedWikiDocument = {
    wikiDocumentId: w.wiki_document_id,
    title: w.title,
    kind: (w.kind === 'file' ? 'file' : 'written'),
    content: w.content,
    fileName: w.file_name,
    fileType: w.file_type,
    fileSize: w.file_size,
    tags: parseJson<string[]>(w.tags, []),
    authorId: w.author_id,
    lastEditedById: w.last_edited_by_id,
    createdAt: w.created_at,
    updatedAt: w.updated_at,
  }
  const row = w as unknown as Record<string, unknown>
  if (row['author_user_id'] !== undefined) result.author = userRef(row, 'author')
  if (row['last_edited_by_user_id'] !== undefined) result.lastEditedBy = userRef(row, 'last_edited_by')
  return result
}
