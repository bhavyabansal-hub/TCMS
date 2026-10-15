'use client'

import { useQuery } from '@tanstack/react-query'
import { Link2, ListChecks, Bug as BugIcon, ClipboardCheck, Plus, AlertTriangle } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { statsApi, testCasesApi, bugsApi } from '@/lib/client/api'
import { useViewStore, useAuthStore } from '@/store'
import { actionColor, timeAgo, statusHex, severityHex } from '@/lib/format'
import { PageHeader } from '@/components/shared/page-header'
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import type { DashboardStats } from '@/types'

export function DashboardView() {
  const navigate = useViewStore((s) => s.navigate)
  const user = useAuthStore((s) => s.user)
  const { data, isLoading, isError } = useQuery<DashboardStats>({
    queryKey: ['stats', 'dashboard'],
    queryFn: statsApi.dashboard,
    refetchInterval: 30_000,
  })

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-28" />)}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Skeleton className="h-72" />
          <Skeleton className="h-72" />
        </div>
      </div>
    )
  }

  if (isError || !data) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          <AlertTriangle className="mx-auto h-8 w-8 mb-2" />
          Failed to load dashboard data.
        </CardContent>
      </Card>
    )
  }

  const total = data.statusBreakdown.reduce((sum, s) => sum + s.count, 0) || 1

  return (
    <div className="space-y-6">
      <PageHeader
        title={<>Welcome back, {user?.fullName.split(' ')[0]} 👋</>}
        description="Here's what's happening with your QA team today."
        actions={
          <>
            <Button onClick={() => navigate('test-cases')}>
              <Plus className="h-4 w-4 mr-1" /> New Test Case
            </Button>
            <Button variant="outline" onClick={() => navigate('bugs')}>
              <BugIcon className="h-4 w-4 mr-1" /> Report Bug
            </Button>
          </>
        }
      />

      {/* Stat cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={<ListChecks className="h-5 w-5" />}
          label="Total Test Cases"
          value={data.totalTestCases}
          accent="bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300"
          onClick={() => navigate('test-cases')}
        />
        <StatCard
          icon={<BugIcon className="h-5 w-5" />}
          label="Open Bugs"
          value={data.openBugs}
          accent="bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300"
          onClick={() => navigate('bugs')}
        />
        <StatCard
          icon={<ClipboardCheck className="h-5 w-5" />}
          label="My Pending Reviews"
          value={data.myPendingReviews}
          accent="bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
          onClick={() => navigate('reviews')}
        />
        <StatCard
          icon={<Link2 className="h-5 w-5" />}
          label="Approved Test Cases"
          // approved + active: both statuses mean the case passed review and
          // is in force (matches the QA Command Center's approval metric).
          value={
            (data.statusBreakdown.find((s) => s.status === 'approved')?.count ?? 0) +
            (data.statusBreakdown.find((s) => s.status === 'active')?.count ?? 0)
          }
          accent="bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
          onClick={() => navigate('test-cases')}
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Test Cases by Status</CardTitle>
            <CardDescription>Current distribution across all modules</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={data.statusBreakdown}
                    dataKey="count"
                    nameKey="status"
                    cx="50%"
                    cy="50%"
                    outerRadius={80}
                    innerRadius={40}
                    label={(entry) => `${entry.status}: ${entry.count}`}
                  >
                    {data.statusBreakdown.map((s) => (
                      <Cell key={s.status} fill={statusHex(s.status)} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="text-center text-xs text-muted-foreground mt-2">
              Total: {total} test cases
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Open Bugs by Severity</CardTitle>
            <CardDescription>Critical / High / Medium / Low</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.severityBreakdown} layout="vertical" margin={{ left: 30 }}>
                  <XAxis type="number" />
                  <YAxis type="category" dataKey="severity" width={70} />
                  <Tooltip />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                    {data.severityBreakdown.map((s) => (
                      <Cell key={s.severity} fill={severityHex(s.severity)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent activity */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Recent Activity</CardTitle>
            <CardDescription>Latest 10 actions across the system</CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={() => navigate('activity-log')}>
            View all
          </Button>
        </CardHeader>
        <CardContent>
          {data.recentActivity.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">No recent activity</div>
          ) : (
            <ul className="divide-y">
              {data.recentActivity.map((log) => (
                <li key={log.activityLogId} className="py-2.5 flex items-center gap-3">
                  <Badge variant="outline" className={`text-[10px] ${actionColor(log.action)}`}>
                    {log.action}
                  </Badge>
                  <span className="text-sm flex-1 min-w-0 truncate">
                    <span className="font-medium">{log.user?.fullName ?? 'System'}</span>
                    <span className="text-muted-foreground"> · {log.entityType}</span>
                    {log.entityName && <span className="text-muted-foreground"> · {log.entityName}</span>}
                  </span>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">{timeAgo(log.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  accent,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  value: number
  accent: string
  onClick?: () => void
}) {
  return (
    <Card className="hover:shadow-md transition cursor-pointer" onClick={onClick}>
      <CardContent className="p-5 flex items-center gap-4">
        <div className={`h-12 w-12 rounded-lg flex items-center justify-center ${accent}`}>{icon}</div>
        <div className="min-w-0">
          <div className="text-2xl font-bold leading-tight">{value}</div>
          <div className="text-xs text-muted-foreground truncate">{label}</div>
        </div>
      </CardContent>
    </Card>
  )
}
