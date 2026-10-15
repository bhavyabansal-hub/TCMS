'use client'

import { useState, useMemo } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronRight, ChevronDown, Folder, FolderOpen, Plus, Trash2, ListChecks,
  Send, ShieldAlert, Pencil,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { REFERENCE_STALE_TIME_MS, modulesApi, usersApi } from '@/lib/client/api'
import { invalidateAfterMutation } from '@/lib/client/invalidate'
import { useAuthStore, useViewStore } from '@/store'
import { formatDateTime, statusColor } from '@/lib/format'
import { handleApiError } from '@/lib/errors'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { Module, TestCase, User, UserOption } from '@/types'
import { PriorityBadge, StatusBadge } from '@/components/shared/badges'
import { QueryErrorAlert } from '@/components/shared/query-error'

export function ModulesView() {
  const user = useAuthStore((s) => s.user)
  const can = useAuthStore((s) => s.can)
  const navigate = useViewStore((s) => s.navigate)
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [createOpen, setCreateOpen] = useState(false)
  const [createParent, setCreateParent] = useState<string | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [submitReviewModule, setSubmitReviewModule] = useState<{ id: string; name: string } | null>(null)

  const { data: treeData, isLoading, isError, refetch } = useQuery({
    placeholderData: keepPreviousData,
    queryKey: ['modules', 'tree'],
    staleTime: REFERENCE_STALE_TIME_MS,
    queryFn: modulesApi.tree,
  })

  const { data: detail } = useQuery({
    queryKey: ['modules', 'detail', selectedId],
    queryFn: () => modulesApi.get(selectedId!),
    enabled: !!selectedId,
  })

  // Load picker rows so the submit-review dialog can offer reviewers.
  const { data: options } = useQuery({
    queryKey: ['users', 'options'],
    staleTime: REFERENCE_STALE_TIME_MS,
    queryFn: usersApi.options,
    enabled: !!user,
  })

  function toggleExpand(id: string) {
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function renderTree(nodes: Module[], depth = 0): React.ReactNode {
    return nodes.map((node) => (
      <div key={node.moduleId}>
        <div
          className={cn(
            'flex items-center gap-1 px-2 py-1.5 rounded-md hover:bg-accent cursor-pointer text-sm group',
            selectedId === node.moduleId && 'bg-accent'
          )}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => setSelectedId(node.moduleId)}
        >
          {node.children && node.children.length > 0 ? (
            <button
              onClick={(e) => {
                e.stopPropagation()
                toggleExpand(node.moduleId)
              }}
              className="h-4 w-4 shrink-0 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-white/10 rounded"
            >
              {expanded.has(node.moduleId) ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            </button>
          ) : (
            <span className="w-4 shrink-0" />
          )}
          {expanded.has(node.moduleId) ? (
            <FolderOpen className="h-4 w-4 text-amber-600 shrink-0" />
          ) : (
            <Folder className="h-4 w-4 text-amber-600 shrink-0" />
          )}
          <span className="flex-1 truncate">{node.name}</span>
          {node.testCaseCount !== undefined && node.testCaseCount > 0 && (
            <Badge variant="secondary" className="text-[10px] h-4 min-w-4 px-1">
              {node.testCaseCount}
            </Badge>
          )}
        </div>
        {expanded.has(node.moduleId) && node.children && renderTree(node.children, depth + 1)}
      </div>
    ))
  }

  function handleCreate(parentId: string | null) {
    setCreateParent(parentId)
    setCreateOpen(true)
  }

  async function handleDelete() {
    if (!deleteId) return
    try {
      await modulesApi.delete(deleteId)
      toast.success('Module deleted')
      invalidateAfterMutation(qc, 'modules')
      if (selectedId === deleteId) setSelectedId(null)
    } catch (err) {
      handleApiError(err, 'Failed to delete module')
    } finally {
      setDeleteId(null)
    }
  }

  // Matrix-driven action rights — each button mirrors its backend gate.
  const canCreateModule = can('create_module')
  const canEditModule = can('edit_module')
  const canSubmit = can('submit_review')

  // Determine if the current user can delete the selected module (creator or senior)
  const selectedModule = detail?.module
  const isCreator = !!user && !!selectedModule && selectedModule.createdById === user.userId
  const isSenior = can('edit_module')
  const canDeleteSelected = isCreator || isSenior

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Modules</h1>
          <p className="text-sm text-muted-foreground">Organise your test cases into a tree of modules</p>
        </div>
        {canCreateModule && (
          <Button onClick={() => handleCreate(null)}>
            <Plus className="h-4 w-4 mr-1" /> New Root Module
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Tree panel */}
        <Card className="lg:col-span-1">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Module Tree</CardTitle>
          </CardHeader>
          <CardContent>
            {isError ? (
              <QueryErrorAlert
                className="mb-2"
                title="Could not load modules"
                onRetry={() => refetch()}
              />
            ) : isLoading ? (
              <div className="space-y-2">
                {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-8" />)}
              </div>
            ) : !treeData?.tree.length ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No modules yet. {canCreateModule && 'Create one to get started.'}
              </div>
            ) : (
              <div className="space-y-0.5 max-h-[60vh] overflow-y-auto">
                {renderTree(treeData.tree)}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Detail panel */}
        <Card className="lg:col-span-2">
          {!selectedId ? (
            <CardContent className="py-16 text-center text-muted-foreground">
              <Folder className="h-10 w-10 mx-auto mb-2 opacity-50" />
              Select a module from the tree to view its details
            </CardContent>
          ) : !detail ? (
            <CardContent className="py-8">
              <Skeleton className="h-40" />
            </CardContent>
          ) : (
            <>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-base">{detail.module.name}</CardTitle>
                    {detail.module.description && (
                      <p className="text-sm text-muted-foreground mt-1">{detail.module.description}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1 justify-end">
                    {canCreateModule && (
                      <Button size="sm" variant="outline" onClick={() => handleCreate(detail.module.moduleId)}>
                        <Plus className="h-3.5 w-3.5 mr-1" /> Submodule
                      </Button>
                    )}
                    {canEditModule && (
                      <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
                        <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
                      </Button>
                    )}
                    {canSubmit && (
                      <Button
                        size="sm"
                        onClick={() => setSubmitReviewModule({ id: detail.module.moduleId, name: detail.module.name })}
                        // The dialog has an "include submodules" option, so we enable the button
                        // even if this module has no direct test cases (descendants may have some).
                        title="Submit all test cases in this module (and its submodules) for review"
                      >
                        <Send className="h-3.5 w-3.5 mr-1" /> Submit for Review
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setDeleteId(detail.module.moduleId)} disabled={!canDeleteSelected}
                      title={!canDeleteSelected ? 'Only the creator or a senior manager can delete this module' : 'Delete module'}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-rose-500" />
                    </Button>
                  </div>
                </div>
                {!canDeleteSelected && (
                  <div className="mt-2 text-[11px] text-amber-600 flex items-center gap-1">
                    <ShieldAlert className="h-3 w-3" />
                    Only the creator or a senior manager can delete this module.
                  </div>
                )}
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <div className="text-xs text-muted-foreground">Owner</div>
                    <div className="font-medium">{detail.module.owner?.fullName ?? '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Created by</div>
                    <div className="font-medium flex items-center gap-1.5">
                      {detail.module.createdBy?.fullName ?? '—'}
                      {isCreator && <Badge variant="secondary" className="text-[9px]">you</Badge>}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Created at</div>
                    <div className="font-medium">{formatDateTime(detail.module.createdAt)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Updated at</div>
                    <div className="font-medium">{formatDateTime(detail.module.updatedAt)}</div>
                  </div>
                </div>

                {detail.submodules.length > 0 && (
                  <div>
                    <div className="text-xs font-semibold text-muted-foreground uppercase mb-2">Submodules ({detail.submodules.length})</div>
                    <div className="flex flex-wrap gap-2">
                      {detail.submodules.map((sm) => (
                        <Button
                          key={sm.moduleId}
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setSelectedId(sm.moduleId)
                            setExpanded((s) => new Set(s).add(detail.module.moduleId))
                          }}
                        >
                          <Folder className="h-3.5 w-3.5 mr-1 text-amber-600" />
                          {sm.name}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-xs font-semibold text-muted-foreground uppercase">
                      Test Cases ({detail.casePage?.directTotal ?? detail.testCases.length} direct)
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => navigate('test-cases', { moduleId: detail.module.moduleId })}
                    >
                      View all →
                    </Button>
                  </div>
                  {detail.testCases.length === 0 ? (
                    <div className="py-6 text-center text-sm text-muted-foreground">No test cases in this module</div>
                  ) : (
                    <div className="rounded-md border divide-y max-h-72 overflow-y-auto">
                      {detail.testCases.map((tc) => (
                        <button
                          key={tc.testCaseId}
                          onClick={() => navigate('test-case-detail', { id: tc.testCaseId })}
                          className="w-full text-left p-2.5 hover:bg-accent transition flex items-center gap-2 text-sm"
                        >
                          <span className="flex-1 truncate">{tc.title}</span>
                          <PriorityBadge priority={tc.priority} />
                          <StatusBadge status={tc.status} colorClass={statusColor(tc.status)} />
                        </button>
                      ))}
                    </div>
                  )}
                  {(detail.casePage?.directTotal ?? detail.testCases.length) > detail.testCases.length && (
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      Showing first {detail.testCases.length} of {detail.casePage?.directTotal} direct test cases — open the module page for the full list.
                    </p>
                  )}
                </div>
              </CardContent>
            </>
          )}
        </Card>
      </div>

      {createOpen && (
        <CreateModuleDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          parentId={createParent}
          currentUser={user}
        />
      )}

      {editOpen && detail && (
        <EditModuleDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          module={detail.module}
        />
      )}

      {submitReviewModule && (
        <SubmitModuleReviewDialog
          module={submitReviewModule}
          options={options ?? []}
          currentUser={user}
          onOpenChange={(v) => !v && setSubmitReviewModule(null)}
        />
      )}

      <AlertDialog open={!!deleteId} onOpenChange={(open) => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this module?</AlertDialogTitle>
            <AlertDialogDescription>
              This will cascade-delete all submodules. Test cases inside will be orphaned (not deleted).
              Only the creator or a senior manager can delete a module.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-rose-600 hover:bg-rose-700">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function CreateModuleDialog({
  open,
  onOpenChange,
  parentId,
  currentUser,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  parentId: string | null
  currentUser: User | null
}) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    if (!name.trim()) {
      toast.error('Name is required')
      return
    }
    setSaving(true)
    try {
      // ownerId is intentionally NOT sent — the backend always sets the creator as owner.
      await modulesApi.create({
        name: name.trim(),
        description: description.trim() || undefined,
        parentId: parentId ?? undefined,
      })
      toast.success('Module created — you are the owner')
      invalidateAfterMutation(qc, 'modules')
      setName('')
      setDescription('')
      onOpenChange(false)
    } catch (err) {
      handleApiError(err, 'Failed to create module')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{parentId ? 'Create Submodule' : 'Create Root Module'}</DialogTitle>
          <DialogDescription>Add a new module. You will be recorded as the creator and owner.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="m-name">Name</Label>
            <Input id="m-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Authentication" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="m-desc">Description (optional)</Label>
            <Textarea id="m-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>
          <div className="rounded-md border bg-muted/30 p-2.5 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Creator / Owner:</span>{' '}
            {currentUser?.fullName} ({currentUser?.email})
            <div className="mt-0.5">The creator is automatically recorded as the owner. Only the creator or a senior manager can delete this module later.</div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Creating...' : 'Create Module'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EditModuleDialog({
  open,
  onOpenChange,
  module,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  module: Module
}) {
  const qc = useQueryClient()
  const [name, setName] = useState(module.name)
  const [description, setDescription] = useState(module.description ?? '')
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    if (!name.trim()) {
      toast.error('Name is required')
      return
    }
    setSaving(true)
    try {
      await modulesApi.update(module.moduleId, {
        name: name.trim(),
        description: description.trim() || undefined,
      })
      toast.success('Module updated')
      invalidateAfterMutation(qc, 'modules')
      onOpenChange(false)
    } catch (err) {
      handleApiError(err, 'Failed to update module')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Module</DialogTitle>
          <DialogDescription>Rename the module or change its description.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="em-name">Name</Label>
            <Input id="em-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Authentication" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="em-desc">Description (optional)</Label>
            <Textarea id="em-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SubmitModuleReviewDialog({
  module,
  options,
  currentUser,
  onOpenChange,
}: {
  module: { id: string; name: string }
  options: UserOption[]
  currentUser: User | null
  onOpenChange: (v: boolean) => void
}) {
  const qc = useQueryClient()
  const navigate = useViewStore((s) => s.navigate)
  const [reviewerId, setReviewerId] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [includeSubmodules, setIncludeSubmodules] = useState(true)
  const [saving, setSaving] = useState(false)

  // Matrix-driven: only users whose role holds perform_review (live matrix,
  // not a static role list) can be picked as reviewers.
  const reviewers = options.filter((u) => u.canPerformReview)

  async function handleSubmit() {
    setSaving(true)
    try {
      const result = await modulesApi.submitReview(module.id, {
        reviewerId: reviewerId || undefined,
        dueDate: dueDate || undefined,
        includeSubmodules,
      })
      toast.success(`Submitted ${result.caseReviewCount} test case(s) for review`)
      invalidateAfterMutation(qc, 'modules', 'reviews', 'moduleReviews')
      onOpenChange(false)
      // Jump to the module review detail so the requester can track progress.
      navigate('module-review-detail', { id: result.moduleReview.moduleReviewRequestId })
    } catch (err) {
      handleApiError(err, 'Failed to submit module for review')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Submit Module for Review</DialogTitle>
          <DialogDescription>
            Send <span className="font-medium text-foreground">{module.name}</span> and all of its{' '}
            {includeSubmodules ? '(and submodules\') ' : ''}test cases to a reviewer in one go.
            The reviewer can then approve them all at once, or request revisions per test case.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="smr-reviewer">Reviewer</Label>
            <Select value={reviewerId} onValueChange={setReviewerId}>
              <SelectTrigger id="smr-reviewer"><SelectValue placeholder="Auto-assign (first available team lead)" /></SelectTrigger>
              <SelectContent>
                {reviewers.map((u) => (
                  <SelectItem key={u.userId} value={u.userId}>{u.fullName} ({u.role.replace('_', ' ')})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="smr-due">Due date (optional)</Label>
            <Input id="smr-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <label className="flex items-start gap-2 text-sm cursor-pointer rounded-md border p-2.5 hover:bg-accent">
            <Checkbox checked={includeSubmodules} onCheckedChange={(v) => setIncludeSubmodules(v === true)} className="mt-0.5" />
            <span>
              <span className="font-medium">Include submodules</span>
              <span className="block text-xs text-muted-foreground">
                Also submit test cases from all descendant submodules. Test cases already approved/active are skipped.
              </span>
            </span>
          </label>
          <div className="rounded-md border bg-muted/30 p-2.5 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Requester:</span>{' '}
            {currentUser?.fullName}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving ? 'Submitting...' : 'Submit Module for Review'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
