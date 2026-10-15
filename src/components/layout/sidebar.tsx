'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import {
  Bug,
  LayoutDashboard,
  FolderTree,
  ListChecks,
  Link2,
  ClipboardCheck,
  KanbanSquare,
  CalendarDays,
  BarChart3,
  History,
  Bell,
  Settings,
  Users,
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
  BookOpen,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useViewStore, type ViewKey, useAuthStore } from '@/store'
import { sectionOf, pathForView } from '@/lib/routes'
import type { PermissionAction } from '@/types'
import { reviewsApi, moduleReviewsApi } from '@/lib/client/api'
import { useQuery } from '@tanstack/react-query'
import { roleColor } from '@/lib/format'

interface NavItem {
  key: ViewKey
  label: string
  icon: typeof LayoutDashboard
  /** Shown only when the user holds this permission (server-synced matrix). */
  perm?: PermissionAction
  /** Any-of alternative: shown when the user holds at least one of these. */
  anyPerm?: PermissionAction[]
}

const NAV_ITEMS: NavItem[] = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'modules', label: 'Modules', icon: FolderTree },
  { key: 'test-cases', label: 'Test Cases', icon: ListChecks },
  { key: 'wiki', label: 'Wiki', icon: BookOpen },
  { key: 'reviews', label: 'Reviews', icon: ClipboardCheck, perm: 'perform_review' },
  { key: 'integrations', label: 'Integrations', icon: Link2, perm: 'manage_integrations' },
  { key: 'bugs', label: 'Bugs', icon: Bug },
  { key: 'tasks', label: 'Tasks', icon: CalendarDays },
  { key: 'reports', label: 'Reports', icon: BarChart3, perm: 'view_all_task_reports' },
  { key: 'activity-log', label: 'Activity Log', icon: History, perm: 'view_activity_logs' },
  { key: 'notifications', label: 'Notifications', icon: Bell },
  { key: 'settings-users', label: 'Users', icon: Users, perm: 'manage_users' },
  { key: 'settings-permissions', label: 'Permissions', icon: ShieldCheck, perm: 'manage_permissions' },
  { key: 'settings-profile', label: 'Profile', icon: Settings },
]

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const user = useAuthStore((s) => s.user)
  const current = useViewStore((s) => s.current)
  const navigate = useViewStore((s) => s.navigate)

  const can = useAuthStore((s) => s.can)
  const canAny = useAuthStore((s) => s.canAny)
  const items = useMemo(
    () => NAV_ITEMS.filter((i) => (!i.perm || can(i.perm)) && (!i.anyPerm || canAny(i.anyPerm))),
    [can, canAny]
  )

  // Load management: the queue badges only matter for users who can see the
  // Reviews entry — the Reviews tab is strictly perform_review-only (matching
  // the API gate), so only reviewers poll (2 req/30s saved per idle tab).
  const participatesInReviews = !!user && can('perform_review')
  const { data: queue } = useQuery({
    queryKey: ['reviews', 'queue'],
    queryFn: reviewsApi.queue,
    enabled: participatesInReviews,
    refetchInterval: participatesInReviews ? 30_000 : false,
  })
  const { data: moduleQueue } = useQuery({
    queryKey: ['module-reviews', 'queue'],
    queryFn: moduleReviewsApi.queue,
    enabled: participatesInReviews,
    refetchInterval: participatesInReviews ? 30_000 : false,
  })
  // Count single-case reviews (excluding those that belong to a module review)
  // plus pending module reviews.
  const pendingCount =
    (queue?.filter((r) => !r.moduleReviewId).length ?? 0) +
    (moduleQueue?.length ?? 0)


  return (
    <aside
      className={cn(
        'flex flex-col border-r bg-sidebar text-sidebar-foreground transition-[width] duration-200',
        collapsed ? 'w-[68px]' : 'w-64'
      )}
    >
      <div className="h-16 flex items-center justify-between border-b px-4">
        <div className="flex items-center gap-2 overflow-hidden">
          <div className="h-8 w-8 shrink-0 rounded-md bg-emerald-500 flex items-center justify-center">
            <Bug className="h-4 w-4 text-white" />
          </div>
          {!collapsed && <span className="font-bold text-lg">TCMS</span>}
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onToggle} aria-label="Toggle sidebar">
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </Button>
      </div>

      <nav className="flex-1 overflow-y-auto p-2 space-y-1 max-h-[calc(100vh-13rem)]">
        {items.map((item) => {
          const Icon = item.icon
          const isActive = sectionOf(current) === item.key
          const href = pathForView(item.key)
          return (
            // Real <Link> so Next prefetches the route (hover / viewport):
            // clicking a section swaps content without waiting for a fresh
            // RSC round-trip. navigate() still runs for the optimistic
            // sidebar highlight; both target the same URL.
            <Link
              key={item.key}
              href={href}
              prefetch
              onClick={() => navigate(item.key)}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition relative',
                isActive
                  ? 'bg-sidebar-primary text-sidebar-primary-foreground'
                  : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                collapsed && 'justify-center'
              )}
              title={collapsed ? item.label : undefined}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {!collapsed && <span className="flex-1 text-left truncate">{item.label}</span>}
              {!collapsed && item.key === 'reviews' && pendingCount > 0 && (
                <Badge variant="secondary" className="ml-auto h-5 min-w-5 px-1.5 text-xs">
                  {pendingCount}
                </Badge>
              )}
              {collapsed && item.key === 'reviews' && pendingCount > 0 && (
                <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-rose-500" />
              )}
            </Link>
          )
        })}
      </nav>

      {!collapsed && user && (
        <div className="border-t p-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5" />
            <span>Role:</span>
            <Badge variant="outline" className={cn('capitalize', roleColor(user.role))}>
              {user.role.replace('_', ' ')}
            </Badge>
          </div>
        </div>
      )}
    </aside>
  )
}
