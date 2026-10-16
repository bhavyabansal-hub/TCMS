'use client'

import { useState, useRef, type ReactNode, type RefObject } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable,
  useSensor, useSensors,
  type DragEndEvent, type DragStartEvent, type DragCancelEvent,
} from '@dnd-kit/core'
import { Plus, LayoutGrid, Table as TableIcon, Bug as BugIcon, Trash2, Pencil, GripVertical, Download } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { REFERENCE_STALE_TIME_MS, bugsApi, modulesApi, usersApi } from '@/lib/client/api'
import { invalidateAfterMutation } from '@/lib/client/invalidate'
import { downloadTextFile } from '@/lib/client/download'
import { useAuthStore } from '@/store'
import { bugStatusColor, severityDot, formatDateTime, formatDate, timeAgo } from '@/lib/format'
import { handleApiError } from '@/lib/errors'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { toCsv } from '@/lib/csv-export'
import type { Bug, BugStatus, Severity } from '@/types'
import { BUG_ASSIGNEE_ROLES } from '@/types'
import { SeverityBadge, StatusBadge } from '@/components/shared/badges'
import { DetailSection } from '@/components/shared/detail-field'
import { PageHeader } from '@/components/shared/page-header'
import { EmptyState } from '@/components/shared/state'
import { QueryErrorAlert } from '@/components/shared/query-error'

const BUG_STATUSES: BugStatus[] = ['open', 'in_progress', 'resolved', 'closed', 'wont_fix']
const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low']

const STATUS_LABEL: Record<BugStatus, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  closed: 'Closed',
  wont_fix: 'Won\u2019t Fix',
}

