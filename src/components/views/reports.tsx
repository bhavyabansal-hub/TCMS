'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Printer } from 'lucide-react'

import { statsApi } from '@/lib/client/api'
import type { ReportsStats } from '@/types'
import { useAuthStore } from '@/store'
import { STATUS_HEX } from '@/lib/format'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { PermissionDenied } from '@/components/shared/permission-denied'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PRIORITY_HEX, BUG_STATUS_HEX, isoDaysAgo } from '@/lib/format'

export function ReportsView() {
  const { user, can } = useAuthStore()
  const [dateFrom, setDateFrom] = useState<string>(isoDaysAgo(30))
  const [dateTo, setDateTo] = useState<string>(isoDaysAgo(0))

  const reportsQuery = useQuery<ReportsStats>({
    queryKey: ['stats', 'reports'],
    queryFn: () => statsApi.reports(),
    // Don't fire before the gate below decides — the API 403s this for
    // viewers (fetch-before-check cleanup, audit 2026-10-09).
    enabled: !!user && can('view_all_task_reports'),
  })

  if (user && !can('view_all_task_reports')) {
    return <PermissionDenied description="The reports view is only available to roles with view-all-reports rights." />
  }

  const data = reportsQuery.data

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Team work hours, test case distribution, and bug status overview.
          </p>
        </div>
        <Button variant="outline" onClick={() => window.print()}>
          <Printer className="h-4 w-4" /> Export PDF
        </Button>
      </div>

      <Tabs defaultValue="team">
        <TabsList>
          <TabsTrigger value="team">Team summary</TabsTrigger>
          <TabsTrigger value="tests">Test case metrics</TabsTrigger>
        </TabsList>

        <TabsContent value="team" className="space-y-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle className="text-base">Weekly hours by user</CardTitle>
                <CardDescription>Last 30 days of task reports</CardDescription>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="from" className="text-xs">From</Label>
                  <Input
                    id="from"
                    type="date"
                    className="w-40"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="to" className="text-xs">To</Label>
                  <Input
                    id="to"
                    type="date"
                    className="w-40"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {reportsQuery.isLoading ? (
                <Skeleton className="h-72 w-full" />
              ) : reportsQuery.isError ? (
                <Alert variant="destructive">
                  <AlertDescription>Failed to load report data.</AlertDescription>
                </Alert>
              ) : (
                <TeamSummary data={data} />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tests" className="space-y-4">
          {reportsQuery.isLoading ? (
            <div className="grid gap-4 md:grid-cols-2">
              <Skeleton className="h-72 w-full" />
              <Skeleton className="h-72 w-full" />
              <Skeleton className="h-72 w-full md:col-span-2" />
            </div>
          ) : reportsQuery.isError ? (
            <Alert variant="destructive">
              <AlertDescription>Failed to load test case metrics.</AlertDescription>
            </Alert>
          ) : (
            <div className="print-area grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Test cases by status</CardTitle>
                  <CardDescription>Distribution across all statuses</CardDescription>
                </CardHeader>
                <CardContent>
                  <PieDonut
                    data={(data?.testCasesByStatus ?? []).map((d) => ({
                      name: d.status,
                      value: d.count,
                    }))}
                    colorMap={STATUS_HEX}
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Test cases by priority</CardTitle>
                  <CardDescription>P0 through P3</CardDescription>
                </CardHeader>
                <CardContent>
                  <PieDonut
                    data={(data?.testCasesByPriority ?? []).map((d) => ({
                      name: d.priority,
                      value: d.count,
                    }))}
                    colorMap={PRIORITY_HEX}
                  />
                </CardContent>
              </Card>

              <Card className="md:col-span-2">
                <CardHeader>
                  <CardTitle className="text-base">Bugs by status</CardTitle>
                  <CardDescription>Current bug backlog distribution</CardDescription>
                </CardHeader>
                <CardContent>
                  <BugsBarChart data={data?.bugsByStatus ?? []} />
                </CardContent>
              </Card>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

function TeamSummary({ data }: { data?: ReportsStats }) {
  const { weeks, users, table, totalsByUser } = useMemo(() => {
    const weeklyHours = data?.weeklyHours ?? []
    const weekSet = new Set<string>()
    const userSet = new Map<string, string>()
    for (const row of weeklyHours) {
      weekSet.add(row.week)
      if (!userSet.has(row.user)) userSet.set(row.user, row.user)
    }
    const weeksArr = Array.from(weekSet).sort()
    const usersArr = Array.from(userSet.keys())

    const tableMap = new Map<string, Map<string, number>>()
    const totals = new Map<string, number>()
    for (const row of weeklyHours) {
      if (!tableMap.has(row.user)) tableMap.set(row.user, new Map())
      tableMap.get(row.user)!.set(row.week, row.hours)
      totals.set(row.user, (totals.get(row.user) ?? 0) + row.hours)
    }
    return {
      weeks: weeksArr,
      users: usersArr,
      table: tableMap,
      totalsByUser: totals,
    }
  }, [data])

  const barData = useMemo(
    () =>
      users.map((u) => ({
        user: u.length > 18 ? u.slice(0, 16) + '…' : u,
        hours: +(totalsByUser.get(u) ?? 0).toFixed(1),
      })),
    [users, totalsByUser]
  )

  if (!data || users.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        No task report data in the selected range.
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 bg-background z-10 min-w-44">User</TableHead>
              {weeks.map((w) => (
                <TableHead key={w} className="text-right">
                  {w}
                </TableHead>
              ))}
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <TableRow key={u}>
                <TableCell className="font-medium">{u}</TableCell>
                {weeks.map((w) => {
                  const v = table.get(u)?.get(w) ?? 0
                  return (
                    <TableCell
                      key={w}
                      className={`text-right tabular-nums ${
                        v > 0 ? '' : 'text-muted-foreground'
                      }`}
                    >
                      {v > 0 ? v.toFixed(1) : '—'}
                    </TableCell>
                  )
                })}
                <TableCell className="text-right font-semibold tabular-nums">
                  {(totalsByUser.get(u) ?? 0).toFixed(1)}h
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={barData} margin={{ top: 10, right: 16, bottom: 30, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              dataKey="user"
              tick={{ fontSize: 11 }}
              interval={0}
              angle={-15}
              textAnchor="end"
              height={60}
            />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip
              formatter={(value: number) => [`${value}h`, 'Hours']}
              contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0' }}
            />
            <Bar dataKey="hours" name="Hours" fill="#10b981" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function PieDonut({
  data,
  colorMap,
}: {
  data: { name: string; value: number }[]
  colorMap: Record<string, string>
}) {
  if (data.length === 0 || data.every((d) => d.value === 0)) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">No data available</div>
    )
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-[1fr_180px] gap-4 items-center">
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={55}
              outerRadius={90}
              paddingAngle={2}
            >
              {data.map((entry) => (
                <Cell
                  key={entry.name}
                  fill={colorMap[entry.name] ?? '#94a3b8'}
                  stroke="#fff"
                />
              ))}
            </Pie>
            <Tooltip
              formatter={(value: number, name: string) => [`${value}`, name]}
              contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0' }}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="space-y-1.5 text-sm">
        {data.map((d) => (
          <li key={d.name} className="flex items-center gap-2">
            <span
              className="inline-block h-3 w-3 rounded-sm"
              style={{ backgroundColor: colorMap[d.name] ?? '#94a3b8' }}
            />
            <span className="capitalize">{d.name.replace(/_/g, ' ')}</span>
            <span className="ml-auto font-medium tabular-nums">{d.value}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function BugsBarChart({ data }: { data: { status: string; count: number }[] }) {
  const chartData = data.map((d) => ({ status: d.status, count: d.count }))
  if (chartData.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">No bugs to display</div>
    )
  }
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} margin={{ top: 10, right: 16, bottom: 10, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis dataKey="status" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
          <Tooltip
            formatter={(value: number) => [`${value}`, 'Bugs']}
            contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0' }}
          />
          <Legend />
          <Bar dataKey="count" name="Bugs" radius={[4, 4, 0, 0]}>
            {chartData.map((entry) => (
              <Cell
                key={entry.status}
                fill={BUG_STATUS_HEX[entry.status] ?? '#94a3b8'}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
