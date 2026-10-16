'use client'

import { useState, useMemo, useEffect, useRef } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Search, Filter, Download, Pencil, Trash2, Eye, Loader2, RotateCcw } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Textarea } from '@/components/ui/textarea'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Checkbox } from '@/components/ui/checkbox'
import { REFERENCE_STALE_TIME_MS, modulesApi, testCasesApi } from '@/lib/client/api'
import { invalidateAfterMutation } from '@/lib/client/invalidate'
import { downloadTextFile } from '@/lib/client/download'
import { useAuthStore, useViewStore } from '@/store'
import { statusColor, formatDateTime, truncate } from '@/lib/format'
import { handleApiError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { toCsv } from '@/lib/csv-export'
import { Pagination } from '@/components/shared/pagination'
import { StateLoading, EmptyState } from '@/components/shared/state'
import { QueryErrorAlert } from '@/components/shared/query-error'
import { PriorityBadge, StatusBadge } from '@/components/shared/badges'
import { PageHeader } from '@/components/shared/page-header'
import { ImportTestCasesPanel } from '@/components/views/test-case-import'
import { toast } from 'sonner'
import { FileText } from 'lucide-react'
import { PRIORITIES } from '@/types'
import type { Module, TestCase, Priority, TestCaseStatus } from '@/types'

const STATUSES: TestCaseStatus[] = ['draft', 'in_review', 'needs_revision', 'approved', 'active', 'deprecated']

export function TestCasesView() {
  const user = useAuthStore((s) => s.user)
  const can = useAuthStore((s) => s.can)
  const navigate = useViewStore((s) => s.navigate)
  const qc = useQueryClient()
  // Filters initialize from the URL params (deep links like
  // /test-cases?moduleId=… from a module's "View all" or global search land
  // pre-filtered) and re-sync whenever the ROUTE params change (back/forward,
  // re-navigation) — guarded by a ref so manual edits never bounce back.
  const routeParams = useViewStore((s) => s.params)
  const routeModuleId = routeParams.moduleId
  const routeStatus = routeParams.status
  const routePriority = routeParams.priority
  const routeQuery = routeParams.q
  const [search, setSearch] = useState(routeQuery ?? '')
  const [statusFilter, setStatusFilter] = useState<string>(routeStatus ?? '')
  const [priorityFilter, setPriorityFilter] = useState<string>(routePriority ?? '')
  const [moduleFilter, setModuleFilter] = useState<string>(routeModuleId ?? '')
  const [page, setPage] = useState(1)
  const routeFilterKey = `${routeModuleId ?? ''}|${routeStatus ?? ''}|${routePriority ?? ''}|${routeQuery ?? ''}`
  const appliedRouteKey = useRef(routeFilterKey)
  useEffect(() => {
    if (appliedRouteKey.current === routeFilterKey) return
    appliedRouteKey.current = routeFilterKey
    setModuleFilter(routeModuleId ?? '')
    setStatusFilter(routeStatus ?? '')
    setPriorityFilter(routePriority ?? '')
    setSearch(routeQuery ?? '')
    setPage(1)
  }, [routeFilterKey, routeModuleId, routeStatus, routePriority, routeQuery])
  const [createOpen, setCreateOpen] = useState(false)
  const [tab, setTab] = useState<'all' | 'import'>('all')
  const canCreate = !!user && can('create_test_case')
  // Bulk delete (owner ask): tick any rows — or the whole page — and remove
  // them permanently in one go. Matrix-driven: delete_test_case holders only.
  const canBulkDelete = !!user && can('delete_test_case')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // Any filter/page change invalidates what the ticks point at — clear them.
  useEffect(() => {
    setSelected(new Set())
  }, [search, statusFilter, priorityFilter, moduleFilter, page])
  // Cross-account safety: an import tab state must never outlive its permission.
  const activeTab: 'all' | 'import' = tab === 'import' && canCreate ? 'import' : 'all'

  const { data, isLoading, isFetching, isError, refetch } = useQuery({
    queryKey: ['test-cases', 'list', { search, statusFilter, priorityFilter, moduleFilter, page }],
    queryFn: () =>
      testCasesApi.list({
        search,
        status: statusFilter,
        priority: priorityFilter,
        moduleId: moduleFilter,
        page,
        pageSize: 20,
      }),
    placeholderData: keepPreviousData,
  })

  const { data: treeData } = useQuery({
    queryKey: ['modules', 'tree'],
    staleTime: REFERENCE_STALE_TIME_MS,
    queryFn: modulesApi.tree,
  })

  const flatModules = useMemo(() => treeData?.flat ?? [], [treeData])

  function exportCsv() {
    if (!data?.data?.length) {
      toast.error('No data to export')
      return
    }
    // Quoted + formula-injection safe (src/lib/csv-export.ts, shared by every export).
    const headers = ['ID', 'Title', 'Module', 'Priority', 'Status', 'Tags', 'Author', 'Updated']
    const rows = data.data.map((tc) => [
      tc.testCaseId,
      tc.title,
      tc.module?.name ?? '',
      tc.priority,
      tc.status,
      tc.tags.join('; '),
      tc.author?.fullName ?? '',
      formatDateTime(tc.updatedAt),
    ])
    const csv = toCsv([headers, ...rows])
    downloadTextFile(`test-cases-${new Date().toISOString().slice(0, 10)}.csv`, csv)
    toast.success('Exported CSV')
  }

  /** Jump from the Import tab back to the list, filtered to what was just imported. */
  function handleImported(moduleId: string) {
    setSearch('')
    setStatusFilter('')
    setPriorityFilter('')
    setModuleFilter(moduleId)
    setPage(1)
    setTab('all')
  }

  const hasActiveFilters = !!search || !!statusFilter || !!priorityFilter || !!moduleFilter || page !== 1
  /** Wipe every filter and the URL query with it, so a copied link after
   * Reset shows the unfiltered list too (URL and UI stay consistent). */
  function resetFilters() {
    setSearch('')
    setStatusFilter('')
    setPriorityFilter('')
    setModuleFilter('')
    setPage(1)
    navigate('test-cases')
  }

  function toggleSelect(id: string) {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    const rows = data?.data ?? []
    if (rows.length === 0) return
    setSelected((s) => (rows.every((tc) => s.has(tc.testCaseId)) ? new Set() : new Set(rows.map((tc) => tc.testCaseId))))
  }

  async function handleBulkDelete() {
    if (selected.size === 0) return
    setDeleting(true)
    try {
      const res = await testCasesApi.bulkDelete([...selected])
      toast.success(`Deleted ${res.deleted} test case(s) permanently`)
      setConfirmDeleteOpen(false)
      setSelected(new Set())
      // One call refreshes every tab that shows test-case data: lists, module
      // trees/counts, dashboard stats, reviews and activity — all in the
      // background while each page keeps rendering its cached rows.
      invalidateAfterMutation(qc, 'testCases')
    } catch (err) {
      handleApiError(err, 'Failed to delete the selected test cases')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Test Cases"
        description="All test cases across all modules"
        actions={
          activeTab === 'all' ? (
            <>
              <Button variant="outline" onClick={exportCsv}>
                <Download className="h-4 w-4 mr-1" /> Export CSV
              </Button>
              {/* Matrix-driven: only create_test_case holders see the create button. */}
              {canCreate && (
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus className="h-4 w-4 mr-1" /> New Test Case
                </Button>
              )}
            </>
          ) : undefined
        }
      />

      {/* List / Import tabs — Import only exists for create_test_case holders. */}
      <Tabs value={activeTab} onValueChange={(v) => setTab(v as 'all' | 'import')}>
        <TabsList>
          <TabsTrigger value="all">All Test Cases</TabsTrigger>
          {canCreate && <TabsTrigger value="import">Import CSV</TabsTrigger>}
        </TabsList>
      </Tabs>

      {activeTab === 'import' && <ImportTestCasesPanel onImported={handleImported} />}

      {activeTab === 'all' && (
      <>
      {/* Toolbar — the filter row is ALWAYS visible and is never replaced.
          Bulk delete lives on its own permanent row right under the filters:
          Delete / Clear render even with nothing selected (merely disabled),
          so ticking rows only flips their enabled state — no element is
          added or removed and nothing on the page ever moves. */}
      <Card>
        <CardContent className="p-3 space-y-3">
          <div className="flex flex-col md:flex-row gap-2 items-start md:items-center">
            <div className="relative flex-1 w-full">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by title..."
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  setPage(1)
                }}
                className="pl-9"
              />
            </div>
            {/* Silent background refresh while filters/pages change — the list
                keeps showing the previous data instead of a skeleton flash. */}
            {isFetching && !isLoading && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground whitespace-nowrap">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Refreshing…
              </div>
            )}
            <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v === 'all' ? '' : v); setPage(1) }}>
              <SelectTrigger className="w-full md:w-40"><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {STATUSES.map((s) => <SelectItem key={s} value={s} className="capitalize">{s.replace('_', ' ')}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={priorityFilter} onValueChange={(v) => { setPriorityFilter(v === 'all' ? '' : v); setPage(1) }}>
              <SelectTrigger className="w-full md:w-32"><SelectValue placeholder="Priority" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All priorities</SelectItem>
                {PRIORITIES.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={moduleFilter} onValueChange={(v) => { setModuleFilter(v === 'all' ? '' : v); setPage(1) }}>
              <SelectTrigger className="w-full md:w-48"><SelectValue placeholder="Module" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All modules</SelectItem>
                {flatModules.map((m) => <SelectItem key={m.moduleId} value={m.moduleId}>{m.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {/* Always rendered, disabled until there is something to reset —
                same never-appears/disappears discipline as the delete row. */}
            <Button
              variant="outline"
              disabled={!hasActiveFilters}
              onClick={resetFilters}
              className="whitespace-nowrap"
            >
              <RotateCcw className="h-4 w-4" /> Reset
            </Button>
          </div>

          {/* Permanent selection action row (delete-permission users only).
              Same height whether idle or active → guaranteed zero shift. */}
          {canBulkDelete && (
            <div className="flex flex-wrap items-center gap-2 pt-3 border-t">
              {selected.size > 0 ? (
                <>
                  <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1.5 text-[11px] font-bold tabular-nums text-white">
                    {selected.size}
                  </span>
                  <span className="text-sm font-medium whitespace-nowrap">
                    test case{selected.size === 1 ? '' : 's'} selected
                  </span>
                </>
              ) : (
                <span className="text-sm text-muted-foreground whitespace-nowrap">
                  No test cases selected
                </span>
              )}
              <div className="ml-auto flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={selected.size === 0 || deleting}
                  onClick={() => setSelected(new Set())}
                >
                  Clear
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={selected.size === 0 || deleting}
                  onClick={() => setConfirmDeleteOpen(true)}
                >
                  {deleting ? (
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4 mr-1.5" />
                  )}
                  Delete
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {isError ? (
            <QueryErrorAlert
              className="m-4"
              title="Could not load test cases"
              onRetry={() => refetch()}
            />
          ) : isLoading ? (
            <StateLoading rows={8} className="p-4" />
          ) : !data?.data?.length ? (
            <EmptyState icon={Filter} message="No test cases match your filters" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {canBulkDelete && (
                    <TableHead className="w-10">
                      <Checkbox
                        aria-label="Select all on this page"
                        className="border-muted-foreground/70"
                        checked={
                          data.data.length > 0 && data.data.every((tc) => selected.has(tc.testCaseId))
                            ? true
                            : data.data.some((tc) => selected.has(tc.testCaseId))
                              ? 'indeterminate'
                              : false
                        }
                        onCheckedChange={toggleSelectAll}
                      />
                    </TableHead>
                  )}
                  <TableHead className="w-20">ID</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Module</TableHead>
                  <TableHead className="w-20">Priority</TableHead>
                  <TableHead className="w-28">Status</TableHead>
                  <TableHead>Tags</TableHead>
                  <TableHead>Author</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="w-20">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.data.map((tc) => (
                  <TableRow
                    key={tc.testCaseId}
                    className={cn(
                      'group/row cursor-pointer transition-colors',
                      selected.has(tc.testCaseId)
                        ? 'bg-rose-50/70 hover:bg-rose-100/70 dark:bg-rose-500/10 dark:hover:bg-rose-500/15'
                        : undefined
                    )}
                    onClick={() => navigate('test-case-detail', { id: tc.testCaseId })}
                  >
                    {canBulkDelete && (
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          aria-label={`Select ${tc.title}`}
                          checked={selected.has(tc.testCaseId)}
                          onCheckedChange={() => toggleSelect(tc.testCaseId)}
                          className="border-muted-foreground/70"
                        />
                      </TableCell>
                    )}
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {tc.testCaseId.slice(-6)}
                    </TableCell>
                    <TableCell className="font-medium max-w-xs">
                      <TestCaseTitleHover tc={tc} />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{tc.module?.name ?? '—'}</TableCell>
                    <TableCell>
                      <PriorityBadge priority={tc.priority} />
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={tc.status} colorClass={statusColor(tc.status)} />
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {tc.tags.slice(0, 2).map((t) => (
                          <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>
                        ))}
                        {tc.tags.length > 2 && (
                          <Badge variant="secondary" className="text-[10px]">+{tc.tags.length - 2}</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">{tc.author?.fullName ?? '—'}</TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {formatDateTime(tc.updatedAt)}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0"
                        onClick={(e) => {
                          e.stopPropagation()
                          navigate('test-case-detail', { id: tc.testCaseId })
                        }}
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {data && (
        <Pagination
          page={data.page}
          totalPages={data.totalPages}
          total={data.total}
          onPageChange={setPage}
        />
      )}
      </>
      )}

      {createOpen && (
        <CreateTestCaseDialog open={createOpen} onOpenChange={setCreateOpen} modules={flatModules} />
      )}

      {confirmDeleteOpen && (
        <Dialog open onOpenChange={setConfirmDeleteOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <div className="flex items-start gap-3.5">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-rose-100 dark:bg-rose-500/15">
                  <Trash2 className="h-5 w-5 text-rose-600 dark:text-rose-400" />
                </div>
                <div className="space-y-1.5">
                  <DialogTitle>
                    Delete {selected.size} test case{selected.size === 1 ? '' : 's'}?
                  </DialogTitle>
                  <DialogDescription>
                    The selected test cases will be removed from TCMS completely.
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
              <span className="font-semibold">This cannot be undone.</span> Review history,
              verdicts and bug links of the selected cases are removed with them.
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmDeleteOpen(false)}>Cancel</Button>
              <Button variant="destructive" onClick={handleBulkDelete} disabled={deleting} className="min-w-[11rem]">
                {deleting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Deleting…
                  </>
                ) : (
                  <>
                    <Trash2 className="h-4 w-4 mr-1.5" /> Delete {selected.size} permanently
                  </>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}


/**
 * Hover preview (owner request 2026-10-09): hovering a row's title reveals
 * the FULL test case in a non-modal card — description, preconditions,
 * expected result, tags and meta — without leaving the list. The list API
 * already returns every field (the repository selects tc.*), so the preview
 * costs ZERO extra requests. The trigger is a plain span, so the row's
 * onClick still navigates to the detail page — hover never steals the click.
 */
function TestCaseTitleHover({ tc }: { tc: TestCase }) {
  return (
    <HoverCard openDelay={250} closeDelay={120}>
      <HoverCardTrigger asChild>
        <span className="block max-w-xs truncate cursor-help decoration-dotted underline-offset-4 hover:underline">
          {truncate(tc.title, 60)}
        </span>
      </HoverCardTrigger>
      <HoverCardContent side="bottom" align="start" className="w-[26rem] p-0">
        <div className="space-y-3 p-4">
          {/* Full title (never truncated) + status chips */}
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-semibold leading-snug break-words">{tc.title}</p>
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <PriorityBadge priority={tc.priority} />
              <StatusBadge status={tc.status} colorClass={statusColor(tc.status)} />
              {tc.module && (
                <Badge variant="outline" className="text-[10px] max-w-40 truncate">{tc.module.name}</Badge>
              )}
            </div>
          </div>

          {/* Body — the three content fields, each clamped so an extreme
              case can never blow the card into the screen edge. */}
          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Description</p>
            <p className="text-sm whitespace-pre-wrap break-words line-clamp-10">
              {tc.description?.trim() || '—'}
            </p>
          </div>
          {tc.preconditions?.trim() && (
            <div className="space-y-1">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Preconditions</p>
              <p className="text-sm whitespace-pre-wrap break-words line-clamp-4">{tc.preconditions}</p>
            </div>
          )}
          {tc.expectedResult?.trim() && (
            <div className="space-y-1">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Expected result</p>
              <p className="text-sm whitespace-pre-wrap break-words line-clamp-4">{tc.expectedResult}</p>
            </div>
          )}

          {tc.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {tc.tags.slice(0, 6).map((t) => (
                <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>
              ))}
              {tc.tags.length > 6 && (
                <Badge variant="secondary" className="text-[10px]">+{tc.tags.length - 6}</Badge>
              )}
            </div>
          )}
        </div>

        {/* Meta footer: author + last update, separated by a hairline. */}
        <div className="flex items-center justify-between gap-3 border-t bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground">
          <span className="truncate">by {tc.author?.fullName ?? '—'}</span>
          <span className="whitespace-nowrap">Updated {formatDateTime(tc.updatedAt)}</span>
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}


function CreateTestCaseDialog({
  open,
  onOpenChange,
  modules,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  modules: Module[]
}) {
  const qc = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const [title, setTitle] = useState('')
  const [moduleId, setModuleId] = useState('')
  const [priority, setPriority] = useState<Priority>('P2')
  const [description, setDescription] = useState('')
  const [preconditions, setPreconditions] = useState('')
  const [expectedResult, setExpectedResult] = useState('')
  const [tags, setTags] = useState('')
  const [saving, setSaving] = useState(false)

  // Labels of the required fields, used by validation + the footer hint.
  const selectedModule = modules.find((m) => m.moduleId === moduleId)

  async function handleSave() {
    // Required-field gate: title, module and description are the core of a
    // test case — everything else stays optional to keep creation fast.
    if (!title.trim()) {
      toast.error('Title is required')
      return
    }
    if (!moduleId) {
      toast.error('Module is required — choose where this test case belongs')
      return
    }
    if (!description.trim()) {
      toast.error('Description is required — describe what this test case verifies')
      return
    }
    setSaving(true)
    try {
      // authorId is intentionally NOT sent — the backend always sets it to the logged-in user.
      const tc = await testCasesApi.create({
        title: title.trim(),
        moduleId,
        priority,
        description: description.trim(),
        preconditions: preconditions.trim() || undefined,
        expectedResult: expectedResult.trim() || undefined,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      })
      toast.success(`Test case "${tc.title}" created — you are the author`)
      // One call refreshes every tab that shows test-case data: the list you
      // are on, module trees/counts, dashboard stats, reviews, activity — all
      // in the background, so switching tabs shows the new case instantly.
      invalidateAfterMutation(qc, 'testCases')
      // OWNER RULE (2026-10-09): the create popup does NOT close and there is
      // NO redirect to the edit page — a success popup shows and the form
      // simply clears, so the next test case can be typed right away.
      setTitle('')
      setModuleId('')
      setPriority('P2')
      setDescription('')
      setPreconditions('')
      setExpectedResult('')
      setTags('')
    } catch (err) {
      handleApiError(err, 'Failed to create')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl w-[95vw] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Test Case</DialogTitle>
          <DialogDescription>
            Create a draft test case. You will be recorded as the author. After each create the form
            clears and stays open, so you can add the next case immediately — close it when you are done.
          </DialogDescription>
        </DialogHeader>

        {/* Fixed two-column rhythm: full-width rows for long text, paired
            columns for short choices. Every field container is min-w-0 so a
            long module name can never push the grid apart. */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5 md:col-span-2 min-w-0">
            <Label htmlFor="tc-title">Title *</Label>
            <Input
              id="tc-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. User can log in with valid credentials"
              maxLength={200}
            />
          </div>

          <div className="space-y-1.5 min-w-0">
            <Label htmlFor="tc-module">Module *</Label>
            <Select value={moduleId} onValueChange={setModuleId}>
              <SelectTrigger id="tc-module" className="w-full min-w-0 [&>span]:truncate">
                <SelectValue placeholder="Choose the module" />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                {modules.map((m) => (
                  <SelectItem key={m.moduleId} value={m.moduleId} className="truncate max-w-[280px]" title={m.name}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedModule && (
              <p className="text-[11px] text-muted-foreground truncate" title={selectedModule.name}>
                {selectedModule.name}
              </p>
            )}
          </div>

          <div className="space-y-1.5 min-w-0">
            <Label htmlFor="tc-priority">Priority</Label>
            <Select value={priority} onValueChange={(v) => setPriority(v as Priority)}>
              <SelectTrigger id="tc-priority" className="w-full min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRIORITIES.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5 md:col-span-2 min-w-0">
            <Label htmlFor="tc-desc">Description *</Label>
            <Textarea
              id="tc-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder="What exactly does this test case verify, and why does it matter?"
              maxLength={2000}
            />
          </div>

          <div className="space-y-1.5 md:col-span-2 min-w-0">
            <Label htmlFor="tc-tags">Tags (comma-separated, optional)</Label>
            <Input id="tc-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="smoke, regression" />
          </div>

          <div className="space-y-1.5 min-w-0">
            <Label htmlFor="tc-expected">Expected Result (optional)</Label>
            <Textarea
              id="tc-expected"
              value={expectedResult}
              onChange={(e) => setExpectedResult(e.target.value)}
              rows={3}
              maxLength={1000}
            />
          </div>

          <div className="space-y-1.5 min-w-0">
            <Label htmlFor="tc-pre">Preconditions (optional)</Label>
            <Textarea
              id="tc-pre"
              value={preconditions}
              onChange={(e) => setPreconditions(e.target.value)}
              rows={3}
              maxLength={1000}
            />
          </div>

          <div className="md:col-span-2 rounded-md border bg-muted/30 p-2.5 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Author:</span>{' '}
            {user?.fullName} ({user?.email})
            <div className="mt-0.5">The author is automatically recorded as you. Only you (or a senior manager) can delete this test case later.</div>
          </div>
        </div>

        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? 'Creating...' : 'Create Test Case'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