export function BugsView() {
  const user = useAuthStore((s) => s.user)
  const can = useAuthStore((s) => s.can)
  const canAny = useAuthStore((s) => s.canAny)
  // Matrix-driven action rights — every button below mirrors its backend gate.
  const canCreate = can('create_bug')
  const canTriage = canAny(['create_bug', 'assign_bug'])
  const canAssign = can('assign_bug')
  const canDelete = can('delete_bug')
  const qc = useQueryClient()
  const [view, setView] = useState<'kanban' | 'table'>('kanban')
  const [createOpen, setCreateOpen] = useState(false)
  const [detailBug, setDetailBug] = useState<Bug | null>(null)
  // Currently dragged bug (for the DragOverlay ghost) + click-suppression so
  // finishing a drag never opens the detail dialog.
  const [activeBugId, setActiveBugId] = useState<string | null>(null)
  const suppressClickRef = useRef(false)

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['bugs', 'list'],
    queryFn: () => bugsApi.list({ pageSize: '200' }),
    placeholderData: keepPreviousData,
  })

  const bugs = data?.data ?? []
  const activeBug = activeBugId ? bugs.find((b) => b.bugId === activeBugId) ?? null : null

  /** Export the currently loaded bugs to CSV — mirrors the test-cases export.
   *  Exports what the user can see (the loaded page); every cell quoted and
   *  formula-injection safe (src/lib/csv-export.ts). */
  function exportCsv() {
    if (!bugs.length) {
      toast.error('No data to export')
      return
    }
    const headers = ['ID', 'Title', 'Module', 'Severity', 'Status', 'Assignee', 'Reported By', 'Created', 'Updated']
    const rows = bugs.map((b) => [
      b.bugId,
      b.title,
      b.module?.name ?? '',
      b.severity,
      b.status,
      b.assignedTo?.fullName ?? '',
      b.reportedBy?.fullName ?? '',
      formatDateTime(b.createdAt),
      formatDateTime(b.updatedAt),
    ])
    const csv = toCsv([headers, ...rows])
    downloadTextFile(`bugs-${new Date().toISOString().slice(0, 10)}.csv`, csv)
    toast.success('Exported CSV')
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  )

  function endDrag() {
    setActiveBugId(null)
    // The browser fires a click right after pointerup — keep suppressing it
    // for a tick so a completed drag never opens the detail dialog.
    window.setTimeout(() => { suppressClickRef.current = false }, 150)
  }

  function handleDragStart(e: DragStartEvent) {
    suppressClickRef.current = true
    setActiveBugId(String(e.active.id))
  }

  function handleDragCancel(_e: DragCancelEvent) {
    endDrag()
  }

  async function handleDragEnd(e: DragEndEvent) {
    const bugId = String(e.active.id)
    const newStatus = e.over?.id as BugStatus | undefined
    endDrag()
    if (!newStatus) return
    const bug = bugs.find((b) => b.bugId === bugId)
    if (!bug || bug.status === newStatus) return
    try {
      await bugsApi.update(bugId, { status: newStatus, expectedUpdatedAt: bug.updatedAt })
      toast.success(`Moved to "${STATUS_LABEL[newStatus]}"`)
      invalidateAfterMutation(qc, 'bugs')
    } catch (err) {
      handleApiError(err, 'Failed to move')
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Bugs"
        description="Track and triage reported defects"
        actions={
          <>
            <Tabs value={view} onValueChange={(v) => setView(v as 'kanban' | 'table')}>
              <TabsList>
                <TabsTrigger value="kanban" className="gap-1"><LayoutGrid className="h-3.5 w-3.5" /> Board</TabsTrigger>
                <TabsTrigger value="table" className="gap-1"><TableIcon className="h-3.5 w-3.5" /> Table</TabsTrigger>
              </TabsList>
            </Tabs>
            <Button variant="outline" onClick={exportCsv}>
              <Download className="h-4 w-4 mr-1" /> Export CSV
            </Button>
            {/* Matrix-driven: only create_bug holders see the report button. */}
            {user && canCreate && (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4 mr-1" /> Report Bug
              </Button>
            )}
          </>
        }
      />

      {isError ? (
        <QueryErrorAlert
          title="Could not load bugs"
          onRetry={() => refetch()}
        />
      ) : isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-64" />)}
        </div>
      ) : view === 'kanban' ? (
        <DndContext
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {BUG_STATUSES.map((status) => {
              const columnBugs = bugs.filter((b) => b.status === status)
              return (
                <KanbanColumn
                  key={status}
                  status={status}
                  bugs={columnBugs}
                  onOpen={setDetailBug}
                  suppressClickRef={suppressClickRef}
                />
              )
            })}
          </div>
          {/* Lifted card ghost that follows the pointer while dragging. */}
          <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)' }}>
            {activeBug ? <BugCardVisual bug={activeBug} dragging /> : null}
          </DragOverlay>
        </DndContext>
      ) : (
        <Card>
          <CardContent className="p-0">
            {bugs.length === 0 ? (
              <EmptyState icon={BugIcon} message="No bugs reported yet" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">ID</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead className="w-24">Severity</TableHead>
                    <TableHead className="w-28">Status</TableHead>
                    <TableHead>Assigned</TableHead>
                    <TableHead>Module</TableHead>
                    <TableHead>Reported</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bugs.map((b) => (
                    <TableRow key={b.bugId} className="cursor-pointer" onClick={() => setDetailBug(b)}>
                      <TableCell className="font-mono text-xs text-muted-foreground">{b.bugId.slice(-6)}</TableCell>
                      <TableCell className="font-medium max-w-xs truncate">{b.title}</TableCell>
                      <TableCell>
                        <SeverityBadge severity={b.severity} />
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={b.status} colorClass={bugStatusColor(b.status)} />
                      </TableCell>
                      <TableCell className="text-sm">{b.assignedTo?.fullName ?? '—'}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{b.module?.name ?? '—'}</TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {timeAgo(b.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {createOpen && (
        <CreateBugDialog open={createOpen} onOpenChange={setCreateOpen} />
      )}

      <BugDetailDialog
        bug={detailBug}
        onClose={() => setDetailBug(null)}
        onBugChanged={(updated) => setDetailBug((prev) => (prev?.bugId === updated.bugId ? updated : prev))}
        canTriage={canTriage}
        canAssign={canAssign}
        canDelete={canDelete}
      />
    </div>
  )
}

function KanbanColumn({
  status,
  bugs,
  onOpen,
  suppressClickRef,
}: {
  status: BugStatus
  bugs: Bug[]
  onOpen: (b: Bug) => void
  suppressClickRef: RefObject<boolean>
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status })
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'rounded-lg border bg-muted/30 p-2 min-h-[220px] flex flex-col transition',
        isOver
          ? 'bg-emerald-50 border-emerald-400 ring-2 ring-emerald-200 dark:bg-emerald-500/10 dark:ring-emerald-500/25'
          : 'border-border'
      )}
    >
      <div className="flex items-center justify-between px-1 pb-2">
        <span className="text-xs font-semibold uppercase tracking-wide flex items-center gap-1.5">
          <span className={cn('h-2 w-2 rounded-full', statusDotColor(status))} />
          {STATUS_LABEL[status]}
        </span>
        <Badge variant="secondary" className="text-[10px] h-4 min-w-4 px-1">{bugs.length}</Badge>
      </div>
      <div className="space-y-2 flex-1">
        {bugs.map((b) => (
          <DraggableBugCard key={b.bugId} bug={b} onOpen={onOpen} suppressClickRef={suppressClickRef} />
        ))}
        {bugs.length === 0 && (
          <div
            className={cn(
              'text-[10px] text-muted-foreground text-center py-6 italic border border-dashed rounded-md transition',
              isOver ? 'border-emerald-400 text-emerald-600' : 'border-border/60'
            )}
          >
            {isOver ? 'Release to drop here' : 'Drop bugs here'}
          </div>
        )}
      </div>
    </div>
  )
}

/** Shared card look — used by the draggable card AND the DragOverlay ghost. */
function BugCardVisual({ bug, dragging }: { bug: Bug; dragging?: boolean }) {
  return (
    <div
      className={cn(
        'w-full text-left bg-background border rounded-md p-2 transition',
        dragging
          ? 'shadow-xl ring-2 ring-emerald-300 rotate-2 cursor-grabbing'
          : 'hover:shadow-sm'
      )}
    >
      <div className="flex items-start gap-1.5">
        <span className={cn('h-2 w-2 rounded-full mt-1.5 shrink-0', severityDot(bug.severity))} />
        <span className="text-sm font-medium flex-1 line-clamp-2">{bug.title}</span>
        <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
      </div>
      <div className="flex items-center justify-between gap-2 mt-1.5 text-[10px] text-muted-foreground">
        <span className="truncate">{bug.assignedTo?.fullName ?? 'Unassigned'}</span>
        <span className="truncate max-w-[45%] text-right" title={bug.module?.name ?? undefined}>
          {bug.module?.name ?? ''}
        </span>
      </div>
    </div>
  )
}

function DraggableBugCard({
  bug,
  onOpen,
  suppressClickRef,
}: {
  bug: Bug
  onOpen: (b: Bug) => void
  suppressClickRef: RefObject<boolean>
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: bug.bugId,
  })
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
      }}
      className={cn(
        'cursor-grab active:cursor-grabbing touch-none',
        isDragging && 'opacity-30'
      )}
      onClick={() => {
        // Ignore the click that closes a drag gesture.
        if (suppressClickRef.current) return
        onOpen(bug)
      }}
      // The card itself is reachable by keyboard (Enter opens details);
      // dnd-kit adds its own aria/role attributes via `attributes`.
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(bug)
      }}
      role="button"
      tabIndex={0}
      aria-label={`Bug: ${bug.title}`}
    >
      <BugCardVisual bug={bug} />
    </div>
  )
}

