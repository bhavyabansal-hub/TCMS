'use client'
//
// DASHBOARD V2 — "QA Command Center" (preview)
// A ground-up redesign of the dashboard view, served at /dashboard-preview so
// the production dashboard (/dashboard, dashboard.tsx) stays untouched until
// the new design is approved. Same data contract (DashboardStats) — the two
// extra aggregates it uses (priorityBreakdown, bugStatusBreakdown) are
// additive fields the stats API already computes at zero extra query cost.
//
// Layout: gradient hero -> 4 KPI cards -> quality pipeline (stacked lifecycle
// bar + priority chips) -> status donut / severity bars / bug lifecycle ->
// activity timeline + quick actions. Fully responsive, light+dark themed.

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BarChart3,
  Bug as BugIcon,
  ChevronRight,
  ClipboardCheck,
  Eye,
  FilePlus2,
  FolderTree,
  Inbox,
  ListChecks,
  ListTodo,
  LogIn,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { statsApi, reviewsApi, bugsApi } from '@/lib/client/api'
import { useViewStore, useAuthStore } from '@/store'
import { timeAgo, statusHex, severityHex, priorityHex, bugStatusHex, initials } from '@/lib/format'
import type { ActivityLog, Bug, DashboardStats, Paginated, ReviewRequest } from '@/types'
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  LabelList,
} from 'recharts'

// ---------- tiny count-up animation for KPI numbers (no deps) ----------

function useCountUp(target: number, duration = 700): number {
  const [value, setValue] = useState(0)
  useEffect(() => {
    if (!Number.isFinite(target)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- animation reset: drives the requestAnimationFrame loop, not a derived render
      setValue(0)
      return
    }
    let raf = 0
    const start = performance.now()
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - p, 3)
      setValue(Math.round(target * eased))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, duration])
  return value
}

// ---------- label maps ----------

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  in_review: 'In Review',
  needs_revision: 'Needs Revision',
  approved: 'Approved',
  active: 'Active',
  deprecated: 'Deprecated',
}

/** Compact labels for the 6-across pipeline legend chips (so the % never
 *  gets truncated the way "Needs Revision · 5%" did). */
const STATUS_SHORT: Record<string, string> = {
  draft: 'Draft',
  in_review: 'In Review',
  needs_revision: 'Revision',
  approved: 'Approved',
  active: 'Active',
  deprecated: 'Deprecated',
}

const BUG_STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  closed: 'Closed',
  wont_fix: "Won't Fix",
}

/** Ordered lifecycle for the pipeline bar (draft flows to deprecated). */
const PIPELINE_ORDER = ['draft', 'in_review', 'needs_revision', 'approved', 'active', 'deprecated']

function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

// ---------- main view ----------

