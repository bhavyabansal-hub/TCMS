'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft, CheckCircle2, ClipboardCheck, Clock, AlertTriangle,
  ChevronDown, ChevronRight, Check, X, AlertCircle, UserCog, Flag,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { PermissionDenied } from '@/components/shared/permission-denied'
import { moduleReviewsApi, reviewsApi } from '@/lib/client/api'
import { invalidateAfterMutation } from '@/lib/client/invalidate'
import { ChangeReviewerDialog } from '@/components/reviews/change-reviewer-dialog'
import { useAuthStore, useViewStore } from '@/store'
import {
  statusColor, verdictColor, verdictHex, reviewStatusColor, moduleReviewStatusColor, formatDateTime, timeAgo,
} from '@/lib/format'
import { handleApiError } from '@/lib/errors'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { ModuleReviewRequest, Verdict } from '@/types'
import { PriorityBadge, StatusBadge } from '@/components/shared/badges'
import { DetailField } from '@/components/shared/detail-field'
import { DetailLoadError } from '@/components/shared/query-error'

const FLAGGABLE_FIELDS = [
  'Wrong expected result',
  'Missing preconditions',
  'Missing tags',
  'Incomplete description',
  'Ambiguous title',
]

export function ModuleReviewDetailView() {
  const { params, navigate } = useViewStore()
  const id = params.id
  const user = useAuthStore((s) => s.user)
  const can = useAuthStore((s) => s.can)
  const qc = useQueryClient()
  // Proper verdict dialogs (owner ask): no native window.prompt anywhere —
  // bulk verdicts (approve all / fail all / needs-revision all) and single
  // case verdicts both open a real dialog with a comment box.
  const [bulkVerdict, setBulkVerdict] = useState<Verdict | null>(null)
  const [caseVerdict, setCaseVerdict] = useState<{ caseId: string; caseTitle: string; verdict: Verdict; updatedAt: string } | null>(null)
  const [changeReviewerOpen, setChangeReviewerOpen] = useState(false)
  const [expandedCases, setExpandedCases] = useState<Set<string>>(new Set())

  // After any verdict (or approve-all) the module review detail, the test-case
  // list behind it and the reviewer's queues are all stale — one shared
  // invalidation set instead of four drifting copies.
  const invalidateAfterVerdict = () => {
    invalidateAfterMutation(qc, 'moduleReviews', 'reviews')
  }

  const {
    data: review,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['module-reviews', 'detail', id],
    queryFn: () => moduleReviewsApi.get(id),
    enabled: !!id,
    retry: 1,
  })

  // Participation gate — mirrors the backend detail gate EXACTLY now
  // (audit 2026-10-09 alignment): module-review detail requires
  // perform_review server-side, so the UI gate must not admit submit-only
  // roles that would only hit a 403 load error. (After all hooks.)
  if (user && !can('perform_review')) {
    return <PermissionDenied description="Module reviews are only available to roles with perform-review rights." />
  }

  function toggleCase(caseId: string) {
    setExpandedCases((s) => {
      const next = new Set(s)
      if (next.has(caseId)) next.delete(caseId)
      else next.add(caseId)
      return next
    })
  }

  // Failed fetch (deleted review, non-participant 403, network blip) gets an
  // explicit recovery screen instead of an endless skeleton.
  if (isError) {
    return (
      <DetailLoadError
        title="Could not load this module review"
        message="It may have been deleted, or you may not be a participant in it."
        onRetry={() => refetch()}
        backHref="/module-reviews"
        backLabel="Back to module reviews"
      />
    )
  }

  if (isLoading || !review) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-64" />
      </div>
    )
  }

  // Verdict authority mirrors the backend bulk-approve rule exactly: only the
  // ASSIGNED reviewer may decide; perform_review merely makes the role
  // eligible to review.
  const isAssignedReviewer = review.reviewerId === user?.userId
  const canDecide = can('perform_review') && isAssignedReviewer
  const canAct = canDecide && review.status !== 'completed'
  const caseReviews = review.caseReviews ?? []
  const pendingCount = caseReviews.filter((c) => c.status !== 'completed').length
  const approvedCount = caseReviews.filter((c) =>
    c.events?.some((e) => e.verdict === 'approved')
  ).length
  const revisionCount = caseReviews.filter((c) =>
    c.events?.some((e) => e.verdict === 'failed' || e.verdict === 'needs_revision')
  ).length

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={() => navigate('reviews')} className="mb-1">
        <ArrowLeft className="h-4 w-4 mr-1" /> Back to Reviews
      </Button>

      {/* Header */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Badge variant="outline" className="text-[10px]">Module Review</Badge>
                <Badge variant="outline" className="text-[10px]">Cycle {review.cycle}</Badge>
                <StatusBadge status={review.status} colorClass={moduleReviewStatusColor(review.status)} />
              </div>
              <CardTitle className="text-xl">{review.module?.name ?? 'Module'}</CardTitle>
              <div className="text-xs text-muted-foreground mt-1">
                Submitted by {review.requester?.fullName ?? '—'} · {timeAgo(review.createdAt)}
                {review.dueDate && <> · Due {formatDateTime(review.dueDate)}</>}
              </div>
            </div>
            <div className="flex flex-col items-end gap-2">
              {canAct && pendingCount > 0 && (
                <div className="flex flex-wrap justify-end gap-2">
                  <Button size="sm" onClick={() => setBulkVerdict('approved')} className="bg-emerald-600 hover:bg-emerald-700">
                    <CheckCircle2 className="h-4 w-4 mr-1" /> Approve All ({pendingCount})
                  </Button>
                  <Button size="sm" onClick={() => setBulkVerdict('failed')} className="bg-rose-600 hover:bg-rose-700">
                    <X className="h-4 w-4 mr-1" /> Fail All ({pendingCount})
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setBulkVerdict('needs_revision')}>
                    <AlertTriangle className="h-4 w-4 mr-1" /> Needs Revision ({pendingCount})
                  </Button>
                </div>
              )}
              {can('perform_review') && review.status !== 'completed' && (
                <Button size="sm" variant="outline" onClick={() => setChangeReviewerOpen(true)}>
                  <UserCog className="h-4 w-4 mr-1" /> Change Reviewer
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {/* People */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="flex items-center gap-2">
              <Avatar className="h-8 w-8">
                {review.requester?.avatarUrl && <AvatarImage src={review.requester.avatarUrl} alt={review.requester.fullName} />}
                <AvatarFallback className="text-xs bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300">
                  {(review.requester?.fullName ?? '?').split(' ').map((n) => n[0]).slice(0, 2).join('')}
                </AvatarFallback>
              </Avatar>
              <div>
                <div className="text-xs text-muted-foreground">Submitted by</div>
                <div className="font-medium">{review.requester?.fullName ?? '—'}</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Avatar className="h-8 w-8">
                {review.reviewer?.avatarUrl && <AvatarImage src={review.reviewer.avatarUrl} alt={review.reviewer.fullName} />}
                <AvatarFallback className="text-xs bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                  {(review.reviewer?.fullName ?? '?').split(' ').map((n) => n[0]).slice(0, 2).join('')}
                </AvatarFallback>
              </Avatar>
              <div>
                <div className="text-xs text-muted-foreground">Reviewer</div>
                <div className="font-medium">{review.reviewer?.fullName ?? '—'}</div>
              </div>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-3 mt-4">
            <Stat label="Total Cases" value={caseReviews.length} color="bg-slate-100 text-slate-700 dark:bg-slate-400/15 dark:text-slate-300" />
            <Stat label="Approved" value={approvedCount} color="bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" />
            <Stat label="Needs Attention" value={pendingCount} color="bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300" />
          </div>
        </CardContent>
      </Card>

      {/* Non-reviewer note — explains why there are no verdict buttons */}
      {!canAct && review.status !== 'completed' && can('perform_review') && !isAssignedReviewer && (
        <div className="text-xs text-muted-foreground px-1">
          Verdict is reserved for the assigned reviewer{review.reviewer?.fullName ? ` (${review.reviewer.fullName})` : ''}.
          Use <span className="font-medium">Change Reviewer</span> to assign it to yourself or someone else.
        </div>
      )}

      {/* Test case list */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ClipboardCheck className="h-4 w-4" />
            Test Cases in this Review ({caseReviews.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {caseReviews.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              No test cases in this review.
            </div>
          ) : (
            <ul className="divide-y">
              {caseReviews.map((cr) => {
                const tc = cr.testCase
                if (!tc) return null
                const lastEvent = cr.events?.[cr.events.length - 1]
                const isExpanded = expandedCases.has(cr.reviewRequestId)
                const isApproved = cr.status === 'completed' && lastEvent?.verdict === 'approved'
                const needsRevision = cr.status === 'completed' && lastEvent && lastEvent.verdict !== 'approved'
                return (
                  <li key={cr.reviewRequestId} className="">
                    <button
                      className="w-full text-left p-3 hover:bg-accent transition flex items-center gap-3"
                      onClick={() => toggleCase(cr.reviewRequestId)}
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                      )}
                      <span className="h-2 w-2 rounded-full shrink-0"
                        style={{
                          backgroundColor: isApproved ? '#10b981' : needsRevision ? '#f43f5e' : '#f59e0b',
                        }}
                      />
                      <span className="flex-1 min-w-0">
                        <span className="block font-medium truncate">{tc.title}</span>
                        <span className="block text-xs text-muted-foreground">
                          {tc.author?.fullName ?? '—'} · {timeAgo(cr.createdAt)}
                        </span>
                      </span>
                      <PriorityBadge priority={tc.priority} />
                      <StatusBadge status={tc.status} colorClass={statusColor(tc.status)} />
                      <StatusBadge status={cr.status} colorClass={reviewStatusColor(cr.status)} />
                    </button>

                    {isExpanded && (
                      <div className="px-4 pb-4 pt-1 bg-muted/30 space-y-3">
                        {/* Test case content (read-only) */}
                        {tc.description && (
                          <DetailField label="Description">{tc.description}</DetailField>
                        )}
                        {tc.preconditions && (
                          <DetailField label="Preconditions">{tc.preconditions}</DetailField>
                        )}
                        {tc.expectedResult && (
                          <DetailField label="Expected Result">{tc.expectedResult}</DetailField>
                        )}

                        {/* Past events for this case review */}
                        {cr.events && cr.events.length > 0 && (
                          <div>
                            <div className="text-xs font-semibold text-muted-foreground uppercase mb-1">Review History</div>
                            <ul className="space-y-1.5">
                              {cr.events.map((e) => (
                                <li key={e.reviewEventId} className="text-xs border-l-2 pl-2 py-0.5" style={{ borderColor: verdictHex(e.verdict) }}>
                                  <div className="flex items-center gap-2">
                                    <Badge variant="outline" className={`text-[9px] ${verdictColor(e.verdict)}`}>
                                      {e.verdict.replace('_', ' ')}
                                    </Badge>
                                    <span className="text-muted-foreground">
                                      {e.reviewer?.fullName ?? '—'} · {timeAgo(e.createdAt)}
                                    </span>
                                  </div>
                                  {e.comment && <div className="mt-0.5">{e.comment}</div>}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {/* Verdict buttons (only for reviewer and pending cases) —
                            all three open a proper dialog with a comment box */}
                        {canAct && cr.status !== 'completed' && (
                          <div className="flex flex-wrap gap-2 pt-1">
                            <VerdictButton verdict="approved" onClick={() => setCaseVerdict({ caseId: cr.reviewRequestId, caseTitle: tc.title, verdict: 'approved', updatedAt: cr.updatedAt })} />
                            <VerdictButton verdict="failed" onClick={() => setCaseVerdict({ caseId: cr.reviewRequestId, caseTitle: tc.title, verdict: 'failed', updatedAt: cr.updatedAt })} />
                            <VerdictButton verdict="needs_revision" onClick={() => setCaseVerdict({ caseId: cr.reviewRequestId, caseTitle: tc.title, verdict: 'needs_revision', updatedAt: cr.updatedAt })} />
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {bulkVerdict && (
        <BulkVerdictDialog
          verdict={bulkVerdict}
          pendingCount={pendingCount}
          onOpenChange={(v) => !v && setBulkVerdict(null)}
          onConfirm={async (comment) => {
            try {
              const res = await moduleReviewsApi.bulkVerdict(id, { verdict: bulkVerdict, comment, expectedUpdatedAt: review?.updatedAt })
              toast.success(
                res.verdict === 'approved'
                  ? `Approved ${res.affectedCount} test case(s)`
                  : res.verdict === 'failed'
                    ? `Failed ${res.affectedCount} test case(s)`
                    : `Revision requested on ${res.affectedCount} test case(s)`
              )
              invalidateAfterVerdict()
              setBulkVerdict(null)
            } catch (err) {
              handleApiError(err, 'Failed to record the bulk verdict')
            }
          }}
        />
      )}

      {caseVerdict && (
        <CaseVerdictDialog
          caseTitle={caseVerdict.caseTitle}
          verdict={caseVerdict.verdict}
          onOpenChange={(v) => !v && setCaseVerdict(null)}
          onSubmit={async (comment, flaggedFields) => {
            try {
              await reviewsApi.verdict(caseVerdict.caseId, { verdict: caseVerdict.verdict, comment, flaggedFields, expectedUpdatedAt: caseVerdict.updatedAt })
              toast.success(
                caseVerdict.verdict === 'approved'
                  ? 'Test case approved'
                  : caseVerdict.verdict === 'failed'
                    ? 'Test case failed'
                    : 'Revision requested'
              )
              invalidateAfterVerdict()
              setCaseVerdict(null)
            } catch (err) {
              handleApiError(err, 'Failed to submit verdict')
            }
          }}
        />
      )}

      {changeReviewerOpen && (
        <ChangeReviewerDialog
          currentReviewerId={review.reviewerId}
          title="Change Reviewer"
          description={`Reassign this module review and its open test case(s) to another TCMS user — they will be notified and everything lands in their queue. Choose yourself to take over the review.`}
          onOpenChange={(v) => !v && setChangeReviewerOpen(false)}
          onSubmit={async (reviewerId) => {
            try {
              await moduleReviewsApi.changeReviewer(id, reviewerId)
              toast.success('Reviewer changed — the new reviewer has been notified')
              invalidateAfterVerdict()
              setChangeReviewerOpen(false)
            } catch (err) {
              handleApiError(err, 'Failed to change the reviewer')
            }
          }}
        />
      )}
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className={cn('rounded-md p-3 text-center', color)}>
      <div className="text-2xl font-bold leading-tight">{value}</div>
      <div className="text-[10px] uppercase tracking-wide">{label}</div>
    </div>
  )
}

function VerdictButton({ verdict, onClick }: { verdict: Verdict; onClick: () => void }) {
  const config = {
    approved: { label: 'Approve', icon: Check, className: 'bg-emerald-600 hover:bg-emerald-700' },
    failed: { label: 'Fail', icon: X, className: 'bg-rose-600 hover:bg-rose-700' },
    needs_revision: { label: 'Needs Revision', icon: AlertTriangle, className: '' },
  }[verdict]
  const Icon = config.icon
  return (
    <Button size="sm" className={config.className} variant={verdict === 'needs_revision' ? 'outline' : 'default'} onClick={onClick}>
      <Icon className="h-3.5 w-3.5 mr-1" /> {config.label}
    </Button>
  )
}

/** Bulk verdict dialog — one verdict for every open case review of the
 *  module, with a proper comment box (owner ask). Approve keeps its optional
 *  comment; fail / needs-revision REQUIRE a written message. */
function BulkVerdictDialog({
  verdict,
  pendingCount,
  onOpenChange,
  onConfirm,
}: {
  verdict: Verdict
  pendingCount: number
  onOpenChange: (v: boolean) => void
  onConfirm: (comment: string) => Promise<void>
}) {
  const [comment, setComment] = useState('')
  const [flagged, setFlagged] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const config = {
    approved: {
      title: 'Approve All Test Cases',
      icon: <CheckCircle2 className="h-5 w-5 text-emerald-600" />,
      description: (
        <>This will approve all <span className="font-medium text-foreground">{pendingCount}</span> open test case(s)
        in this module review in a single action. Each test case moves to "approved" and the module review is
        marked completed.</>
      ),
      submitLabel: `Approve ${pendingCount} Test Case${pendingCount === 1 ? '' : 's'}`,
      submitClass: 'bg-emerald-600 hover:bg-emerald-700',
      commentRequired: false,
      commentPlaceholder: 'Optional — e.g. "Bulk approved with module review."',
    },
    failed: {
      title: 'Fail All Test Cases',
      icon: <X className="h-5 w-5 text-rose-600" />,
      description: (
        <>This records a <span className="font-medium text-foreground">failed</span> verdict on all
        {' '}<span className="font-medium text-foreground">{pendingCount}</span> open test case(s). Each test case
        moves to "needs revision" and the module review is marked completed.</>
      ),
      submitLabel: `Fail ${pendingCount} Test Case${pendingCount === 1 ? '' : 's'}`,
      submitClass: 'bg-rose-600 hover:bg-rose-700',
      commentRequired: true,
      commentPlaceholder: 'Explain what failed across these test cases…',
    },
    needs_revision: {
      title: 'Request Revision on All Test Cases',
      icon: <AlertTriangle className="h-5 w-5 text-amber-600" />,
      description: (
        <>This records a <span className="font-medium text-foreground">needs revision</span> verdict on all
        {' '}<span className="font-medium text-foreground">{pendingCount}</span> open test case(s). The module
        review stays open so you can re-check after the authors revise.</>
      ),
      submitLabel: 'Request Revision',
      submitClass: '',
      commentRequired: true,
      commentPlaceholder: 'Explain what needs to be improved…',
    },
  }[verdict]

  async function handleSubmit() {
    if (config.commentRequired && !comment.trim()) {
      toast.error('Comment is required for this verdict — write what needs to change')
      return
    }
    setSaving(true)
    try {
      await onConfirm(comment.trim())
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">{config.icon} {config.title}</DialogTitle>
          <DialogDescription>{config.description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {verdict !== 'approved' && (
            <div>
              <Label className="text-xs font-semibold uppercase mb-2 block">Flagged Issues (optional)</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {FLAGGABLE_FIELDS.map((f) => (
                  <label key={f} className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox checked={flagged.includes(f)} onCheckedChange={() => toggleFlag(flagged, setFlagged, f)} />
                    <span>{f}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="bv-comment">
              Comment {config.commentRequired && <span className="text-rose-500">*</span>}
            </Label>
            <Textarea
              id="bv-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={4}
              placeholder={config.commentPlaceholder}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={handleSubmit}
            disabled={saving || (config.commentRequired && !comment.trim())}
            className={config.submitClass}
          >
            {saving ? 'Recording…' : config.submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function toggleFlag(flagged: string[], setFlagged: (f: string[]) => void, field: string) {
  setFlagged(flagged.includes(field) ? flagged.filter((x) => x !== field) : [...flagged, field])
}

/** Single case verdict dialog inside the module view — proper comment box
 *  (replaces the old window.prompt flow), mirroring the review-detail dialog. */
function CaseVerdictDialog({
  caseTitle,
  verdict,
  onOpenChange,
  onSubmit,
}: {
  caseTitle: string
  verdict: Verdict
  onOpenChange: (v: boolean) => void
  onSubmit: (comment: string, flaggedFields: string[]) => Promise<void>
}) {
  const [comment, setComment] = useState('')
  const [flagged, setFlagged] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const requiresComment = verdict !== 'approved'
  const title = verdict === 'approved' ? 'Approve Test Case' : verdict === 'failed' ? 'Fail Test Case' : 'Request Revision'

  async function handleSubmit() {
    if (requiresComment && !comment.trim()) {
      toast.error('Comment is required for this verdict')
      return
    }
    setSaving(true)
    try {
      await onSubmit(comment.trim(), flagged)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {verdict === 'approved'
              ? `Confirm that "${caseTitle}" meets quality standards.`
              : `Provide specific feedback so the author of "${caseTitle}" can improve it.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {verdict !== 'approved' && (
            <div>
              <Label className="text-xs font-semibold uppercase mb-2 block">Flagged Issues (optional)</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {FLAGGABLE_FIELDS.map((f) => (
                  <label key={f} className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox checked={flagged.includes(f)} onCheckedChange={() => toggleFlag(flagged, setFlagged, f)} />
                    <span>{f}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="cv-comment">
              Comment {requiresComment && <span className="text-rose-500">*</span>}
            </Label>
            <Textarea
              id="cv-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={4}
              placeholder={
                verdict === 'approved'
                  ? 'Optional praise or notes...'
                  : 'Explain what needs to be improved...'
              }
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={handleSubmit}
            disabled={saving || (requiresComment && !comment.trim())}
            className={verdict === 'approved' ? 'bg-emerald-600 hover:bg-emerald-700' : verdict === 'failed' ? 'bg-rose-600 hover:bg-rose-700' : ''}
          >
            {saving ? 'Submitting...' : `Submit ${verdict.replace('_', ' ')}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