function statusDotColor(status: BugStatus): string {
  const map: Record<BugStatus, string> = {
    open: 'bg-rose-500',
    in_progress: 'bg-amber-500',
    resolved: 'bg-emerald-500',
    closed: 'bg-slate-400',
    wont_fix: 'bg-zinc-400',
  }
  return map[status]
}

function CreateBugDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient()
  const [title, setTitle] = useState('')
  const [severity, setSeverity] = useState<Severity>('medium')
  const [environment, setEnvironment] = useState('staging')
  const [moduleId, setModuleId] = useState('')
  const [assignedToId, setAssignedToId] = useState('')
  const [description, setDescription] = useState('')
  const [stepsToReproduce, setSteps] = useState('')
  const [expectedBehaviour, setExpected] = useState('')
  const [actualBehaviour, setActual] = useState('')
  const [saving, setSaving] = useState(false)

  const { data: treeData } = useQuery({ queryKey: ['modules', 'tree'], queryFn: modulesApi.tree , staleTime: REFERENCE_STALE_TIME_MS })
  // Picker rows (any authenticated user) — not the manage_users-gated list.
  const { data: options } = useQuery({
    queryKey: ['users', 'options'],
    staleTime: REFERENCE_STALE_TIME_MS,
    queryFn: usersApi.options,
  })

  const flatModules = treeData?.flat ?? []
  const selectedModule = flatModules.find((m) => m.moduleId === moduleId)

  async function handleSave() {
    // Required-field gate mirrors the API schema: title, module, description.
    if (!title.trim()) {
      toast.error('Title is required')
      return
    }
    if (!moduleId) {
      toast.error('Module is required — pick the area this bug belongs to')
      return
    }
    if (!description.trim()) {
      toast.error('Description is required — explain what went wrong')
      return
    }
    setSaving(true)
    try {
      await bugsApi.create({
        title: title.trim(),
        severity,
        environment: environment.trim() || undefined,
        moduleId,
        assignedToId: assignedToId || null,
        description: description.trim(),
        stepsToReproduce: stepsToReproduce.trim() || undefined,
        expectedBehaviour: expectedBehaviour.trim() || undefined,
        actualBehaviour: actualBehaviour.trim() || undefined,
      })
      toast.success('Bug reported')
      invalidateAfterMutation(qc, 'bugs')
      onOpenChange(false)
      // Reset every field so reopening starts a clean report.
      setTitle(''); setDescription(''); setSteps(''); setExpected(''); setActual('')
      setModuleId(''); setAssignedToId(''); setSeverity('medium'); setEnvironment('staging')
    } catch (err) {
      handleApiError(err, 'Failed to report bug')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl w-[95vw] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Report a Bug</DialogTitle>
          <DialogDescription>
            Capture the details so the team can reproduce and fix it. Fields marked * are required.
          </DialogDescription>
        </DialogHeader>

        {/* Same fixed two-column rhythm as the New Test Case dialog: long
            text spans the full width, short choices sit in pairs. Every
            container is min-w-0 so long module names can never push the
            grid apart. */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5 md:col-span-2 min-w-0">
            <Label htmlFor="b-title">Title *</Label>
            <Input
              id="b-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short summary of the issue, e.g. Login fails with valid credentials"
              maxLength={200}
            />
          </div>

          <div className="space-y-1.5 min-w-0">
            <Label htmlFor="b-sev">Severity</Label>
            <Select value={severity} onValueChange={(v) => setSeverity(v as Severity)}>
              <SelectTrigger id="b-sev" className="w-full min-w-0"><SelectValue /></SelectTrigger>
              <SelectContent>
                {SEVERITIES.map((s) => <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5 min-w-0">
            <Label htmlFor="b-env">Environment</Label>
            <Input
              id="b-env"
              value={environment}
              onChange={(e) => setEnvironment(e.target.value)}
              placeholder="staging"
              maxLength={100}
            />
          </div>

          <div className="space-y-1.5 min-w-0">
            <Label htmlFor="b-module">Module *</Label>
            <Select value={moduleId} onValueChange={setModuleId}>
              <SelectTrigger id="b-module" className="w-full min-w-0 [&>span]:truncate">
                <SelectValue placeholder="Choose the affected module" />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                {flatModules.map((m) => (
                  <SelectItem key={m.moduleId} value={m.moduleId} className="truncate max-w-[320px]" title={m.name}>
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
            <Label htmlFor="b-assigned">Assign To</Label>
            <Select value={assignedToId} onValueChange={setAssignedToId}>
              <SelectTrigger id="b-assigned" className="w-full min-w-0 [&>span]:truncate">
                <SelectValue placeholder="Unassigned" />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                {(options ?? []).filter((u) => BUG_ASSIGNEE_ROLES.includes(u.role)).map((u) => (
                  <SelectItem key={u.userId} value={u.userId} className="truncate max-w-[320px]" title={u.fullName}>
                    {u.fullName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5 md:col-span-2 min-w-0">
            <Label htmlFor="b-desc">Description *</Label>
            <Textarea
              id="b-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder="What went wrong, where, and how does it impact the user?"
              maxLength={2000}
            />
          </div>

          <div className="space-y-1.5 md:col-span-2 min-w-0">
            <Label htmlFor="b-steps">Steps to Reproduce (optional)</Label>
            <Textarea
              id="b-steps"
              value={stepsToReproduce}
              onChange={(e) => setSteps(e.target.value)}
              rows={3}
              placeholder={'1. Go to...\n2. Click...\n3. See the error'}
              maxLength={2000}
            />
          </div>

          <div className="space-y-1.5 min-w-0">
            <Label htmlFor="b-expected">Expected Behaviour (optional)</Label>
            <Textarea
              id="b-expected"
              value={expectedBehaviour}
              onChange={(e) => setExpected(e.target.value)}
              rows={2}
              maxLength={1000}
            />
          </div>

          <div className="space-y-1.5 min-w-0">
            <Label htmlFor="b-actual">Actual Behaviour (optional)</Label>
            <Textarea
              id="b-actual"
              value={actualBehaviour}
              onChange={(e) => setActual(e.target.value)}
              rows={2}
              maxLength={1000}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? 'Reporting...' : 'Report Bug'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BugDetailDialog({
  bug,
  onClose,
  onBugChanged,
  canTriage,
  canAssign,
  canDelete,
}: {
  bug: Bug | null
  onClose: () => void
  onBugChanged: (bug: Bug) => void
  canTriage: boolean
  canAssign: boolean
  canDelete: boolean
}) {
  return (
    <Dialog open={!!bug} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        {bug && (
          <BugDetailContent
            bug={bug}
            onClose={onClose}
            onBugChanged={onBugChanged}
            canTriage={canTriage}
            canAssign={canAssign}
            canDelete={canDelete}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function BugDetailContent({
  bug,
  onClose,
  onBugChanged,
  canTriage,
  canAssign,
  canDelete,
}: {
  bug: Bug
  onClose: () => void
  onBugChanged: (bug: Bug) => void
  canTriage: boolean
  canAssign: boolean
  canDelete: boolean
}) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)

  async function handleDelete() {
    try {
      await bugsApi.delete(bug.bugId)
      toast.success('Bug deleted')
      invalidateAfterMutation(qc, 'bugs')
      onClose()
    } catch (err) {
      handleApiError(err, 'Failed to delete')
    }
  }

  const hasReproDetails = Boolean(
    bug.description || bug.stepsToReproduce || bug.expectedBehaviour || bug.actualBehaviour
  )

  return (
    <>
      <DialogHeader>
        <div className="flex flex-wrap items-center gap-2 pr-6">
          <SeverityBadge severity={bug.severity} />
          <StatusBadge status={bug.status} colorClass={bugStatusColor(bug.status)} />
          <span className="font-mono text-xs text-muted-foreground">#{bug.bugId.slice(-6)}</span>
        </div>
        <DialogTitle className="leading-snug">{bug.title}</DialogTitle>
        <DialogDescription>
          Reported by {bug.reportedBy?.fullName ?? '—'} · {formatDateTime(bug.createdAt)}
        </DialogDescription>
      </DialogHeader>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
        <div className="space-y-3 md:col-span-3">
          {hasReproDetails ? (
            <>
              {bug.description && <DetailSection label="Description">{bug.description}</DetailSection>}
              {bug.stepsToReproduce && <DetailSection label="Steps to Reproduce">{bug.stepsToReproduce}</DetailSection>}
              {bug.expectedBehaviour && <DetailSection label="Expected Behaviour">{bug.expectedBehaviour}</DetailSection>}
              {bug.actualBehaviour && <DetailSection label="Actual Behaviour">{bug.actualBehaviour}</DetailSection>}
            </>
          ) : (
            <p className="text-sm italic text-muted-foreground">
              No reproduction details were captured for this bug.
            </p>
          )}
        </div>

        {editing ? (
          <BugEditForm
            bug={bug}
            canAssign={canAssign}
            onSaved={(updated) => {
              setEditing(false)
              onBugChanged(updated)
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <BugMetaPanel bug={bug} />
        )}
      </div>

      <DialogFooter className={editing ? undefined : 'sm:justify-between'}>
        {!editing && (
          <div className="flex gap-2">
            {/* Matrix-driven: mirrors the backend bug-update participation gate. */}
            {canTriage && (
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
              </Button>
            )}
            {canDelete && (
              <Button size="sm" variant="ghost" className="text-rose-600 hover:text-rose-700" onClick={handleDelete}>
                <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete
              </Button>
            )}
          </div>
        )}
        <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
      </DialogFooter>
    </>
  )
}

function BugMetaPanel({ bug }: { bug: Bug }) {
  return (
    <div className="h-fit rounded-lg border bg-muted/30 p-4 md:col-span-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Details</div>
      <div className="mt-1 divide-y divide-border/70">
        <MetaItem label="Status">
          <StatusBadge status={bug.status} colorClass={bugStatusColor(bug.status)} />
        </MetaItem>
        <MetaItem label="Severity">
          <SeverityBadge severity={bug.severity} />
        </MetaItem>
        <MetaItem label="Module">{bug.module?.name ?? '—'}</MetaItem>
        <MetaItem label="Assignee">{bug.assignedTo?.fullName ?? 'Unassigned'}</MetaItem>
        <MetaItem label="Environment">{bug.environment ?? '—'}</MetaItem>
        <MetaItem label="Reported by">{bug.reportedBy?.fullName ?? '—'}</MetaItem>
        <MetaItem label="Reported on" title={formatDateTime(bug.createdAt)}>{formatDate(bug.createdAt)}</MetaItem>
        <MetaItem label="Last updated" title={formatDateTime(bug.updatedAt)}>{formatDate(bug.updatedAt)}</MetaItem>
        {bug.resolvedAt && <MetaItem label="Resolved on" title={formatDateTime(bug.resolvedAt)}>{formatDate(bug.resolvedAt)}</MetaItem>}
      </div>
    </div>
  )
}

function MetaItem({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-sm">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-right font-medium" title={title}>{children}</span>
    </div>
  )
}

function BugEditForm({
  bug,
  canAssign,
  onSaved,
  onCancel,
}: {
  bug: Bug
  canAssign: boolean
  onSaved: (bug: Bug) => void
  onCancel: () => void
}) {
  const qc = useQueryClient()
  const [status, setStatus] = useState<BugStatus>(bug.status)
  const [severity, setSeverity] = useState<Severity>(bug.severity)
  const [assignedToId, setAssignedToId] = useState(bug.assignedToId ?? '')
  const [saving, setSaving] = useState(false)

  // Picker rows (any authenticated user) — not the manage_users-gated list.
  const { data: options } = useQuery({
    queryKey: ['users', 'options'],
    queryFn: usersApi.options,
  })

  async function handleSave() {
    setSaving(true)
    try {
      const updated = await bugsApi.update(bug.bugId, {
        status,
        severity,
        assignedToId: assignedToId || null,
        expectedUpdatedAt: bug.updatedAt,
      })
      toast.success('Bug updated')
      invalidateAfterMutation(qc, 'bugs')
      onSaved(updated)
    } catch (err) {
      handleApiError(err, 'Failed to update')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="h-fit space-y-3 rounded-lg border bg-muted/30 p-4 md:col-span-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Edit Bug</div>
      <div className="space-y-1.5">
        <Label>Status</Label>
        <Select value={status} onValueChange={(v) => setStatus(v as BugStatus)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {BUG_STATUSES.map((s) => (
              <SelectItem key={s} value={s} className="capitalize">{s.replace('_', ' ')}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label>Severity</Label>
        <Select value={severity} onValueChange={(v) => setSeverity(v as Severity)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {SEVERITIES.map((s) => <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label>Assignee</Label>
        <Select value={assignedToId} onValueChange={setAssignedToId} disabled={!canAssign}>
          <SelectTrigger><SelectValue placeholder={canAssign ? 'Unassigned' : 'Requires assign-bug right'} /></SelectTrigger>
          <SelectContent>
            {(options ?? []).filter((u) => BUG_ASSIGNEE_ROLES.includes(u.role)).map((u) => (
              <SelectItem key={u.userId} value={u.userId}>{u.fullName}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex gap-2 pt-1">
        <Button size="sm" onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : 'Save'}</Button>
        <Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  )
}
