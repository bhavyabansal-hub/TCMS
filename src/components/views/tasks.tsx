'use client'

import { useMemo, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Plus, Save, Download, Trash2, Loader2, Clock, ListTodo,
  CheckCircle2, Ban, CalendarDays, ExternalLink, FileSpreadsheet,
} from 'lucide-react'

import { useAuthStore } from '@/store'
import { REFERENCE_STALE_TIME_MS, bugsApi, modulesApi, taskReportsApi, testCasesApi, usersApi } from '@/lib/client/api'
import { invalidateAfterMutation } from '@/lib/client/invalidate'
import type { TaskItem, TaskReport, Module, TestCase, Bug } from '@/types'
import { minutesToHuman, todayISO } from '@/lib/format'
import { handleApiError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { toCsv } from '@/lib/csv-export'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { PageHeader } from '@/components/shared/page-header'
import { QueryErrorAlert } from '@/components/shared/query-error'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

function onlyDate(iso: string): string {
  return iso.slice(0, 10)
}

type LinkType = 'module' | 'test_case' | 'bug' | 'none'

/** UI row model: TaskItem plus the explicitly chosen link type.
 *  `linkType` is view-only state — it is stripped before saving because the
 *  API derives the link from whichever entity id is set. */
type TaskRow = TaskItem & { linkType: LinkType }

const EMPTY_TASK: TaskRow = {
  description: '',
  timeSpentMinutes: 0,
  moduleId: null,
  testCaseId: null,
  bugId: null,
  status: 'in_progress',
  linkType: 'none',
  linkUrl: '',
}

/** Read-only notices on /tasks (REQ-001 R1). At most one is shown. */
const NOTICE_CANNOT_LOG =
  'Your role can view work logs but cannot log work. A VP can enable "Create task reports" for your role under Permissions.'
const NOTICE_OTHER_USER_CAN_LOG = "You are viewing another user's report. Switch back to yourself to make edits."
const NOTICE_OTHER_USER = "You are viewing another user's report."

function linkTypeForTask(t: TaskItem): LinkType {
  if (t.moduleId) return 'module'
  if (t.testCaseId) return 'test_case'
  if (t.bugId) return 'bug'
  return 'none'
}

/** Normalize a stored TaskItem into an editable row (derives initial link type). */
function withLinkType(t: TaskItem): TaskRow {
  return { ...t, linkType: linkTypeForTask(t) }
}

/** Strip the view-only linkType before sending to the API. */
function toTaskItem(t: TaskRow): TaskItem {
  const { linkType: _linkType, ...rest } = t
  return { ...rest, linkUrl: rest.linkUrl?.trim() ? rest.linkUrl.trim() : null }
}

const URL_PATTERN = /^https?:\/\/\S+$/i

function downloadCsv(fileName: string, rows: string[][]): void {
  const csv = toCsv(rows) // quoted + formula-injection safe (src/lib/csv-export.ts)
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

const TASK_STATUS_META: Record<TaskItem['status'], { label: string; dot: string; chip: string }> = {
  done: { label: 'Done', dot: 'bg-emerald-500', chip: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/25' },
  in_progress: { label: 'In Progress', dot: 'bg-sky-500', chip: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-500/15 dark:text-sky-300 dark:border-sky-500/25' },
  blocked: { label: 'Blocked', dot: 'bg-rose-500', chip: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/25' },
}

export function TasksView() {
  const { user, can } = useAuthStore()
  const canViewAllReports = can('view_all_task_reports')

  const [reportDate, setReportDate] = useState<string>(todayISO())
  // selectedUserId is only used by managers. Non-managers always use their own id.
  const [selectedUserId, setSelectedUserId] = useState<string>('')
  const [exportMonth, setExportMonth] = useState<string>(todayISO().slice(0, 7))

  // Effective user being viewed/edited.
  const effectiveUserId = canViewAllReports ? selectedUserId || user?.userId || '' : user?.userId ?? ''

  const myReportsQuery = useQuery({
    queryKey: ['task-reports', 'my'],
    queryFn: () => taskReportsApi.my(),
    enabled: !canViewAllReports,
  })

  // Picker rows (any authenticated user) — works for any view_all_task_reports
  // holder even without manage_users (the admin list would 403 here).
  const allUsersQuery = useQuery({
    queryKey: ['users', 'options'],
    staleTime: REFERENCE_STALE_TIME_MS,
    queryFn: usersApi.options,
    enabled: canViewAllReports,
  })

  const userReportsQuery = useQuery({
    queryKey: ['task-reports', 'user', effectiveUserId, reportDate],
    queryFn: () =>
      taskReportsApi.list({
        userId: effectiveUserId,
        dateFrom: reportDate,
        dateTo: reportDate,
      }),
    placeholderData: keepPreviousData,
    enabled: canViewAllReports && !!effectiveUserId,
  })

  // Reference data for linked-entity select (shared by form)
  const modulesQuery = useQuery({
    queryKey: ['modules', 'tree'],
    staleTime: REFERENCE_STALE_TIME_MS,
    queryFn: () => modulesApi.tree(),
  })
  const testCasesQuery = useQuery({
    queryKey: ['test-cases', 'list', 'all-light'],
    queryFn: () => testCasesApi.list({ pageSize: 200 }),
  })
  const bugsQuery = useQuery({
    queryKey: ['bugs', 'list', 'all-light'],
    queryFn: () => bugsApi.list({ pageSize: '200' }),
  })

  const flatModules: Module[] = useMemo(
    () => (modulesQuery.data?.flat ?? []) as Module[],
    [modulesQuery.data]
  )
  const testCases: TestCase[] = useMemo(
    () => testCasesQuery.data?.data ?? [],
    [testCasesQuery.data]
  )
  const bugs: Bug[] = useMemo(() => bugsQuery.data?.data ?? [], [bugsQuery.data])

  // Pick the report for the chosen date
  const reportForDate: TaskReport | undefined = useMemo(() => {
    if (canViewAllReports) {
      return userReportsQuery.data?.data?.[0]
    }
    return myReportsQuery.data?.find((r) => onlyDate(r.reportDate) === reportDate)
  }, [canViewAllReports, myReportsQuery.data, userReportsQuery.data, reportDate])

  const loading =
    (!canViewAllReports && myReportsQuery.isLoading) ||
    (canViewAllReports && userReportsQuery.isLoading)

  // Failed report fetch (network blip, server error) must surface as an
  // explicit retryable alert — never as a silently empty work log that the
  // user might overwrite without realizing the day's entries are missing.
  const reportsError = !canViewAllReports ? myReportsQuery.isError : userReportsQuery.isError
  const reportsRefetch = () => (!canViewAllReports ? myReportsQuery.refetch() : userReportsQuery.refetch())

  // Read-only without create_task_report (the server enforces it too) or
  // while viewing another user's log.
  const canCreateReport = can('create_task_report')
  const viewingOther = canViewAllReports && effectiveUserId !== user?.userId
  const isReadOnly = !canCreateReport || viewingOther
  const notice = viewingOther
    ? canCreateReport
      ? NOTICE_OTHER_USER_CAN_LOG
      : NOTICE_OTHER_USER
    : !canCreateReport
      ? NOTICE_CANNOT_LOG
      : null

  // ---- Monthly report export (per user, all tasks of the month) ----
  const exportMutation = useMutation({
    mutationFn: () =>
      taskReportsApi.exportMonth(exportMonth, canViewAllReports ? effectiveUserId : undefined),
    onSuccess: (data) => {
      // Human-readable linked names resolved from the reference lists
      // (a raw UUID column is useless in a report someone will read).
      const moduleById = new Map(flatModules.map((m) => [m.moduleId, m.name]))
      const tcById = new Map(testCases.map((t) => [t.testCaseId, t.title]))
      const bugById = new Map(bugs.map((b) => [b.bugId, b.title]))

      const rows: string[][] = [
        ['Date', 'Description', 'Minutes', 'Status', 'Linked Type', 'Linked To', 'Link'],
      ]
      let totalMinutes = 0
      let dayCount = 0
      for (const report of data.reports) {
        dayCount += 1
        rows.push([onlyDate(String(report.reportDate)), '', '', '', '', '', ''])
        for (const t of report.tasks) {
          totalMinutes += t.timeSpentMinutes
          let linkedType = '—'
          let linkedName = '—'
          if (t.moduleId) {
            linkedType = 'Module'
            linkedName = moduleById.get(t.moduleId) ?? t.moduleId
          } else if (t.testCaseId) {
            linkedType = 'Test case'
            linkedName = tcById.get(t.testCaseId) ?? t.testCaseId
          } else if (t.bugId) {
            linkedType = 'Bug'
            linkedName = bugById.get(t.bugId) ?? t.bugId
          }
          rows.push([
            onlyDate(String(report.reportDate)),
            t.description,
            String(t.timeSpentMinutes),
            t.status,
            linkedType,
            linkedName,
            t.linkUrl ?? '',
          ])
        }
        if (report.notes) {
          rows.push([onlyDate(String(report.reportDate)), 'Notes', '', '', '', '', report.notes])
        }
      }
      rows.push([])
      rows.push(['Summary', `${data.user.fullName} — ${data.month}`, '', '', '', '', ''])
      rows.push(['Days logged', String(dayCount)])
      rows.push(['Total minutes', String(totalMinutes)])
      rows.push(['Total hours', (totalMinutes / 60).toFixed(2)])

      const slug = data.user.fullName.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      downloadCsv(`worklog-${slug}-${exportMonth}.csv`, rows)
      toast.success(`Monthly report exported (${dayCount} day${dayCount === 1 ? '' : 's'})`)
    },
    onError: (err: unknown) => handleApiError(err, 'Failed to export the monthly report'),
  })

  return (
    <div className="space-y-4">
      <PageHeader
        title="Daily Work Log"
        description="Log what you worked on, time spent, and link it to modules, test cases, or bugs."
        actions={
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="report-date" className="text-xs">Date</Label>
              <Input
                id="report-date"
                type="date"
                className="w-44"
                value={reportDate}
                onChange={(e) => setReportDate(e.target.value)}
              />
            </div>
            {canViewAllReports && (
              <div className="space-y-1.5">
                <Label htmlFor="user-select" className="text-xs">User</Label>
                <Select value={effectiveUserId} onValueChange={setSelectedUserId}>
                  <SelectTrigger id="user-select" className="w-56 min-w-0 [&>span]:truncate">
                    <SelectValue placeholder="Select user" />
                  </SelectTrigger>
                  <SelectContent className="max-h-64">
                    {(allUsersQuery.data ?? []).map((u) => (
                      <SelectItem key={u.userId} value={u.userId} className="truncate max-w-[320px]">
                        {u.fullName} · {u.role.replace('_', ' ')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="export-month" className="text-xs">Monthly report</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="export-month"
                  type="month"
                  className="w-40"
                  value={exportMonth}
                  max={todayISO().slice(0, 7)}
                  onChange={(e) => setExportMonth(e.target.value)}
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={exportMutation.isPending || !exportMonth}
                  onClick={() => exportMutation.mutate()}
                  title="Download every task logged in this month as a CSV report"
                >
                  {exportMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <FileSpreadsheet className="h-4 w-4" />
                  )}
                  Export
                </Button>
              </div>
            </div>
          </div>
        }
      />

      {notice && (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      {reportsError ? (
        <QueryErrorAlert
          title="Could not load the work log"
          message="Avoid saving until it loads, so today's entries are not overwritten."
          onRetry={reportsRefetch}
        />
      ) : null}

      {loading ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-20" />)}
          </div>
          <Card>
            <CardContent className="space-y-3 pt-6">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </CardContent>
          </Card>
        </div>
      ) : (
        <TaskReportForm
          // Keying by reportDate + userId + reportId ensures local state is reinitialized
          // from the latest server data whenever the underlying report changes.
          key={`${effectiveUserId}-${reportDate}-${reportForDate?.taskReportId ?? 'new'}`}
          reportDate={reportDate}
          initialTasks={reportForDate?.tasks ?? []}
          initialNotes={reportForDate?.notes ?? ''}
          isReadOnly={isReadOnly}
          flatModules={flatModules}
          testCases={testCases}
          bugs={bugs}
        />
      )}
    </div>
  )
}

interface TaskReportFormProps {
  reportDate: string
  initialTasks: TaskItem[]
  initialNotes: string
  isReadOnly: boolean
  flatModules: Module[]
  testCases: TestCase[]
  bugs: Bug[]
}

function TaskReportForm({
  reportDate,
  initialTasks,
  initialNotes,
  isReadOnly,
  flatModules,
  testCases,
  bugs,
}: TaskReportFormProps) {
  const qc = useQueryClient()

  // Initialize editable state once from props (lazy initializer).
  const [tasks, setTasks] = useState<TaskRow[]>(() =>
    initialTasks.length ? initialTasks.map(withLinkType) : isReadOnly ? [] : [{ ...EMPTY_TASK }]
  )
  const [notes, setNotes] = useState<string>(initialNotes)

  const totalMinutes = useMemo(
    () => tasks.reduce((sum, t) => sum + (Number(t.timeSpentMinutes) || 0), 0),
    [tasks]
  )
  const statusCounts = useMemo(() => {
    const c = { done: 0, in_progress: 0, blocked: 0 }
    for (const t of tasks) c[t.status] = (c[t.status] ?? 0) + 1
    return c
  }, [tasks])

  const saveMutation = useMutation({
    mutationFn: (vars: { reportDate: string; tasks: TaskItem[]; notes: string }) =>
      taskReportsApi.upsert({
        reportDate: vars.reportDate,
        tasks: vars.tasks.filter((t) => t.description.trim().length > 0),
        notes: vars.notes,
      }),
    onSuccess: () => {
      toast.success('Task report saved')
      invalidateAfterMutation(qc, 'tasks')
    },
    onError: (err: unknown) => {
      handleApiError(err, 'Failed to save')
    },
  })

  function updateTask(idx: number, patch: Partial<TaskRow>) {
    setTasks((prev) => prev.map((t, i) => (i === idx ? { ...t, ...patch } : t)))
  }

  function addTask() {
    setTasks((prev) => [...prev, { ...EMPTY_TASK }])
  }

  function removeTask(idx: number) {
    setTasks((prev) => prev.filter((_, i) => i !== idx))
  }

  function handleSave() {
    if (isReadOnly) return
    // Validate every row so entries are "added properly": nothing is silently
    // dropped and the user is told exactly which row needs fixing.
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i]
      const hasDescription = t.description.trim().length > 0
      const hasLink = t.linkType !== 'none'
      if (!hasDescription && (t.timeSpentMinutes > 0 || hasLink)) {
        toast.error(`Task ${i + 1}: add a description before saving`)
        return
      }
      if (hasDescription && (!t.timeSpentMinutes || t.timeSpentMinutes <= 0)) {
        toast.error(`Task ${i + 1}: add the time spent in minutes`)
        return
      }
      if (hasDescription && hasLink) {
        const linkedId =
          t.linkType === 'module'
            ? t.moduleId
            : t.linkType === 'test_case'
            ? t.testCaseId
            : t.bugId
        if (!linkedId) {
          toast.error(
            `Task ${i + 1}: select a ${LINK_TYPE_LABEL[t.linkType].toLowerCase()} or set “Linked to” back to No link`
          )
          return
        }
      }
      if (hasDescription && t.linkUrl && t.linkUrl.trim() && !URL_PATTERN.test(t.linkUrl.trim())) {
        toast.error(`Task ${i + 1}: the link must be a valid URL starting with http:// or https://`)
        return
      }
    }
    saveMutation.mutate({
      reportDate,
      tasks: tasks.filter((t) => t.description.trim().length > 0).map(toTaskItem),
      notes,
    })
  }

  function handleExportCSV() {
    const rows: (string)[][] = [
      ['Date', 'Description', 'Minutes', 'Status', 'Linked Type', 'Linked ID', 'Link'],
    ]
    for (const t of tasks) {
      let linkedType = '—'
      let linkedId = '—'
      if (t.moduleId) {
        linkedType = 'module'
        linkedId = t.moduleId
      } else if (t.testCaseId) {
        linkedType = 'test_case'
        linkedId = t.testCaseId
      } else if (t.bugId) {
        linkedType = 'bug'
        linkedId = t.bugId
      }
      rows.push([
        reportDate,
        t.description,
        String(t.timeSpentMinutes),
        t.status,
        linkedType,
        linkedId,
        t.linkUrl ?? '',
      ])
    }
    rows.push([])
    rows.push(['Notes', notes])
    rows.push(['Total minutes', String(totalMinutes)])

    downloadCsv(`tasks-${reportDate}.csv`, rows)
    toast.success('CSV exported')
  }

  return (
    <>
      {/* Day summary strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={Clock}
          label="Total logged"
          value={minutesToHuman(totalMinutes)}
          accent
        />
        <StatCard icon={ListTodo} label="Entries" value={String(tasks.length)} />
        <StatCard
          icon={CheckCircle2}
          label="Done"
          value={String(statusCounts.done)}
          tone="text-emerald-600"
        />
        <StatCard
          icon={Ban}
          label="Blocked"
          value={String(statusCounts.blocked)}
          tone={statusCounts.blocked > 0 ? 'text-rose-600' : undefined}
        />
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-muted-foreground" />
            <span className="min-w-0 truncate">
              Tasks for {reportDate}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {tasks.length} {tasks.length === 1 ? 'entry' : 'entries'} · {minutesToHuman(totalMinutes)}
              </span>
            </span>
          </CardTitle>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportCSV}
              disabled={tasks.length === 0}
            >
              <Download className="h-4 w-4" /> Export CSV
            </Button>
            {!isReadOnly && (
              <Button size="sm" variant="outline" onClick={addTask}>
                <Plus className="h-4 w-4" /> Add task
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {tasks.length === 0 ? (
            <div className="py-12 flex flex-col items-center gap-3 text-center">
              <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center">
                <ListTodo className="h-6 w-6 text-muted-foreground" />
              </div>
              {isReadOnly ? (
                <p className="text-sm font-medium">No tasks logged for {reportDate}.</p>
              ) : (
                <>
                  <div>
                    <p className="text-sm font-medium">No tasks logged yet</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Add your first entry for {reportDate}.
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={addTask}>
                    <Plus className="h-4 w-4 mr-1" /> Add task
                  </Button>
                </>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {tasks.map((t, idx) => (
                <TaskRowCard
                  key={idx}
                  idx={idx}
                  task={t}
                  isReadOnly={isReadOnly}
                  flatModules={flatModules}
                  testCases={testCases}
                  bugs={bugs}
                  onRemove={() => removeTask(idx)}
                  onUpdate={(patch) => updateTask(idx, patch)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Notes</CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea
            placeholder="Add any notes, blockers, context…"
            value={notes}
            disabled={isReadOnly}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            maxLength={4000}
          />
        </CardContent>
      </Card>

      <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 sticky bottom-0 z-20 bg-background p-3 rounded-lg border shadow-md">
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="text-sm bg-background">
            <Clock className="h-3.5 w-3.5 mr-1 text-muted-foreground" />
            Total: <span className="ml-1 font-semibold">{minutesToHuman(totalMinutes)}</span>
          </Badge>
          <span className="text-xs text-muted-foreground">
            {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'} · {statusCounts.done} done
            {statusCounts.blocked > 0 ? ` · ${statusCounts.blocked} blocked` : ''}
          </span>
        </div>
        {!isReadOnly && (
          <Button onClick={handleSave} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save report
          </Button>
        )}
      </div>
      {/* Spacer so page content can always scroll clear of the sticky save bar
          instead of being hidden/click-blocked behind it. */}
      <div aria-hidden className="h-2" />
    </>
  )
}

// ---------- Pieces ----------

function StatCard({
  icon: Icon,
  label,
  value,
  accent,
  tone,
}: {
  icon: typeof Clock
  label: string
  value: string
  accent?: boolean
  tone?: string
}) {
  return (
    <div
      className={cn(
        'rounded-lg border p-3 flex items-center gap-3 bg-background',
        accent && 'border-emerald-200 bg-emerald-50/50 dark:border-emerald-500/25 dark:bg-emerald-500/10'
      )}
    >
      <div className={cn(
        'h-9 w-9 rounded-md flex items-center justify-center shrink-0',
        accent ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' : 'bg-muted text-muted-foreground'
      )}>
        <Icon className="h-4.5 w-4.5" />
      </div>
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground truncate">{label}</div>
        <div className={cn('text-lg font-semibold leading-tight truncate', tone)}>{value}</div>
      </div>
    </div>
  )
}

const LINK_TYPE_LABEL: Record<LinkType, string> = {
  none: 'No link',
  module: 'Module',
  test_case: 'Test case',
  bug: 'Bug',
}

function TaskRowCard({
  idx,
  task,
  isReadOnly,
  flatModules,
  testCases,
  bugs,
  onRemove,
  onUpdate,
}: {
  idx: number
  task: TaskRow
  isReadOnly: boolean
  flatModules: Module[]
  testCases: TestCase[]
  bugs: Bug[]
  onRemove: () => void
  onUpdate: (patch: Partial<TaskRow>) => void
}) {
  const linkType = task.linkType
  const statusMeta = TASK_STATUS_META[task.status]

  return (
    <div className={cn(
      'rounded-lg border p-3 space-y-2.5 transition',
      isReadOnly ? 'bg-muted/20' : 'bg-background hover:border-border'
    )}>
      {/* Row 1: entry number + description + remove */}
      <div className="flex items-start gap-2">
        <span className="text-xs text-muted-foreground font-mono w-5 shrink-0 pt-2.5 text-right">
          {idx + 1}
        </span>
        <Textarea
          placeholder="What did you work on? e.g. Executed regression suite for Payments module"
          value={task.description}
          disabled={isReadOnly}
          rows={2}
          maxLength={500}
          className="min-h-0 resize-none field-sizing-content"
          onChange={(e) => onUpdate({ description: e.target.value })}
        />
        <div className="shrink-0 pt-0.5">
          {!isReadOnly ? (
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 text-muted-foreground hover:text-rose-600"
              onClick={onRemove}
              aria-label={`Remove task ${idx + 1}`}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          ) : (
            <div className="h-8 w-8" />
          )}
        </div>
      </div>

      {/* Row 2: minutes / status / link type / linked entity */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:pl-7">
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">Minutes</Label>
          <Input
            type="number"
            min={0}
            max={1440}
            placeholder="min"
            value={task.timeSpentMinutes || ''}
            disabled={isReadOnly}
            onChange={(e) =>
              onUpdate({
                timeSpentMinutes: Math.min(1440, Math.max(0, Number(e.target.value) || 0)),
              })
            }
          />
        </div>

        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">Status</Label>
          <Select
            value={task.status}
            disabled={isReadOnly}
            onValueChange={(v) => onUpdate({ status: v as TaskItem['status'] })}
          >
            <SelectTrigger className="w-full min-w-0">
              <span className="flex items-center gap-1.5 min-w-0">
                <span className={cn('h-2 w-2 rounded-full shrink-0', statusMeta.dot)} />
                <span className="truncate">{statusMeta.label}</span>
              </span>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(TASK_STATUS_META) as TaskItem['status'][]).map((s) => (
                <SelectItem key={s} value={s}>
                  <span className="flex items-center gap-1.5">
                    <span className={cn('h-2 w-2 rounded-full', TASK_STATUS_META[s].dot)} />
                    {TASK_STATUS_META[s].label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">Linked to</Label>
          <Select
            value={linkType}
            disabled={isReadOnly}
            onValueChange={(v) => {
              // Record the chosen link type and clear any previous entity
              // binding — the entity picker below then offers matching options.
              onUpdate({
                linkType: v as LinkType,
                moduleId: null,
                testCaseId: null,
                bugId: null,
              })
            }}
          >
            <SelectTrigger className="w-full min-w-0 [&>span]:truncate">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No link</SelectItem>
              <SelectItem value="module">Module</SelectItem>
              <SelectItem value="test_case">Test case</SelectItem>
              <SelectItem value="bug">Bug</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">
            {linkType === 'none' ? 'Entity' : `Select ${LINK_TYPE_LABEL[linkType]}`}
          </Label>
          <Select
            value={
              linkType === 'module'
                ? task.moduleId ?? ''
                : linkType === 'test_case'
                ? task.testCaseId ?? ''
                : task.bugId ?? ''
            }
            disabled={isReadOnly || linkType === 'none'}
            onValueChange={(v) => {
              if (linkType === 'module') onUpdate({ moduleId: v })
              else if (linkType === 'test_case') onUpdate({ testCaseId: v })
              else if (linkType === 'bug') onUpdate({ bugId: v })
            }}
          >
            {/* NOTE: SelectTrigger must always live inside <Select> — a bare
                trigger (previous "no link" placeholder) crashed the page. */}
            <SelectTrigger className="w-full min-w-0 [&>span]:truncate">
              <SelectValue
                placeholder={linkType === 'none' ? '—' : `Select ${LINK_TYPE_LABEL[linkType].toLowerCase()}`}
              />
            </SelectTrigger>
            <SelectContent className="max-h-64">
                {linkType === 'module' &&
                  flatModules.map((m) => (
                    <SelectItem
                      key={m.moduleId}
                      value={m.moduleId}
                      className="truncate max-w-[320px]"
                      title={m.name}
                    >
                      {'— '.repeat(Math.max(0, m.depth))}{m.name}
                    </SelectItem>
                  ))}
                {linkType === 'test_case' &&
                  testCases.map((tc) => (
                    <SelectItem
                      key={tc.testCaseId}
                      value={tc.testCaseId}
                      className="truncate max-w-[320px]"
                      title={tc.title}
                    >
                      {tc.title}
                    </SelectItem>
                  ))}
                {linkType === 'bug' &&
                  bugs.map((b) => (
                    <SelectItem
                      key={b.bugId}
                      value={b.bugId}
                      className="truncate max-w-[320px]"
                      title={b.title}
                    >
                      {b.title}
                    </SelectItem>
                  ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Row 3: optional external reference link (ticket, doc, PR…) */}
      <div className="md:pl-7">
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">Link (optional)</Label>
          <div className="flex items-center gap-2">
            <Input
              type="url"
              inputMode="url"
              placeholder="https://ticket, document or pull request"
              value={task.linkUrl ?? ''}
              disabled={isReadOnly}
              maxLength={500}
              onChange={(e) => onUpdate({ linkUrl: e.target.value })}
            />
            {task.linkUrl && URL_PATTERN.test(task.linkUrl.trim()) && (
              <a
                href={task.linkUrl.trim()}
                target="_blank"
                rel="noreferrer"
                className="shrink-0"
                aria-label="Open link in a new tab"
                title="Open link"
              >
                <Button type="button" size="icon" variant="ghost" className="h-9 w-9" tabIndex={-1}>
                  <ExternalLink className="h-4 w-4" />
                </Button>
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
