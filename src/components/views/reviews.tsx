'use client'

import { useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ClipboardCheck, ListChecks, Clock, AlertCircle, FolderCheck, Layers } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { PermissionDenied } from '@/components/shared/permission-denied'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { reviewsApi, moduleReviewsApi } from '@/lib/client/api'
import { useAuthStore, useViewStore } from '@/store'
import { statusColor, formatDateTime, timeAgo, reviewStatusColor } from '@/lib/format'
import { StateLoadingCards, StateEmpty } from '@/components/shared/state'
import { QueryErrorAlert } from '@/components/shared/query-error'
import { PriorityBadge, StatusBadge } from '@/components/shared/badges'
import { PageHeader } from '@/components/shared/page-header'
import type { ReviewRequest, ModuleReviewRequest } from '@/types'

export function ReviewsView() {
  const user = useAuthStore((s) => s.user)
  const can = useAuthStore((s) => s.can)
  const navigate = useViewStore((s) => s.navigate)
  const [tab, setTab] = useState<'module-queue' | 'queue' | 'all'>('module-queue')

  // Module reviews assigned to me
  const {
    data: moduleQueue,
    isLoading: moduleQueueLoading,
    isError: moduleQueueError,
    refetch: moduleQueueRefetch,
  } = useQuery({
    queryKey: ['module-reviews', 'queue'],
    queryFn: moduleReviewsApi.queue,
    enabled: !!user,
    refetchInterval: 30_000,
  })

  // Individual case reviews assigned to me (not part of a module review)
  const {
    data: queue,
    isLoading: queueLoading,
    isError: queueError,
    refetch: queueRefetch,
  } = useQuery({
    queryKey: ['reviews', 'queue'],
    queryFn: reviewsApi.queue,
    enabled: !!user,
    refetchInterval: 30_000,
  })
  // Filter out case reviews that belong to a module review (those are shown in the module tab)
  const standaloneQueue = (queue ?? []).filter((r) => !r.moduleReviewId)

  const {
    data: allReviews,
    isLoading: allLoading,
    isError: allError,
    refetch: allRefetch,
  } = useQuery({
    queryKey: ['reviews', 'all'],
    queryFn: () => reviewsApi.list({ pageSize: '100' }),
    placeholderData: keepPreviousData,
    enabled: tab === 'all',
  })

  const {
    data: allModuleReviews,
    isLoading: allModuleLoading,
    isError: allModuleError,
    refetch: allModuleRefetch,
  } = useQuery({
    queryKey: ['module-reviews', 'all'],
    queryFn: moduleReviewsApi.all,
    enabled: tab === 'all',
  })

  // STRICT review visibility: the reviews workspace belongs to reviewers
  // (perform_review) — matching the backend gate on every cross-user read.
  // Submitters track their cases via test-case status and notifications.
  const canSeeAll = user && can('perform_review')

  // In-view guard (rules of hooks: after all queries). The sidebar hides this
  // view for non-reviewers; this is the second layer — e.g. when the view
  // store still points here across an account switch.
  if (user && !can('perform_review')) {
    return (
      <div className="space-y-4">
        <PageHeader title="Reviews" description="Module-level and individual test-case reviews" />
        <PermissionDenied description="The reviews workspace is only available to roles with perform-review rights. You are assigned as reviewer only when a review is sent to you — ask a manager if you should be able to review." />
      </div>
    )
  }

  const moduleQueueCount = (moduleQueue ?? []).length
  const queueCount = standaloneQueue.length

  return (
    <div className="space-y-4">
      <PageHeader title="Reviews" description="Module-level and individual test-case reviews" />

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'module-queue' | 'queue' | 'all')}>
        <TabsList>
          <TabsTrigger value="module-queue" className="gap-1">
            <Layers className="h-3.5 w-3.5" />
            Module Reviews
            {moduleQueueCount > 0 && (
              <Badge variant="secondary" className="ml-1 h-4 min-w-4 px-1 text-[10px]">{moduleQueueCount}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="queue" className="gap-1">
            <ListChecks className="h-3.5 w-3.5" />
            Single Test Cases
            {queueCount > 0 && (
              <Badge variant="secondary" className="ml-1 h-4 min-w-4 px-1 text-[10px]">{queueCount}</Badge>
            )}
          </TabsTrigger>
          {canSeeAll && (
            <TabsTrigger value="all" className="gap-1">
              <ClipboardCheck className="h-3.5 w-3.5" /> All Reviews
            </TabsTrigger>
          )}
        </TabsList>

        {/* Module Reviews tab */}
        <TabsContent value="module-queue" className="mt-4">
          {moduleQueueError ? (
            <QueryErrorAlert title="Could not load module reviews" onRetry={() => moduleQueueRefetch()} />
          ) : moduleQueueLoading ? (
            <StateLoadingCards count={2} />
          ) : !moduleQueue || moduleQueue.length === 0 ? (
            <StateEmpty icon={<Layers className="h-10 w-10" />} title="No pending module reviews" description="You're all caught up!" />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {moduleQueue.map((r) => (
                <ModuleReviewCard
                  key={r.moduleReviewRequestId}
                  review={r}
                  onClick={() => navigate('module-review-detail', { id: r.moduleReviewRequestId })}
                />
              ))}
            </div>
          )}
        </TabsContent>

        {/* Single Test Cases tab */}
        <TabsContent value="queue" className="mt-4">
          {queueError ? (
            <QueryErrorAlert title="Could not load your review queue" onRetry={() => queueRefetch()} />
          ) : queueLoading ? (
            <StateLoadingCards count={4} />
          ) : standaloneQueue.length === 0 ? (
            <StateEmpty icon={<ClipboardCheck className="h-10 w-10" />} title="No individual test-case reviews pending" />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {standaloneQueue.map((r) => (
                <ReviewCard key={r.reviewRequestId} review={r} onClick={() => navigate('review-detail', { id: r.reviewRequestId })} />
              ))}
            </div>
          )}
        </TabsContent>

        {/* All Reviews tab — PERMISSION = VISIBILITY (owner rule): every
            perform_review holder sees ALL review requests here. Acting is a
            different axis: verdicts stay with the ASSIGNED reviewer, and the
            Forward button is how a request gets (re)assigned to someone. */}
        {canSeeAll && (
          <TabsContent value="all" className="mt-4 space-y-6">
            <p className="text-xs text-muted-foreground">
              Showing all review requests — the review permission grants visibility. You can only
              approve or reject reviews assigned to you; open any review to forward it to another
              user (or to yourself) to (re)assign it.
            </p>
            <div>
              <div className="text-xs font-semibold text-muted-foreground uppercase mb-2">Module Reviews</div>
              {allModuleError ? (
                <QueryErrorAlert title="Could not load module reviews" onRetry={() => allModuleRefetch()} />
              ) : allModuleLoading ? (
                <StateLoadingCards count={2} />
              ) : !allModuleReviews || allModuleReviews.length === 0 ? (
                <StateEmpty title="No module reviews yet." className="py-8" />
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {allModuleReviews.map((r) => (
                    <ModuleReviewCard
                      key={r.moduleReviewRequestId}
                      review={r}
                      onClick={() => navigate('module-review-detail', { id: r.moduleReviewRequestId })}
                    />
                  ))}
                </div>
              )}
            </div>
            <div>
              <div className="text-xs font-semibold text-muted-foreground uppercase mb-2">Individual Test Case Reviews</div>
              {allError ? (
                <QueryErrorAlert title="Could not load individual reviews" onRetry={() => allRefetch()} />
              ) : allLoading ? (
                <StateLoadingCards count={4} />
              ) : !allReviews || allReviews.data.length === 0 ? (
                <StateEmpty title="No individual reviews yet." className="py-8" />
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {allReviews.data.map((r) => (
                    <ReviewCard key={r.reviewRequestId} review={r} onClick={() => navigate('review-detail', { id: r.reviewRequestId })} />
                  ))}
                </div>
              )}
            </div>
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}

function ModuleReviewCard({ review, onClick }: { review: ModuleReviewRequest; onClick: () => void }) {
  const due = review.dueDate ? new Date(review.dueDate) : null
  const overdue = due && due < new Date() && review.status !== 'completed'
  const caseCount = review.caseCount ?? review.caseReviews?.length ?? 0
  return (
    <Card className="hover:shadow-md transition cursor-pointer border-l-4 border-l-emerald-400" onClick={onClick}>
      <CardContent className="p-4 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2 flex-1 min-w-0">
            <FolderCheck className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">
                {review.module?.name ?? 'Module'}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Module review · Cycle {review.cycle}
              </div>
            </div>
          </div>
          <StatusBadge status={review.status} colorClass={reviewStatusColor(review.status)} />
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="secondary" className="text-[10px]">
            <Layers className="h-2.5 w-2.5 mr-1" />
            {caseCount} test case{caseCount === 1 ? '' : 's'}
          </Badge>
          <span className="text-muted-foreground">Reviewer: {review.reviewer?.fullName ?? '—'}</span>
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>From: {review.requester?.fullName ?? '—'}</span>
          {due ? (
            <span className={overdue ? 'text-rose-600 font-medium flex items-center gap-1' : 'flex items-center gap-1'}>
              {overdue ? <AlertCircle className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
              Due {formatDateTime(due)}
            </span>
          ) : (
            <span>{timeAgo(review.createdAt)}</span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function ReviewCard({ review, onClick }: { review: ReviewRequest; onClick: () => void }) {
  const due = review.dueDate ? new Date(review.dueDate) : null
  const overdue = due && due < new Date() && review.status !== 'completed'
  return (
    <Card className="hover:shadow-md transition cursor-pointer" onClick={onClick}>
      <CardContent className="p-4 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="font-medium truncate">
              {review.testCase?.title ?? 'Untitled test case'}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {review.testCase?.module?.name ?? 'No module'}
            </div>
          </div>
          <StatusBadge status={review.status} colorClass={reviewStatusColor(review.status)} />
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <PriorityBadge priority={review.testCase?.priority ?? 'P2'} />
          <StatusBadge status={review.testCase?.status ?? 'draft'} colorClass={statusColor(review.testCase?.status ?? 'draft')} />
          <span className="text-muted-foreground">Cycle {review.cycle}</span>
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>From: {review.requester?.fullName ?? '—'}</span>
          {due ? (
            <span className={overdue ? 'text-rose-600 font-medium flex items-center gap-1' : 'flex items-center gap-1'}>
              {overdue ? <AlertCircle className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
              Due {formatDateTime(due)}
            </span>
          ) : (
            <span>{timeAgo(review.createdAt)}</span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
