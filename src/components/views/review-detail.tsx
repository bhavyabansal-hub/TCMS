'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Check, X, AlertTriangle, Flag, UserCog } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PermissionDenied } from '@/components/shared/permission-denied'
import { reviewsApi, usersApi } from '@/lib/client/api'
import { invalidateAfterMutation } from '@/lib/client/invalidate'
import { ChangeReviewerDialog } from '@/components/reviews/change-reviewer-dialog'
import { useAuthStore, useViewStore } from '@/store'
import { statusColor, reviewStatusColor, verdictColor, verdictHex, formatDateTime, timeAgo } from '@/lib/format'
import { handleApiError } from '@/lib/errors'
import { toast } from 'sonner'
import type { Verdict, UserOption } from '@/types'
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

export function ReviewDetailView() {
  const { params, navigate } = useViewStore()
  const id = params.id
  const user = useAuthStore((s) => s.user)
  const can = useAuthStore((s) => s.can)
  const qc = useQueryClient()

  const {
    data: review,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['reviews', 'detail', id],
    queryFn: () => reviewsApi.get(id),
    enabled: !!id,
    retry: 1,
  })

  const [verdictOpen, setVerdictOpen] = useState<Verdict | null>(null)
  const [forwardOpen, setForwardOpen] = useState(false)

  // Participation gate — mirrors the backend detail gate EXACTLY now
  // (audit 2026-10-09 alignment): GET /api/reviews?id= requires
  // perform_review, so the UI gate must not admit submit-only roles that
  // would only hit a 403 load error. Second layer after the sidebar; also
  // covers stale view-state across an account switch. (After all hooks.)
  if (user && !can('perform_review')) {
    return <PermissionDenied description="Review details are only available to roles with perform-review rights." />
  }

  // Failed fetch (deleted review, non-participant 403, network blip) gets an
  // explicit recovery screen instead of an endless skeleton.
  if (isError) {
    return (
      <DetailLoadError
        title="Could not load this review"
        message="It may have been deleted, or you may not be a participant in it."
        onRetry={() => refetch()}
        backHref="/reviews"
        backLabel="Back to reviews"
      />
    )
  }

  if (isLoading || !review) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-96" />
      </div>
    )
  }

  // Verdict authority mirrors the backend exactly: only the ASSIGNED reviewer
  // may decide; perform_review merely makes the role eligible to review.
  const isAssignedReviewer = review.reviewerId === user?.userId
  const isRequester = review.requesterId === user?.userId
  const canDecide = can('perform_review') && isAssignedReviewer
  const tc = review.testCase
  const canAct = canDecide && review.status !== 'completed'
  // FORWARD (owner rule 2026-10-09, clarified): the approve permission is the
  // power to re-route ANY open review to any TCMS user — including to
  // yourself, which is how a request "gets assigned to you". Verdict powers
  // only kick in once the assignment actually points at you.
  const canForward = can('perform_review') && review.status !== 'completed'

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={() => navigate('reviews')} className="mb-1">
        <ArrowLeft className="h-4 w-4 mr-1" /> Back to Reviews
      </Button>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Badge variant="outline" className="text-[10px]">Cycle {review.cycle}</Badge>
                <StatusBadge status={review.status} colorClass={reviewStatusColor(review.status)} />
                {tc && (
                  <>
                    <PriorityBadge priority={tc.priority} />
                    <StatusBadge status={tc.status} colorClass={statusColor(tc.status)} />
                  </>
                )}
              </div>
              <CardTitle className="text-xl">{tc?.title ?? 'Untitled'}</CardTitle>
              <div className="text-xs text-muted-foreground mt-1">
                Module: {tc?.module?.name ?? '—'} · Submitted by {review.requester?.fullName ?? '—'} · {timeAgo(review.createdAt)}
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              {canForward && (
                <Button size="sm" variant="outline" onClick={() => setForwardOpen(true)}>
                  <UserCog className="h-4 w-4 mr-1" /> Change Reviewer
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => tc && navigate('test-case-detail', { id: tc.testCaseId })}>
                View Test Case
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
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

          {review.dueDate && (
            <div className="text-xs text-muted-foreground">
              Due: {formatDateTime(review.dueDate)}
            </div>
          )}

          <Separator />

          {/* Test case content (read-only) */}
          {tc && (
            <>
              {tc.description && (
                <DetailField label="Description">{tc.description}</DetailField>
              )}
              {tc.preconditions && (
                <DetailField label="Preconditions">{tc.preconditions}</DetailField>
              )}
              {tc.expectedResult && (
                <DetailField label="Expected Result">{tc.expectedResult}</DetailField>
              )}
            </>
          )}

          {/* Verdict buttons */}
          {canAct && (
            <>
              <Separator />
              <div>
                <div className="text-xs font-semibold text-muted-foreground uppercase mb-2">Submit Verdict</div>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => setVerdictOpen('approved')} className="bg-emerald-600 hover:bg-emerald-700">
                    <Check className="h-4 w-4 mr-1" /> Approve
                  </Button>
                  <Button onClick={() => setVerdictOpen('failed')} className="bg-rose-600 hover:bg-rose-700">
                    <X className="h-4 w-4 mr-1" /> Fail
                  </Button>
                  <Button onClick={() => setVerdictOpen('needs_revision')} variant="outline">
                    <AlertTriangle className="h-4 w-4 mr-1" /> Needs Revision
                  </Button>
                </div>
              </div>
            </>
          )}

          {/* Non-reviewer note — explains why there are no verdict buttons */}
          {!canAct && review.status !== 'completed' && can('perform_review') && !isAssignedReviewer && (
            <div className="text-xs text-muted-foreground">
              Verdict is reserved for the assigned reviewer{review.reviewer?.fullName ? ` (${review.reviewer.fullName})` : ''}.
              Use <span className="font-medium">Change Reviewer</span> to assign it to yourself or someone else.
            </div>
          )}

          {/* Past events */}
          {review.events && review.events.length > 0 && (
            <>
              <Separator />
              <div>
                <div className="text-xs font-semibold text-muted-foreground uppercase mb-2">Review History</div>
                <ul className="space-y-2">
                  {review.events.map((e) => (
                    <li key={e.reviewEventId} className="text-sm border-l-2 pl-3 py-1" style={{ borderColor: verdictHex(e.verdict) }}>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className={`text-[10px] ${verdictColor(e.verdict)}`}>
                          {e.verdict.replace('_', ' ')}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {e.reviewer?.fullName ?? '—'} · {timeAgo(e.createdAt)}
                        </span>
                      </div>
                      {e.comment && <div className="mt-1 text-sm">{e.comment}</div>}
                      {Array.isArray(e.flaggedFields) && e.flaggedFields.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {e.flaggedFields.map((f) => (
                            <Badge key={f} variant="secondary" className="text-[10px]">
                              <Flag className="h-2.5 w-2.5 mr-1" /> {f}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {verdictOpen && (
        <VerdictDialog
          verdict={verdictOpen}
          onOpenChange={(v) => !v && setVerdictOpen(null)}
          onSubmit={async (comment, flaggedFields) => {
            try {
              await reviewsApi.verdict(id, { verdict: verdictOpen, comment, flaggedFields })
              toast.success(`Verdict submitted: ${verdictOpen.replace('_', ' ')}`)
              invalidateAfterMutation(qc, 'reviews', 'testCases')
              setVerdictOpen(null)
              navigate('reviews')
            } catch (err) {
              handleApiError(err, 'Failed to submit verdict')
            }
          }}
        />
      )}

      {forwardOpen && (
        <ChangeReviewerDialog
          currentReviewerId={review.reviewerId}
          onOpenChange={(v) => !v && setForwardOpen(false)}
          onSubmit={async (reviewerId) => {
            try {
              await reviewsApi.forward(id, reviewerId)
              toast.success('Reviewer changed — the new reviewer has been notified')
              invalidateAfterMutation(qc, 'reviews')
              setForwardOpen(false)
            } catch (err) {
              handleApiError(err, 'Failed to change the reviewer')
            }
          }}
        />
      )}
    </div>
  )
}

function VerdictDialog({
  verdict,
  onOpenChange,
  onSubmit,
}: {
  verdict: Verdict
  onOpenChange: (v: boolean) => void
  onSubmit: (comment: string, flaggedFields: string[]) => Promise<void>
}) {
  const [comment, setComment] = useState('')
  const [flagged, setFlagged] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const requiresComment = verdict !== 'approved'

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

  function toggleFlag(field: string) {
    setFlagged((f) => (f.includes(field) ? f.filter((x) => x !== field) : [...f, field]))
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="capitalize">
            {verdict === 'approved' ? 'Approve Test Case' : verdict === 'failed' ? 'Fail Test Case' : 'Request Revision'}
          </DialogTitle>
          <DialogDescription>
            {verdict === 'approved'
              ? 'Confirm that this test case meets quality standards.'
              : 'Provide specific feedback so the author can improve the test case.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {verdict !== 'approved' && (
            <div>
              <Label className="text-xs font-semibold uppercase mb-2 block">Flagged Issues (optional)</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {FLAGGABLE_FIELDS.map((f) => (
                  <label key={f} className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox checked={flagged.includes(f)} onCheckedChange={() => toggleFlag(f)} />
                    <span>{f}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="vd-comment">
              Comment {requiresComment && <span className="text-rose-500">*</span>}
            </Label>
            <Textarea
              id="vd-comment"
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