export function DashboardViewV2() {
  const navigate = useViewStore((s) => s.navigate)
  const user = useAuthStore((s) => s.user)
  const can = useAuthStore((s) => s.can)
  const { data, isLoading, isError, refetch, isRefetching } = useQuery<DashboardStats>({
    queryKey: ['stats', 'dashboard'],
    queryFn: statsApi.dashboard,
    refetchInterval: 30_000,
  })

  // ---- Focus Queue data (personal, live) ----
  const canReview = useAuthStore((s) => s.canAny(['perform_review']))
  const queueQuery = useQuery<ReviewRequest[]>({
    queryKey: ['reviews', 'queue'],
    queryFn: reviewsApi.queue,
    enabled: canReview,
    refetchInterval: 60_000,
    retry: false,
    staleTime: 30_000,
  })
  const myBugsQuery = useQuery<Paginated<Bug>>({
    queryKey: ['bugs', 'focus', user?.userId ?? ''],
    queryFn: () => bugsApi.list({ assignedToId: user?.userId ?? '', pageSize: '50' }),
    enabled: !!user,
    refetchInterval: 60_000,
    retry: false,
    staleTime: 30_000,
  })

  if (isLoading) return <DashboardSkeleton />

  if (isError || !data) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          <AlertTriangle className="mx-auto h-8 w-8 mb-2" />
          <p className="mb-4">Failed to load dashboard data.</p>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            <RefreshCw className="h-4 w-4 mr-1" /> Retry
          </Button>
        </CardContent>
      </Card>
    )
  }

  const counts = Object.fromEntries(data.statusBreakdown.map((s) => [s.status, s.count]))
  const c = (k: string) => counts[k] ?? 0
  const total = data.statusBreakdown.reduce((sum, s) => sum + s.count, 0)
  const approvedish = c('approved') + c('active')
  const approvalPct = total > 0 ? Math.round((approvedish / total) * 100) : 0
  const sev = Object.fromEntries(data.severityBreakdown.map((s) => [s.severity, s.count]))
  const bugStatuses = data.bugStatusBreakdown ?? []
  const bugTotal = bugStatuses.reduce((sum, s) => sum + s.count, 0)
  const priorities = data.priorityBreakdown ?? []
  const firstName = user?.fullName.split(' ')[0] ?? 'there'

  // ---- Suite Health Score (composite 0-100, transparent weights) ----
  const approvalPts = total > 0 ? Math.round((40 * approvedish) / total) : 0
  const bugPts = data.openBugs === 0 ? 30 : Math.max(0, 30 - data.openBugs * 3)
  const reviewPts = Math.max(0, 15 - c('needs_revision') * 3 - Math.max(0, c('in_review') - 5))
  const draftRatio = total > 0 ? c('draft') / total : 0
  const freshPts = total > 0 ? Math.round(15 * Math.max(0, Math.min(1, 1 - draftRatio * 1.5))) : 0
  const healthScore = total > 0 ? approvalPts + bugPts + reviewPts + freshPts : 0
  const healthTier =
    healthScore >= 85
      ? { label: 'Excellent', color: '#10b981', cls: 'text-emerald-600 dark:text-emerald-400' }
      : healthScore >= 65
        ? { label: 'Good', color: '#0ea5e9', cls: 'text-sky-600 dark:text-sky-400' }
        : healthScore >= 45
          ? { label: 'Fair', color: '#f59e0b', cls: 'text-amber-600 dark:text-amber-400' }
          : { label: 'At Risk', color: '#f43f5e', cls: 'text-rose-600 dark:text-rose-400' }
  const healthVerdict =
    total === 0
      ? ''
      : data.openBugs > 0
        ? `${data.openBugs} open bug${data.openBugs === 1 ? ' is' : 's are'} the biggest drag — closing them lifts the score fastest.`
        : c('needs_revision') > 0
          ? `${c('needs_revision')} test case${c('needs_revision') === 1 ? '' : 's'} stuck in revision — rework them to lift the score.`
          : c('draft') > 0
            ? `${c('draft')} draft${c('draft') === 1 ? '' : 's'} still waiting to enter review.`
            : 'Every dimension is healthy — nice work.'

  // ---- Focus Queue items (reviews assigned to me + my open bugs) ----
  const focusItems: FocusItem[] = []
  if (queueQuery.data) {
    for (const r of queueQuery.data) {
      focusItems.push({
        key: `review-${r.reviewRequestId}`,
        kind: 'review',
        title: r.testCase?.title ?? 'Untitled test case',
        meta: `Review · cycle ${r.cycle}`,
        ageMs: Date.now() - new Date(r.createdAt).getTime(),
        createdAt: r.createdAt,
        rank: 0,
        onClick: () => navigate('review-detail', { id: r.reviewRequestId }),
      })
    }
  }
  if (myBugsQuery.data) {
    for (const b of myBugsQuery.data.data) {
      if (b.status !== 'open' && b.status !== 'in_progress') continue
      focusItems.push({
        key: `bug-${b.bugId}`,
        kind: 'bug',
        title: b.title,
        meta: `${b.severity.charAt(0).toUpperCase()}${b.severity.slice(1)} · ${b.status.replace('_', ' ')}`,
        ageMs: Date.now() - new Date(b.createdAt).getTime(),
        createdAt: b.createdAt,
        rank: b.severity === 'critical' ? 3 : b.severity === 'high' ? 2 : 1,
        onClick: () => navigate('bugs'),
      })
    }
  }
  focusItems.sort((a, b) => b.rank - a.rank || b.ageMs - a.ageMs)
  const focusShown = focusItems.slice(0, 8)
  const focusLoading = queueQuery.isLoading || myBugsQuery.isLoading

  return (
    <div className="space-y-5">
      {/* ---------- Hero (graphite — matches the app's neutral shell) ---------- */}
      <section
        aria-label="Overview"
        className="relative overflow-hidden rounded-xl border bg-gradient-to-br from-zinc-900 via-zinc-900 to-zinc-800 px-5 py-6 md:px-7 md:py-7 text-zinc-50 shadow-sm animate-in fade-in slide-in-from-bottom-2 duration-500"
      >
        {/* decorative glows — neutral, with one faint status-colored accent */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute -top-20 -right-16 h-64 w-64 rounded-full bg-white/[0.07] blur-2xl" />
          <div className="absolute -bottom-24 left-1/3 h-56 w-56 rounded-full bg-white/[0.04] blur-2xl" />
          <div className="absolute -bottom-16 right-24 h-32 w-32 rounded-full bg-emerald-500/10 blur-2xl" />
          <Sparkles className="absolute right-6 top-6 h-5 w-5 text-zinc-600" />
        </div>

        <div className="relative flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
              {greeting()}, {firstName} 👋
            </h1>
            <p className="mt-1 text-sm text-zinc-400">
              {new Date().toLocaleDateString('en-US', {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
              })}{' '}
              · Here is the pulse of your QA team today.
            </p>
            {/* glassy inline summary */}
            <div className="mt-4 flex flex-wrap gap-2">
              <HeroChip label="test cases" value={total} />
              <HeroChip label="open bugs" value={data.openBugs} />
              <HeroChip label="pending reviews" value={data.myPendingReviews} />
              <HeroChip label="suite approved" value={`${approvalPct}%`} />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <Button
              onClick={() => navigate('test-cases')}
              className="bg-white text-zinc-900 hover:bg-zinc-200 shadow-sm"
            >
              <Plus className="h-4 w-4 mr-1" /> New Test Case
            </Button>
            <Button
              variant="outline"
              onClick={() => navigate('bugs')}
              className="border-zinc-700 bg-white/5 text-zinc-200 hover:bg-white/10 hover:text-white"
            >
              <BugIcon className="h-4 w-4 mr-1" /> Report Bug
            </Button>
            {can('view_all_task_reports') && (
              <Button
                variant="outline"
                onClick={() => navigate('reports')}
                className="border-zinc-700 bg-white/5 text-zinc-200 hover:bg-white/10 hover:text-white"
              >
                <BarChart3 className="h-4 w-4 mr-1" /> Reports
              </Button>
            )}
          </div>
        </div>
      </section>

      {/* ---------- KPI cards ---------- */}
      <section aria-label="Key metrics" className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard
          index={0}
          icon={<ListChecks className="h-5 w-5" />}
          tint="sky"
          label="Total Test Cases"
          value={data.totalTestCases}
          sub={
            <span>
              <span className="font-medium text-slate-600 dark:text-slate-300">{c('draft')}</span> draft ·{' '}
              <span className="font-medium text-slate-600 dark:text-slate-300">{c('in_review')}</span> in review
            </span>
          }
          onClick={() => navigate('test-cases')}
        />
        <KpiCard
          index={1}
          icon={<ShieldCheck className="h-5 w-5" />}
          tint="emerald"
          label="Approved & Active"
          value={approvedish}
          sub={
            <span className="flex items-center gap-2">
              <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-700">
                <span
                  className="absolute inset-y-0 left-0 rounded-full bg-emerald-500"
                  style={{ width: `${approvalPct}%` }}
                />
              </span>
              <span className="whitespace-nowrap font-medium text-emerald-600 dark:text-emerald-400">
                {approvalPct}% of suite
              </span>
            </span>
          }
          onClick={() => navigate('test-cases')}
        />
        <KpiCard
          index={2}
          icon={<BugIcon className="h-5 w-5" />}
          tint="rose"
          label="Open Bugs"
          value={data.openBugs}
          sub={
            <span>
              <span className="font-medium text-rose-600 dark:text-rose-400">{sev.critical ?? 0}</span> critical ·{' '}
              <span className="font-medium text-orange-600 dark:text-orange-400">{sev.high ?? 0}</span> high (all bugs)
            </span>
          }
          onClick={() => navigate('bugs')}
        />
        <KpiCard
          index={3}
          icon={<ClipboardCheck className="h-5 w-5" />}
          tint="amber"
          label="My Pending Reviews"
          value={data.myPendingReviews}
          sub={
            data.myPendingReviews === 0 ? (
              <span className="font-medium text-emerald-600 dark:text-emerald-400">All caught up 🎉</span>
            ) : (
              <span className="font-medium text-amber-600 dark:text-amber-400">Waiting on your verdict</span>
            )
          }
          onClick={() => navigate('reviews')}
        />
      </section>

      {/* ---------- Quality pipeline + health score ---------- */}
      <section className="grid grid-cols-1 xl:grid-cols-3 gap-4">
      <Card className="xl:col-span-2 animate-in fade-in slide-in-from-bottom-2 duration-500 fill-mode-both [animation-delay:150ms]">
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Quality Pipeline</CardTitle>
            <CardDescription>Every test case, by where it stands in its lifecycle</CardDescription>
          </div>
          <div className="hidden sm:flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            live · refreshes 30s
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* stacked lifecycle bar */}
          {total === 0 ? (
            <div className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
              No test cases yet — create your first one to see the pipeline fill up.
            </div>
          ) : (
            <div className="flex h-3.5 w-full gap-1 overflow-hidden">
              {PIPELINE_ORDER.map((k) => {
                const v = c(k)
                if (v === 0) return null
                return (
                  <div
                    key={k}
                    title={`${STATUS_LABELS[k]}: ${v}`}
                    className="h-full rounded-full transition-all"
                    style={{ flexGrow: v, flexBasis: 0, backgroundColor: statusHex(k) }}
                  />
                )
              })}
            </div>
          )}

          {/* legend */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {PIPELINE_ORDER.map((k) => (
              <button
                key={k}
                onClick={() => navigate('test-cases')}
                className="group flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition hover:border-foreground/25 hover:bg-accent/50"
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: statusHex(k) }} />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold leading-tight tabular-nums whitespace-nowrap">
                    {c(k)}
                    {total > 0 && <span className="text-[11px] font-normal text-muted-foreground"> · {Math.round((c(k) / total) * 100)}%</span>}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">{STATUS_SHORT[k]}</span>
                </span>
              </button>
            ))}
          </div>

          {/* priority strip */}
          {priorities.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-4">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">By priority</span>
              {['P0', 'P1', 'P2', 'P3'].map((p) => {
                const v = priorities.find((x) => x.priority === p)?.count ?? 0
                return (
                  <span key={p} className="flex items-center gap-1.5 text-sm">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: priorityHex(p) }} />
                    <span className="font-semibold tabular-nums">{v}</span>
                    <span className="text-muted-foreground">{p}</span>
                  </span>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <HealthScoreCard
        score={healthScore}
        tier={healthTier}
        verdict={healthVerdict}
        empty={total === 0}
        dims={[
          { label: 'Approval', pts: approvalPts, max: 40, color: '#10b981' },
          { label: 'Bugs', pts: bugPts, max: 30, color: '#f43f5e' },
          { label: 'Reviews', pts: reviewPts, max: 15, color: '#f59e0b' },
          { label: 'Freshness', pts: freshPts, max: 15, color: '#0ea5e9' },
        ]}
      />
      </section>

      {/* ---------- Charts row ---------- */}
      <section className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {/* status donut */}
        <Card className="animate-in fade-in slide-in-from-bottom-2 duration-500 fill-mode-both [animation-delay:200ms]">
          <CardHeader>
            <CardTitle className="text-base">Status Mix</CardTitle>
            <CardDescription>Distribution across the suite</CardDescription>
          </CardHeader>
          <CardContent>
            {total === 0 ? (
              <ChartEmpty />
            ) : (
              <div className="relative h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={data.statusBreakdown.filter((s) => s.count > 0)}
                      dataKey="count"
                      nameKey="status"
                      cx="50%"
                      cy="50%"
                      innerRadius={62}
                      outerRadius={88}
                      paddingAngle={3}
                      cornerRadius={6}
                      strokeWidth={0}
                    >
                      {data.statusBreakdown
                        .filter((s) => s.count > 0)
                        .map((s) => (
                          <Cell key={s.status} fill={statusHex(s.status)} />
                        ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
                {/* center metric */}
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-3xl font-bold tabular-nums leading-none">{total}</span>
                  <span className="mt-1 text-[11px] text-muted-foreground">test cases</span>
                </div>
              </div>
            )}
            {/* legend */}
            <div className="mt-3 flex flex-wrap justify-center gap-x-3 gap-y-1.5">
              {data.statusBreakdown.map((s) => (
                <span key={s.status} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: statusHex(s.status) }} />
                  {STATUS_LABELS[s.status] ?? s.status} · <span className="font-medium text-foreground">{s.count}</span>
                </span>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* severity bars */}
        <Card className="animate-in fade-in slide-in-from-bottom-2 duration-500 fill-mode-both [animation-delay:250ms]">
          <CardHeader>
            <CardTitle className="text-base">Bug Severity</CardTitle>
            <CardDescription>All bugs, worst first</CardDescription>
          </CardHeader>
          <CardContent>
            {data.severityBreakdown.every((s) => s.count === 0) || data.severityBreakdown.length === 0 ? (
              <ChartEmpty />
            ) : (
              <div className="h-56 text-foreground">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={data.severityBreakdown}
                    layout="vertical"
                    margin={{ top: 4, right: 34, bottom: 4, left: 4 }}
                  >
                    <XAxis type="number" hide />
                    <YAxis
                      type="category"
                      dataKey="severity"
                      width={64}
                      tickLine={false}
                      axisLine={false}
                      tick={{ fill: 'currentColor', fontSize: 12 }}
                      tickFormatter={(v: string) => v.charAt(0).toUpperCase() + v.slice(1)}
                    />
                    <Tooltip cursor={{ fill: 'rgba(148,163,184,0.10)' }} />
                    <Bar dataKey="count" radius={[6, 6, 6, 6]} barSize={18}>
                      {data.severityBreakdown.map((s) => (
                        <Cell key={s.severity} fill={severityHex(s.severity)} />
                      ))}
                      <LabelList
                        dataKey="count"
                        position="right"
                        style={{ fill: 'var(--foreground)', fontSize: 12, fontWeight: 600 }}
                      />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
            <div className="mt-3 flex flex-wrap justify-center gap-x-3 gap-y-1.5">
              {['critical', 'high', 'medium', 'low'].map((s) => (
                <span key={s} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: severityHex(s) }} />
                  {s.charAt(0).toUpperCase() + s.slice(1)} ·{' '}
                  <span className="font-medium text-foreground">
                    {data.severityBreakdown.find((x) => x.severity === s)?.count ?? 0}
                  </span>
                </span>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* bug lifecycle */}
        <Card className="animate-in fade-in slide-in-from-bottom-2 duration-500 fill-mode-both [animation-delay:300ms]">
          <CardHeader>
            <CardTitle className="text-base">Bug Lifecycle</CardTitle>
            <CardDescription>Where bugs stand · {bugTotal} total</CardDescription>
          </CardHeader>
          <CardContent>
            {bugTotal === 0 ? (
              <ChartEmpty />
            ) : (
              <ul className="space-y-3.5">
                {['open', 'in_progress', 'resolved', 'closed', 'wont_fix'].map((k) => {
                  const v = bugStatuses.find((x) => x.status === k)?.count ?? 0
                  const pct = bugTotal > 0 ? Math.round((v / bugTotal) * 100) : 0
                  return (
                    <li key={k}>
                      <button
                        onClick={() => navigate('bugs')}
                        className="group w-full text-left"
                        aria-label={`${BUG_STATUS_LABELS[k]}: ${v} bugs`}
                      >
                        <div className="mb-1 flex items-center justify-between text-sm">
                          <span className="flex items-center gap-2">
                            <span
                              className="h-2 w-2 rounded-full"
                              style={{ backgroundColor: bugStatusHex(k) }}
                            />
                            <span className="font-medium">{BUG_STATUS_LABELS[k]}</span>
                          </span>
                          <span className="tabular-nums">
                            <span className="font-semibold">{v}</span>
                            <span className="ml-1.5 text-xs text-muted-foreground">{pct}%</span>
                          </span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-700/60">
                          <div
                            className="h-full rounded-full transition-all duration-700"
                            style={{ width: `${pct}%`, backgroundColor: bugStatusHex(k) }}
                          />
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ---------- Focus queue + quick actions ---------- */}
      <section className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Card className="xl:col-span-2 animate-in fade-in slide-in-from-bottom-2 duration-500 fill-mode-both [animation-delay:350ms]">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">Focus Queue</CardTitle>
              <CardDescription>Everything waiting on you, most urgent first</CardDescription>
            </div>
            {focusItems.length > 0 && (
              <span className="rounded-full bg-rose-100 px-2.5 py-0.5 text-xs font-semibold text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
                {focusItems.length}
              </span>
            )}
          </CardHeader>
          <CardContent>
            {focusLoading ? (
              <div className="space-y-2.5">
                {[...Array(3)].map((_, i) => (
                  <Skeleton key={i} className="h-14 rounded-lg" />
                ))}
              </div>
            ) : focusShown.length === 0 ? (
              <div className="py-10 text-center">
                <Inbox className="mx-auto h-8 w-8 text-muted-foreground/50 mb-2" />
                <p className="text-sm font-medium">Nothing needs you right now</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Reviews assigned to you and bugs assigned to you will land here.
                </p>
              </div>
            ) : (
              <ul className="max-h-[340px] space-y-2 overflow-y-auto pr-1 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border">
                {focusShown.map((item) => (
                  <FocusRow key={item.key} item={item} />
                ))}
                {focusItems.length > focusShown.length && (
                  <li className="pt-1 text-center">
                    <button
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => navigate('reviews')}
                    >
                      + {focusItems.length - focusShown.length} more · view reviews
                    </button>
                  </li>
                )}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="animate-in fade-in slide-in-from-bottom-2 duration-500 fill-mode-both [animation-delay:400ms]">
          <CardHeader>
            <CardTitle className="text-base">Quick Actions</CardTitle>
            <CardDescription>Jump straight to work</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3">
            <QuickAction icon={<FilePlus2 className="h-4 w-4" />} tint="sky" label="New Test Case" onClick={() => navigate('test-cases')} />
            <QuickAction icon={<BugIcon className="h-4 w-4" />} tint="rose" label="Report Bug" onClick={() => navigate('bugs')} />
            <QuickAction icon={<ClipboardCheck className="h-4 w-4" />} tint="amber" label="Reviews" onClick={() => navigate('reviews')} />
            <QuickAction icon={<ListTodo className="h-4 w-4" />} tint="teal" label="Tasks" onClick={() => navigate('tasks')} />
            <QuickAction icon={<FolderTree className="h-4 w-4" />} tint="violet" label="Modules" onClick={() => navigate('modules')} />
            <QuickAction icon={<BarChart3 className="h-4 w-4" />} tint="emerald" label="Reports" onClick={() => navigate('reports')} />
          </CardContent>
        </Card>
      </section>

      {/* ---------- Latest activity (full width) ---------- */}
      <Card className="animate-in fade-in slide-in-from-bottom-2 duration-500 fill-mode-both [animation-delay:450ms]">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Latest Activity</CardTitle>
            <CardDescription>What the team touched most recently</CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={() => navigate('activity-log')}>
            View all <ChevronRight className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent>
          {data.recentActivity.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">No recent activity</div>
          ) : (
            <ol className="relative max-h-[380px] space-y-1 overflow-y-auto pr-1 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border">
              {/* rail */}
              <span
                aria-hidden
                className="absolute left-[15px] top-3 bottom-3 w-px bg-border"
              />
              {data.recentActivity.map((log) => (
                <ActivityRow key={log.activityLogId} log={log} />
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ---------- pieces ----------

interface FocusItem {
  key: string
  kind: 'review' | 'bug'
  title: string
  meta: string
  ageMs: number
  createdAt: string
  /** sort weight — critical bugs outrank reviews, reviews outrank minor bugs */
  rank: number
  onClick: () => void
}

const STALE_MS = 72 * 60 * 60 * 1000

function FocusRow({ item }: { item: FocusItem }) {
  const stale = item.ageMs > STALE_MS
  const isReview = item.kind === 'review'
  return (
    <li>
      <button
        onClick={item.onClick}
        className="group flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-all hover:border-foreground/25 hover:bg-accent/50"
      >
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
            isReview
              ? 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300'
              : 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300'
          }`}
        >
          {isReview ? <ClipboardCheck className="h-4 w-4" /> : <BugIcon className="h-4 w-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{item.title}</span>
          <span className="block truncate text-xs text-muted-foreground">{item.meta}</span>
        </span>
        {stale && (
          <span className="shrink-0 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
            aging
          </span>
        )}
        <span className="shrink-0 text-right text-[11px] text-muted-foreground whitespace-nowrap">
          {timeAgo(item.createdAt)}
        </span>
        <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      </button>
    </li>
  )
}

interface HealthDim {
  label: string
  pts: number
  max: number
  color: string
}

function ScoreRing({ score, tier }: { score: number; tier: { label: string; color: string; cls: string } }) {
  const counted = useCountUp(score, 900)
  const R = 52
  const C = 2 * Math.PI * R
  return (
    <div className="relative h-32 w-32 shrink-0">
      <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
        <circle cx="60" cy="60" r={R} fill="none" strokeWidth="10" className="stroke-slate-100 dark:stroke-slate-700/60" />
        <circle
          cx="60"
          cy="60"
          r={R}
          fill="none"
          strokeWidth="10"
          strokeLinecap="round"
          stroke={tier.color}
          strokeDasharray={C}
          strokeDashoffset={C - (C * score) / 100}
          style={{ transition: 'stroke-dashoffset 900ms cubic-bezier(0.22,1,0.36,1)' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-bold tabular-nums leading-none">{counted}</span>
        <span className="mt-0.5 text-[10px] text-muted-foreground">of 100</span>
      </div>
    </div>
  )
}

function HealthScoreCard({
  score,
  tier,
  verdict,
  empty,
  dims,
}: {
  score: number
  tier: { label: string; color: string; cls: string }
  verdict: string
  empty: boolean
  dims: HealthDim[]
}) {
  return (
    <Card className="animate-in fade-in slide-in-from-bottom-2 duration-500 fill-mode-both [animation-delay:200ms]">
      <CardHeader>
        <CardTitle className="text-base">Suite Health Score</CardTitle>
        <CardDescription>One number for suite quality — transparent weights</CardDescription>
      </CardHeader>
      <CardContent>
        {empty ? (
          <div className="flex h-40 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            Score appears once you have test cases
          </div>
        ) : (
          <div className="flex flex-col items-center gap-5 sm:flex-row">
            <div className="flex flex-col items-center">
              <ScoreRing score={score} tier={tier} />
              <span className={`mt-1 text-sm font-semibold ${tier.cls}`}>{tier.label}</span>
            </div>
            <div className="w-full min-w-0 flex-1 space-y-2.5">
              {dims.map((d) => {
                const pct = Math.round((d.pts / d.max) * 100)
                return (
                  <div key={d.label}>
                    <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                      <span className="min-w-0 truncate text-muted-foreground">{d.label}</span>
                      <span className="shrink-0 font-semibold tabular-nums">
                        {d.pts}
                        <span className="font-normal text-muted-foreground">/{d.max}</span>
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-700/60">
                      <div
                        className="h-full rounded-full transition-all duration-700"
                        style={{ width: `${pct}%`, backgroundColor: d.color }}
                      />
                    </div>
                  </div>
                )
              })}
              <p className="border-t pt-2.5 text-xs leading-relaxed text-muted-foreground">{verdict}</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function HeroChip({ label, value }: { label: string; value: number | string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-medium ring-1 ring-white/10">
      <span className="text-sm font-bold tabular-nums">{value}</span>
      <span className="text-zinc-300">{label}</span>
    </span>
  )
}

const TINTS: Record<string, { chip: string; glow: string }> = {
  sky: { chip: 'bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300', glow: 'rgba(14,165,233,0.35)' },
  emerald: { chip: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300', glow: 'rgba(16,185,129,0.35)' },
  rose: { chip: 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300', glow: 'rgba(244,63,94,0.30)' },
  amber: { chip: 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300', glow: 'rgba(245,158,11,0.30)' },
  teal: { chip: 'bg-teal-100 text-teal-600 dark:bg-teal-500/15 dark:text-teal-300', glow: 'rgba(20,184,166,0.35)' },
  violet: { chip: 'bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300', glow: 'rgba(139,92,246,0.30)' },
}

/** Staggered entry delays — static classes so Tailwind JIT can see them. */
const STAGGER = [
  '[animation-delay:0ms]',
  '[animation-delay:70ms]',
  '[animation-delay:140ms]',
  '[animation-delay:210ms]',
]

function KpiCard({
  icon,
  tint,
  label,
  value,
  sub,
  onClick,
  index,
}: {
  icon: React.ReactNode
  tint: keyof typeof TINTS
  label: string
  value: number
  sub: React.ReactNode
  onClick?: () => void
  index: number
}) {
  const counted = useCountUp(value)
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className={`group relative overflow-hidden rounded-xl border bg-card p-5 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md animate-in fade-in slide-in-from-bottom-2 fill-mode-both ${STAGGER[index] ?? STAGGER[0]}`}
    >
      {/* corner glow */}
      <span
        aria-hidden
        className="pointer-events-none absolute -right-6 -top-6 h-20 w-20 rounded-full opacity-40 blur-xl transition-opacity group-hover:opacity-70"
        style={{ backgroundColor: TINTS[tint].glow }}
      />
      <div className="relative flex items-start justify-between">
        <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${TINTS[tint].chip}`}>{icon}</div>
        <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      <div className="relative mt-4 text-3xl font-bold tabular-nums leading-none">{counted}</div>
      <div className="relative mt-1.5 text-sm font-medium">{label}</div>
      <div className="relative mt-1 text-xs text-muted-foreground">{sub}</div>
    </button>
  )
}

const ACTIVITY_STYLE: Record<string, { icon: React.ReactNode; cls: string }> = {
  CREATE: { icon: <Plus className="h-3.5 w-3.5" />, cls: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300' },
  UPDATE: { icon: <Pencil className="h-3.5 w-3.5" />, cls: 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300' },
  DELETE: { icon: <Trash2 className="h-3.5 w-3.5" />, cls: 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300' },
  REVIEW: { icon: <Eye className="h-3.5 w-3.5" />, cls: 'bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300' },
  STATUS: { icon: <RefreshCw className="h-3.5 w-3.5" />, cls: 'bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300' },
  LOGIN: { icon: <LogIn className="h-3.5 w-3.5" />, cls: 'bg-slate-100 text-slate-500 dark:bg-slate-500/15 dark:text-slate-300' },
}

function activityStyle(action: string) {
  return (
    ACTIVITY_STYLE[action.split('_')[0]] ?? {
      icon: <Activity className="h-3.5 w-3.5" />,
      cls: 'bg-slate-100 text-slate-500 dark:bg-slate-500/15 dark:text-slate-300',
    }
  )
}

function ActivityRow({ log }: { log: ActivityLog }) {
  const style = activityStyle(log.action)
  const name = log.user?.fullName ?? 'System'
  // LOGIN rows read cleaner without the redundant "· user" entity suffix.
  const entityLabel =
    log.entityType && log.entityType !== 'user' ? ` · ${log.entityType.replace(/_/g, ' ')}` : ''
  return (
    <li className="relative flex items-start gap-3 rounded-lg px-1 py-2.5 transition-colors hover:bg-accent/40">
      {/* avatar with graceful initials fallback when no URL / broken URL */}
      <Avatar className="relative z-10 h-8 w-8 ring-4 ring-card">
        {log.user?.avatarUrl && <AvatarImage src={log.user.avatarUrl} alt="" />}
        <AvatarFallback className="bg-gradient-to-br from-slate-200 to-slate-300 text-[10px] font-bold text-slate-600 dark:from-slate-600 dark:to-slate-700 dark:text-slate-200">
          {initials(name)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">
          <span className="font-semibold">{name}</span>
          <span className="text-muted-foreground">
            {' '}
            · {log.action.toLowerCase().replace(/_/g, ' ')}{entityLabel}
          </span>
        </p>
        {log.entityName && (
          <p className="truncate text-xs text-muted-foreground mt-0.5">{log.entityName}</p>
        )}
      </div>
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${style.cls}`}
        title={log.action}
      >
        {style.icon}
      </span>
      <span className="w-16 shrink-0 pt-1 text-right text-[11px] text-muted-foreground whitespace-nowrap">
        {timeAgo(log.createdAt)}
      </span>
    </li>
  )
}

function QuickAction({
  icon,
  tint,
  label,
  onClick,
}: {
  icon: React.ReactNode
  tint: keyof typeof TINTS
  label: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="group flex flex-col items-start gap-2.5 rounded-lg border p-3.5 text-left transition-all hover:-translate-y-0.5 hover:border-foreground/25 hover:shadow-sm"
    >
      <span className={`flex h-9 w-9 items-center justify-center rounded-lg ${TINTS[tint].chip}`}>{icon}</span>
      <span className="text-xs font-medium leading-tight">{label}</span>
    </button>
  )
}

function ChartEmpty() {
  return (
    <div className="flex h-56 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
      Nothing to chart yet
    </div>
  )
}

function DashboardSkeleton() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-40 rounded-xl" />
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <Skeleton key={i} className="h-36 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-52 rounded-xl" />
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {[...Array(3)].map((_, i) => (
          <Skeleton key={i} className="h-80 rounded-xl" />
        ))}
      </div>
    </div>
  )
}
