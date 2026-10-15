'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft, Plus, Trash2, Pencil, Save, X, Send, History, ClipboardCheck,
  MessageSquare, User as UserIcon, GitBranch, Activity,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { REFERENCE_STALE_TIME_MS, activityLogsApi, modulesApi, reviewsApi, testCasesApi, usersApi } from '@/lib/client/api'
import { invalidateAfterMutation } from '@/lib/client/invalidate'
import { useAuthStore, useViewStore } from '@/store'
import {
  statusColor, verdictColor, reviewStatusColor, formatDateTime, timeAgo, actionColor,
} from '@/lib/format'
import { handleApiError } from '@/lib/errors'
import { toast } from 'sonner'
import type { TestCase, TestCaseHistory, ReviewRequest, ActivityLog, Module, Priority, User } from '@/types'
import { TestCaseEditor } from '@/components/test-cases/test-case-editor'
import { SubmitReviewDialog } from '@/components/test-cases/submit-review-dialog'
import { PriorityBadge, StatusBadge } from '@/components/shared/badges'
import { DetailField } from '@/components/shared/detail-field'
import { DetailLoadError } from '@/components/shared/query-error'


export function TestCaseDetailView() {
  const { params, navigate } = useViewStore()
  const id = params.id
  const user = useAuthStore((s) => s.user)
  const can = useAuthStore((s) => s.can)
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [submitOpen, setSubmitOpen] = useState(false)

  const {
    data: tc,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['test-cases', 'detail', id],
    queryFn: () => testCasesApi.get(id),
    enabled: !!id,
    retry: 1,
  })

  const { data: history } = useQuery({
    queryKey: ['test-cases', 'history', id],
    queryFn: () => testCasesApi.history(id),
    enabled: !!id,
  })

  const { data: reviews } = useQuery({
    queryKey: ['test-cases', 'reviews', id],
    queryFn: () => testCasesApi.reviews(id),
    enabled: !!id,
  })

  const { data: activity } = useQuery({
    queryKey: ['activity', 'test_case', id],
    queryFn: () => activityLogsApi.entity('test_case', id),
    enabled: !!id,
  })

  const { data: treeData } = useQuery({
    queryKey: ['modules', 'tree'],
    staleTime: REFERENCE_STALE_TIME_MS,
    queryFn: modulesApi.tree,
  })
  const flatModules = treeData?.flat ?? []

  // Picker rows (any authenticated user) — not the manage_users-gated list.
  const { data: options } = useQuery({
    queryKey: ['users', 'options'],
    staleTime: REFERENCE_STALE_TIME_MS,
    queryFn: usersApi.options,
    enabled: !!user,
  })

  // Fallbacks: a deleted record (404), a forbidden one (403) or a network
  // failure must render an explicit recovery screen — never a skeleton that
  // spins forever and looks like a frozen app.
  if (isError) {
    return (
      <DetailLoadError
        title="Could not load this test case"
        message="It may have been deleted, or you may not have access to it anymore."
        onRetry={() => refetch()}
        backHref="/test-cases"
        backLabel="Back to test cases"
      />
    )
  }

  if (isLoading || !tc) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-32" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Skeleton className="h-96 lg:col-span-2" />
          <Skeleton className="h-96" />
        </div>
      </div>
    )
  }

  const isAuthor = tc.authorId === user?.userId
  const canEditAnyPerm = can('edit_any_test_case')
  const canEdit = user && (canEditAnyPerm || (isAuthor && can('edit_own_test_case')))
  const canDelete = isAuthor || can('delete_test_case')
  const canSubmit = can('submit_review')
  const canSubmitForReview = canSubmit && (tc.status === 'draft' || tc.status === 'needs_revision')

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={() => navigate('test-cases')} className="mb-1">
        <ArrowLeft className="h-4 w-4 mr-1" /> Back to Test Cases
      </Button>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Main column */}
        <div className="lg:col-span-2 space-y-4">
          {editing ? (
            <TestCaseEditor
              tc={tc}
              modules={flatModules}
              options={options ?? []}
              onCancel={() => setEditing(false)}
              onSaved={() => {
                setEditing(false)
                invalidateAfterMutation(qc, 'testCases')
              }}
            />
          ) : (
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <PriorityBadge priority={tc.priority} />
                      <StatusBadge status={tc.status} colorClass={statusColor(tc.status)} />
                      <span className="text-xs text-muted-foreground">v{tc.version}</span>
                    </div>
                    <CardTitle className="text-xl">{tc.title}</CardTitle>
                    {tc.module && (
                      <div className="text-xs text-muted-foreground mt-1">Module: {tc.module.name}</div>
                    )}
                  </div>
                  <div className="flex gap-1">
                    {canEdit && (
                      <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                        <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
                      </Button>
                    )}
                    {canDelete && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-rose-600 hover:text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-500/10 dark:text-rose-400 dark:hover:text-rose-300"
                        onClick={async () => {
                          if (!window.confirm('Permanently delete this test case? Its review history and bug links are removed too. This cannot be undone.')) return
                          try {
                            await testCasesApi.delete(tc.testCaseId)
                            toast.success('Test case permanently deleted')
                            invalidateAfterMutation(qc, 'testCases')
                            navigate('test-cases')
                          } catch (err) {
                            handleApiError(err, 'Failed to delete')
                          }
                        }}
                        title="Only the author or a role with delete rights can delete this test case"
                      >
                        <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete
                      </Button>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {tc.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {tc.tags.map((t) => <Badge key={t} variant="secondary" className="text-xs">{t}</Badge>)}
                  </div>
                )}

                <DetailField label="Description">
                  {tc.description || <span className="text-muted-foreground italic">No description</span>}
                </DetailField>

                <DetailField label="Preconditions">
                  {tc.preconditions || <span className="text-muted-foreground italic">None</span>}
                </DetailField>

                <DetailField label="Expected Result">
                  {tc.expectedResult || <span className="text-muted-foreground italic">Not specified</span>}
                </DetailField>

                <Separator />

                <div className="flex items-center gap-3">
                  {canSubmitForReview && (
                    <Button onClick={() => setSubmitOpen(true)}>
                      <Send className="h-4 w-4 mr-1" /> Submit for Review
                    </Button>
                  )}
                  {tc.status === 'in_review' && (
                    <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/25">
                      Awaiting review
                    </Badge>
                  )}
                  {tc.status === 'approved' && (
                    <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/25">
                      Approved
                    </Badge>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* Author / Reviewer cards */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <UserIcon className="h-4 w-4" /> People
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <PersonRow label="Author" name={tc.author?.fullName ?? '—'} sub={formatDateTime(tc.createdAt)} avatarUrl={tc.author?.avatarUrl} />
              {tc.assignee && (
                <PersonRow label="Reviewer" name={tc.assignee.fullName} sub="Assigned" avatarUrl={tc.assignee.avatarUrl} />
              )}
              {tc.lastEditedBy && (
                <PersonRow label="Last edited by" name={tc.lastEditedBy.fullName} sub={formatDateTime(tc.updatedAt)} avatarUrl={tc.lastEditedBy.avatarUrl} />
              )}
            </CardContent>
          </Card>

          {/* Version history */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <History className="h-4 w-4" /> Version History
              </CardTitle>
            </CardHeader>
            <CardContent>
              {!history || history.length === 0 ? (
                <div className="text-sm text-muted-foreground italic">No history yet</div>
              ) : (
                <ul className="space-y-2 max-h-48 overflow-y-auto">
                  {history.map((h) => (
                    <li key={h.historyId} className="text-xs">
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className="text-[10px]">v{h.version}</Badge>
                        <span className="font-medium">{h.changedBy?.fullName ?? 'System'}</span>
                      </div>
                      <div className="text-muted-foreground mt-0.5">
                        {h.changeSummary ?? 'Updated'} · {timeAgo(h.createdAt)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* Reviews */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <ClipboardCheck className="h-4 w-4" /> Review Cycles
              </CardTitle>
            </CardHeader>
            <CardContent>
              {!reviews || reviews.length === 0 ? (
                <div className="text-sm text-muted-foreground italic">No reviews yet</div>
              ) : (
                <ul className="space-y-2">
                  {reviews.map((r) => (
                    <li key={r.reviewRequestId} className="text-xs space-y-1">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-[10px]">Cycle {r.cycle}</Badge>
                        <StatusBadge status={r.status} colorClass={reviewStatusColor(r.status)} />
                      </div>
                      <div className="text-muted-foreground">
                        Reviewer: {r.reviewer?.fullName ?? '—'} · {timeAgo(r.createdAt)}
                      </div>
                      {r.events && r.events.length > 0 && (
                        <ul className="ml-3 space-y-0.5 border-l pl-2">
                          {r.events.map((e) => (
                            <li key={e.reviewEventId} className="flex items-start gap-1.5">
                              <Badge variant="outline" className={`text-[9px] ${verdictColor(e.verdict)}`}>
                                {e.verdict.replace('_', ' ')}
                              </Badge>
                              <span className="text-muted-foreground line-clamp-2">{e.comment}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* Activity */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Activity className="h-4 w-4" /> Activity
              </CardTitle>
            </CardHeader>
            <CardContent>
              {!activity || activity.length === 0 ? (
                <div className="text-sm text-muted-foreground italic">No activity yet</div>
              ) : (
                <ul className="space-y-1.5 max-h-48 overflow-y-auto">
                  {activity.slice(0, 8).map((log) => (
                    <li key={log.activityLogId} className="text-xs">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className={`text-[9px] ${actionColor(log.action)}`}>
                          {log.action}
                        </Badge>
                        <span className="text-muted-foreground">{timeAgo(log.createdAt)}</span>
                      </div>
                      <div className="text-muted-foreground mt-0.5">{log.user?.fullName ?? 'System'}</div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {submitOpen && tc && (
        <SubmitReviewDialog
          open={submitOpen}
          onOpenChange={setSubmitOpen}
          tc={tc}
          options={options ?? []}
          onSubmitted={() => {
            invalidateAfterMutation(qc, 'testCases', 'reviews')
          }}
        />
      )}
    </div>
  )
}

function PersonRow({ label, name, sub, avatarUrl }: { label: string; name: string; sub?: string; avatarUrl?: string | null }) {
  const initials = name.split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase()
  return (
    <div className="flex items-center gap-2">
      <Avatar className="h-8 w-8">
        {avatarUrl && <AvatarImage src={avatarUrl} alt={name} />}
        <AvatarFallback className="text-xs bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">{initials}</AvatarFallback>
      </Avatar>
      <div>
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-sm font-medium">{name}</div>
        {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
      </div>
    </div>
  )
}

// TestCaseEditor and SubmitReviewDialog live in their own focused files:
//   src/components/test-cases/test-case-editor.tsx
//   src/components/test-cases/submit-review-dialog.tsx
