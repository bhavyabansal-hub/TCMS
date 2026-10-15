'use client'

import { useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Bell,
  Bug,
  CalendarCheck,
  CheckCheck,
  ClipboardCheck,
  FileEdit,
  FolderTree,
  MessageSquare,
  X,
} from 'lucide-react'

import { notificationsApi } from '@/lib/client/api'
import { useNotificationsStore, useViewStore, type ViewKey } from '@/store'
import type { Notification, NotificationType } from '@/types'
import { timeAgo } from '@/lib/format'
import { navigateForEntity } from '@/lib/navigation'
import { handleApiError } from '@/lib/errors'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

function iconForType(type: NotificationType) {
  switch (type) {
    case 'review_assigned':
    case 'review_approved':
    case 'review_failed':
    case 'review_needs_revision':
      return ClipboardCheck
    case 'bug_assigned':
      return Bug
    case 'test_case_updated':
      return FileEdit
    case 'module_created':
      return FolderTree
    case 'comment_added':
      return MessageSquare
    case 'daily_report_submitted':
      return CalendarCheck
    case 'daily_summary':
    default:
      return Bell
  }
}

function iconColorForType(type: NotificationType): string {
  switch (type) {
    case 'review_approved':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
    case 'review_failed':
      return 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300'
    case 'review_assigned':
    case 'review_needs_revision':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'
    case 'bug_assigned':
      return 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300'
    case 'test_case_updated':
      return 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300'
    case 'module_created':
      return 'bg-purple-100 text-purple-700 dark:bg-purple-500/15 dark:text-purple-300'
    case 'comment_added':
      return 'bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300'
    case 'daily_report_submitted':
      return 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300'
    default:
      return 'bg-slate-100 text-slate-700 dark:bg-slate-400/15 dark:text-slate-300'
  }
}

export function NotificationsView() {
  const navigate = useViewStore((s) => s.navigate)
  const { items, unreadCount, markAllRead, markRead, remove } = useNotificationsStore()
  const qc = useQueryClient()

  const sorted = useMemo(
    () =>
      [...items].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      ),
    [items]
  )

  async function handleMarkAllRead() {
    try {
      await notificationsApi.readAll()
      markAllRead()
      qc.invalidateQueries({ queryKey: ['notifications'] })
      toast.success('All notifications marked as read')
    } catch (err) {
      handleApiError(err, 'Failed to mark all as read')
    }
  }

  async function handleClick(n: Notification) {
    if (!n.isRead) {
      try {
        await notificationsApi.read(n.notificationId)
        markRead(n.notificationId)
      } catch {
        /* ignore */
      }
    }
    navigateForEntity(n.entityType, n.entityId, navigate)
  }

  async function handleDelete(e: React.MouseEvent, n: Notification) {
    e.stopPropagation()
    try {
      await notificationsApi.delete(n.notificationId)
      remove(n.notificationId)
      qc.invalidateQueries({ queryKey: ['notifications'] })
      toast.success('Notification deleted')
    } catch (err) {
      handleApiError(err, 'Failed to delete notification')
    }
  }

  return (
    <div className="space-y-4 max-w-3xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {unreadCount > 0
              ? `You have ${unreadCount} unread ${unreadCount === 1 ? 'notification' : 'notifications'}.`
              : "You're all caught up."}
          </p>
        </div>
        {unreadCount > 0 && (
          <Button variant="outline" size="sm" onClick={handleMarkAllRead}>
            <CheckCheck className="h-4 w-4" /> Mark all read
          </Button>
        )}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">All notifications</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {sorted.length === 0 ? (
            <div className="py-16 flex flex-col items-center gap-3 text-center">
              <div className="h-12 w-12 rounded-full bg-emerald-100 dark:bg-emerald-500/15 flex items-center justify-center">
                <CheckCheck className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div>
                <div className="font-medium">You&apos;re all caught up</div>
                <div className="text-sm text-muted-foreground">
                  New notifications will appear here in real time.
                </div>
              </div>
            </div>
          ) : (
            <ul className="divide-y">
              {sorted.map((n) => {
                const Icon = iconForType(n.type)
                const iconColor = iconColorForType(n.type)
                return (
                  <li key={n.notificationId}>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => handleClick(n)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          handleClick(n)
                        }
                      }}
                      className={cn(
                        'group w-full flex gap-3 p-3 hover:bg-accent transition cursor-pointer',
                        !n.isRead && 'bg-emerald-50/60 dark:bg-emerald-950/20'
                      )}
                    >
                      <div
                        className={cn(
                          'h-9 w-9 shrink-0 rounded-full flex items-center justify-center',
                          iconColor
                        )}
                      >
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium leading-tight">
                              {n.title}
                            </div>
                            {n.body && (
                              <div className="text-sm text-muted-foreground mt-0.5 line-clamp-2">
                                {n.body}
                              </div>
                            )}
                            <div className="text-[11px] text-muted-foreground mt-1">
                              {timeAgo(n.createdAt)}
                            </div>
                          </div>
                          {!n.isRead && (
                            <span
                              className="h-2 w-2 rounded-full bg-emerald-500 mt-1.5 shrink-0"
                              aria-label="Unread"
                            />
                          )}
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-rose-600 shrink-0"
                            onClick={(e) => handleDelete(e, n)}
                            aria-label="Delete notification"
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground text-center">
        Click any notification to jump to the related item.
      </p>
    </div>
  )
}
