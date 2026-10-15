// SQL row shapes returned by raw queries against the snake_case database.
//
// These interfaces are the CONTRACT between the repository layer (which runs
// the SQL) and the serializer layer (which maps snake_case rows to the
// camelCase API shapes in ./index.ts).
//
// Conventions:
//   - Keys mirror the physical column names (snake_case).
//   - Joined columns use the alias convention `<relation>_<column>`
//     (e.g. `author_user_id`, `module_name`) and are optional — a repository
//     may or may not JOIN them. Serializers emit the nested object only when
//     the join columns are present.
//   - JSONB columns arrive as parsed JS values (arrays/objects) — or, for
//     legacy rows, JSON strings; `parseJson()` normalizes both.

// ---------- Users & Auth ----------

export interface UserSqlRow {
  user_id: string
  email: string
  full_name: string
  password_hash: string
  role: string
  telegram_chat_id: string | null
  avatar_url: string | null
  is_active: boolean
  notify_email: boolean
  notify_telegram: boolean
  notify_inapp: boolean
  created_at: Date
  updated_at: Date
}

export interface RefreshTokenSqlRow {
  refresh_token_id: string
  user_id: string
  token: string
  expires_at: Date
  revoked: boolean
  created_at: Date
}

// ---------- Modules ----------

export interface ModuleSqlRow {
  module_id: string
  name: string
  description: string | null
  parent_id: string | null
  path: string
  depth: number
  owner_id: string
  created_by_id: string
  updated_by_id: string | null
  created_at: Date
  updated_at: Date
  // optional joins
  owner_email?: string | null
  owner_full_name?: string | null
  test_case_count?: number
  created_by_full_name?: string | null
  updated_by_full_name?: string | null
}

export interface RolePermissionSqlRow {
  role: string
  action: string
  enabled: boolean
  updated_by_id: string | null
  updated_at: Date
}

export interface LoginAttemptSqlRow {
  email: string
  failed_attempts: number
  locked_until: Date | null
  updated_at: Date
}

// ---------- Test Cases ----------

export interface TestCaseSqlRow {
  test_case_id: string
  module_id: string | null
  title: string
  description: string | null
  preconditions: string | null
  expected_result: string | null
  priority: string
  status: string
  tags: unknown
  version: number
  author_id: string
  last_edited_by_id: string | null
  assignee_id: string | null
  attachments: unknown
  created_at: Date
  updated_at: Date
  // optional joins
  module_module_id?: string | null
  module_name?: string | null
  module_parent_id?: string | null
  author_user_id?: string
  author_full_name?: string | null
  last_edited_by_user_id?: string | null
  last_edited_by_full_name?: string | null
  assignee_user_id?: string | null
  assignee_full_name?: string | null
}

export interface TestCaseHistorySqlRow {
  history_id: string
  test_case_id: string
  version: number
  snapshot: unknown
  changed_by_id: string | null
  change_summary: string | null
  created_at: Date
  // optional joins
  changed_by_user_id?: string | null
  changed_by_full_name?: string | null
}

// ---------- Reviews ----------

export interface ModuleReviewRequestSqlRow {
  module_review_request_id: string
  module_id: string
  reviewer_id: string
  requester_id: string
  status: string
  due_date: Date | null
  cycle: number
  created_at: Date
  updated_at: Date
  // optional joins
  module_module_id?: string | null
  module_name?: string | null
  module_parent_id?: string | null
  reviewer_user_id?: string
  reviewer_full_name?: string | null
  reviewer_email?: string | null
  requester_user_id?: string
  requester_full_name?: string | null
}

export interface ReviewRequestSqlRow {
  review_request_id: string
  test_case_id: string
  reviewer_id: string
  requester_id: string
  status: string
  due_date: Date | null
  cycle: number
  module_review_id: string | null
  created_at: Date
  updated_at: Date
  // optional joins
  reviewer_user_id?: string
  reviewer_full_name?: string | null
  reviewer_email?: string | null
  requester_user_id?: string
  requester_full_name?: string | null
}

export interface ReviewEventSqlRow {
  review_event_id: string
  review_request_id: string
  reviewer_id: string
  verdict: string
  comment: string | null
  flagged_fields: unknown
  created_at: Date
  // optional joins
  reviewer_user_id?: string
  reviewer_full_name?: string | null
}

// ---------- Bugs ----------

export interface BugSqlRow {
  bug_id: string
  title: string
  description: string | null
  severity: string
  status: string
  environment: string | null
  steps_to_reproduce: string | null
  expected_behaviour: string | null
  actual_behaviour: string | null
  reported_by_id: string
  assigned_to_id: string | null
  module_id: string | null
  attachments: unknown
  resolved_at: Date | null
  created_at: Date
  updated_at: Date
  // optional joins
  module_module_id?: string | null
  module_name?: string | null
  reported_by_user_id?: string
  reported_by_full_name?: string | null
  assigned_to_user_id?: string | null
  assigned_to_full_name?: string | null
}

// ---------- Task Reports ----------

export interface TaskReportSqlRow {
  task_report_id: string
  reported_by_id: string
  report_date: Date
  tasks: unknown
  notes: string | null
  total_minutes: number
  created_at: Date
  updated_at: Date
  // optional joins
  reported_by_user_id?: string
  reported_by_full_name?: string | null
}

// ---------- Notifications ----------

export interface NotificationSqlRow {
  notification_id: string
  user_id: string
  type: string
  title: string
  body: string | null
  entity_type: string | null
  entity_id: string | null
  is_read: boolean
  created_at: Date
}

// ---------- Activity Logs ----------

export interface ActivityLogSqlRow {
  activity_log_id: string
  user_id: string | null
  action: string
  entity_type: string
  entity_id: string | null
  entity_name: string | null
  before_snapshot: unknown
  after_snapshot: unknown
  diff: unknown
  ip_address: string | null
  user_agent: string | null
  created_at: Date
  // optional joins
  user_user_id?: string | null
  user_full_name?: string | null
  user_avatar_url?: string | null
}

// ---------- Wiki ----------

// NOTE: `file_data` is deliberately ABSENT — it is never selected by list/get
// queries; the download route reads it via a dedicated narrow query.
export interface WikiDocumentSqlRow {
  wiki_document_id: string
  title: string
  kind: string
  content: string | null
  file_name: string | null
  file_type: string | null
  file_size: number | null
  tags: unknown
  author_id: string
  last_edited_by_id: string | null
  created_at: Date
  updated_at: Date
  // optional joins
  author_user_id?: string
  author_full_name?: string | null
  author_avatar_url?: string | null
  last_edited_by_user_id?: string | null
  last_edited_by_full_name?: string | null
  last_edited_by_avatar_url?: string | null
}
