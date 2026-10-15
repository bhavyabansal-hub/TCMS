'use client'

import { useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Filter, X } from 'lucide-react'

import { REFERENCE_STALE_TIME_MS, activityLogsApi, usersApi } from '@/lib/client/api'
import { useAuthStore, useViewStore, type ViewKey } from '@/store'
import type { ActivityLog, UserOption } from '@/types'
import { actionColor, formatDateTime, initials } from '@/lib/format'
import { navigateForEntity } from '@/lib/navigation'

import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { PermissionDenied } from '@/components/shared/permission-denied'
import { StateLoading } from '@/components/shared/state'
import { PaginationFooter } from '@/components/shared/pagination'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

const ENTITY_TYPES = ['module', 'test_case', 'review', 'bug', 'task_report', 'user'] as const
const ACTION_TYPES = [
  'CREATE',
  'UPDATE',
  'DELETE',
  'STATUS',
  'LOGIN',
  'REVIEW',
] as const

export function ActivityLogView() {
  const { user, can } = useAuthStore()
  const navigate = useViewStore((s) => s.navigate)
  const [page, setPage] = useState(1)
  const pageSize = 50
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [userId, setUserId] = useState('all')
  const [entityType, setEntityType] = useState('all')
  const [action, setAction] = useState('all')
  const [selected, setSelected] = useState<ActivityLog | null>(null)

  // Picker rows (any authenticated user) — not the manage_users-gated list.
  const optionsQuery = useQuery({
    queryKey: ['users', 'options'],
    staleTime: REFERENCE_STALE_TIME_MS,
    queryFn: usersApi.options,
  })

  const params = useMemo(() => {
    const p: Record<string, string> = {
      page: String(page),
      pageSize: String(pageSize),
    }
    if (userId !== 'all') p.userId = userId
    if (entityType !== 'all') p.entityType = entityType
    if (action !== 'all') p.action = action
    if (dateFrom) p.dateFrom = dateFrom
    if (dateTo) p.dateTo = dateTo
    return p
  }, [page, pageSize, userId, entityType, action, dateFrom, dateTo])

  const logsQuery = useQuery({
    queryKey: ['activity-logs', params],
    queryFn: () => activityLogsApi.list(params),
    placeholderData: keepPreviousData,
  })

  // In-view guard, consistent with reports / settings views: the matrix
  // decides, the sidebar is only the first layer. (After all hooks — rules
  // of hooks.)
  if (user && !can('view_activity_logs')) {
    return <PermissionDenied description="The activity log is only available to roles with view-activity-log rights." />
  }

  const users = (optionsQuery.data ?? []) as UserOption[]
  const logs = logsQuery.data?.data ?? []
  const total = logsQuery.data?.total ?? 0
  const totalPages = logsQuery.data?.totalPages ?? 1

  function resetFilters() {
    setPage(1)
    setUserId('all')
    setEntityType('all')
    setAction('all')
    setDateFrom('')
    setDateTo('')
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Activity Log</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Full audit trail of every change across the system.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Filter className="h-4 w-4" /> Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">From</Label>
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => {
                  setDateFrom(e.target.value)
                  setPage(1)
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">To</Label>
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => {
                  setDateTo(e.target.value)
                  setPage(1)
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">User</Label>
              <Select
                value={userId}
                onValueChange={(v) => {
                  setUserId(v)
                  setPage(1)
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All users</SelectItem>
                  {users.map((u) => (
                    <SelectItem key={u.userId} value={u.userId}>
                      {u.fullName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Entity</Label>
              <Select
                value={entityType}
                onValueChange={(v) => {
                  setEntityType(v)
                  setPage(1)
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All entities</SelectItem>
                  {ENTITY_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t.replace(/_/g, ' ')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Action</Label>
              <Select
                value={action}
                onValueChange={(v) => {
                  setAction(v)
                  setPage(1)
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All actions</SelectItem>
                  {ACTION_TYPES.map((a) => (
                    <SelectItem key={a} value={a}>
                      {a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex justify-end mt-3">
            <Button variant="ghost" size="sm" onClick={resetFilters}>
              <X className="h-3 w-3 mr-1" /> Reset
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {logsQuery.isLoading ? (
            <StateLoading rows={8} className="p-4" />
          ) : logsQuery.isError ? (
            <Alert variant="destructive" className="m-4">
              <AlertDescription>Failed to load activity logs.</AlertDescription>
            </Alert>
          ) : logs.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No activity matching your filters.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-40">Timestamp</TableHead>
                  <TableHead className="min-w-44">User</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Entity</TableHead>
                  <TableHead className="min-w-48">Name</TableHead>
                  <TableHead className="text-right">Changes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log) => {
                  const diffCount = log.diff ? Object.keys(log.diff).length : 0
                  return (
                    <TableRow
                      key={log.activityLogId}
                      className="cursor-pointer"
                      onClick={() => setSelected(log)}
                    >
                      <TableCell className="text-xs text-muted-foreground tabular-nums">
                        {formatDateTime(log.createdAt)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2 min-w-0">
                          <Avatar className="h-6 w-6">
                            {log.user?.avatarUrl && <AvatarImage src={log.user.avatarUrl} alt={log.user.fullName} />}
                            <AvatarFallback className="text-[10px] bg-slate-100 text-slate-700 dark:bg-slate-400/15 dark:text-slate-300">
                              {log.user ? initials(log.user.fullName) : '?'}
                            </AvatarFallback>
                          </Avatar>
                          <span className="text-sm truncate">
                            {log.user?.fullName ?? 'System'}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`capitalize ${actionColor(log.action)}`}>
                          {log.action}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="capitalize">
                          {log.entityType.replace(/_/g, ' ')}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <button
                          className="text-sm text-left text-foreground hover:underline max-w-xs truncate"
                          onClick={(e) => {
                            e.stopPropagation()
                            navigateForEntity(log.entityType, log.entityId, navigate)
                          }}
                        >
                          {log.entityName ?? '—'}
                        </button>
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {diffCount > 0 ? (
                          <Badge variant="outline">{diffCount} field{diffCount === 1 ? '' : 's'}</Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <PaginationFooter
        page={page}
        totalPages={totalPages}
        total={total}
        singular="entry"
        plural="entries"
        isFetching={logsQuery.isFetching}
        onPageChange={setPage}
      />

      <ActivityDetailDialog log={selected} onClose={() => setSelected(null)} />
    </div>
  )
}

function ActivityDetailDialog({
  log,
  onClose,
}: {
  log: ActivityLog | null
  onClose: () => void
}) {
  if (!log) return null
  const diffEntries = log.diff ? Object.entries(log.diff) : []
  return (
    <Dialog open={!!log} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={actionColor(log.action)}>
              {log.action}
            </Badge>
            <Badge variant="secondary" className="capitalize">
              {log.entityType.replace(/_/g, ' ')}
            </Badge>
            <span className="text-base font-medium truncate">{log.entityName ?? '—'}</span>
          </DialogTitle>
          <DialogDescription>
            {log.user?.fullName ?? 'System'} · {formatDateTime(log.createdAt)}
            {log.ipAddress ? ` · IP ${log.ipAddress}` : ''}
          </DialogDescription>
        </DialogHeader>

        {diffEntries.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            No field-level changes recorded.
          </div>
        ) : (
          <div className="space-y-2">
            <div className="text-sm font-medium">Changed fields ({diffEntries.length})</div>
            <div className="space-y-2 max-h-[55vh] overflow-y-auto pr-1">
              {diffEntries.map(([field, change]) => (
                <DiffRow
                  key={field}
                  field={field}
                  before={(change as { before: unknown })?.before}
                  after={(change as { after: unknown })?.after}
                />
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function DiffRow({
  field,
  before,
  after,
}: {
  field: string
  before: unknown
  after: unknown
}) {
  const beforeStr = formatValue(before)
  const afterStr = formatValue(after)
  return (
    <div className="rounded-md border p-2 text-xs">
      <div className="font-mono font-semibold text-foreground mb-1.5">{field}</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div className="rounded bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900 p-2">
          <div className="text-[10px] uppercase tracking-wide text-rose-700 dark:text-rose-300 mb-1">
            Before
          </div>
          <pre className="whitespace-pre-wrap break-words line-through text-rose-800 dark:text-rose-200">
            {beforeStr}
          </pre>
        </div>
        <div className="rounded bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 p-2">
          <div className="text-[10px] uppercase tracking-wide text-emerald-700 dark:text-emerald-300 mb-1">
            After
          </div>
          <pre className="whitespace-pre-wrap break-words text-emerald-800 dark:text-emerald-200">
            {afterStr}
          </pre>
        </div>
      </div>
    </div>
  )
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}
