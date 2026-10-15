'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTheme } from 'next-themes'
import { Bell, Check, LogOut, Menu, Moon, Search, Sun, User as UserIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAuthStore, useNotificationsStore, useViewStore } from '@/store'
import { notificationsApi } from '@/lib/client/api'
import { GlobalSearchDialog } from '@/components/shared/global-search'
import { toast } from 'sonner'
import { timeAgo } from '@/lib/format'

/** Client-only value with a server fallback (hydration-safe, lint-clean). */
function useClientValue<T>(client: () => T, server: T): T {
  return useSyncExternalStore(
    () => () => {},
    client,
    () => server
  )
}

export function Topbar({ onMenuClick }: { onMenuClick: () => void }) {
  const { user, logout } = useAuthStore()
  const navigate = useViewStore((s) => s.navigate)
  const { items, unreadCount, markAllRead, markRead } = useNotificationsStore()
  const qc = useQueryClient()
  const [bellOpen, setBellOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  // "⌘K" on Apple keyboards, "Ctrl K" elsewhere — read from the client
  // environment via useSyncExternalStore so SSR markup stays stable.
  const isMac = useClientValue(() => navigator.platform.toLowerCase().includes('mac'), false)

  // GLOBAL SHORTCUT: Ctrl/Cmd+K opens search from anywhere in the app.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Dark-mode toggle state. next-themes resolves the theme on the client
  // only — useClientValue keeps the first paint theme-neutral (moon icon).
  const { resolvedTheme, setTheme } = useTheme()
  const themeMounted = useClientValue(() => true, false)
  const isDark = themeMounted && resolvedTheme === 'dark'

  async function handleMarkAllRead() {
    try {
      await notificationsApi.readAll()
      markAllRead()
      qc.invalidateQueries({ queryKey: ['notifications'] })
    } catch {
      toast.error('Failed to mark all as read')
    }
  }

  async function handleLogout() {
    await logout()
    toast.success('Signed out')
  }

  function initials(name: string) {
    return name
      .split(' ')
      .map((n) => n[0])
      .slice(0, 2)
      .join('')
      .toUpperCase()
  }

  return (
    <header className="h-16 border-b bg-background flex items-center justify-between px-4 gap-4">
      <div className="flex items-center gap-3 min-w-0">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={onMenuClick}>
          <Menu className="h-5 w-5" />
        </Button>
        {/* Global search trigger — also reachable via Ctrl/Cmd+K anywhere. */}
        <button
          onClick={() => setSearchOpen(true)}
          aria-label="Open global search"
          className="hidden sm:flex h-9 w-full max-w-xs items-center gap-2 rounded-md border bg-muted/40 px-3 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          <Search className="h-4 w-4 shrink-0" />
          <span className="flex-1 text-left truncate">Search…</span>
          <kbd className="h-5 items-center hidden md:inline-flex rounded border bg-background px-1.5 text-[10px] font-medium">
            {isMac ? '⌘K' : 'Ctrl K'}
          </kbd>
        </button>
        {/* Compact icon for small screens where the styled box does not fit. */}
        <Button
          variant="ghost"
          size="icon"
          className="sm:hidden"
          aria-label="Search"
          onClick={() => setSearchOpen(true)}
        >
          <Search className="h-5 w-5" />
        </Button>
      </div>

      <div className="flex items-center gap-2">
        {/* Dark-mode toggle — additive; default stays light like today. */}
        <Button
          variant="ghost"
          size="icon"
          aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          onClick={() => setTheme(isDark ? 'light' : 'dark')}
        >
          {isDark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
        </Button>

        {/* Notification bell */}
        <Popover open={bellOpen} onOpenChange={setBellOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
              <Bell className="h-5 w-5" />
              {unreadCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 h-4 min-w-4 px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-0" align="end">
            <div className="flex items-center justify-between p-3 border-b">
              <span className="font-semibold text-sm">Notifications</span>
              <div className="flex items-center gap-2">
                {unreadCount > 0 && (
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={handleMarkAllRead}>
                    <Check className="h-3 w-3 mr-1" /> Mark all read
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => {
                    setBellOpen(false)
                    navigate('notifications')
                  }}
                >
                  View all
                </Button>
              </div>
            </div>
            <ScrollArea className="h-80">
              {items.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">No notifications yet</div>
              ) : (
                <ul className="divide-y">
                  {items.slice(0, 10).map((n) => (
                    <li key={n.notificationId}>
                      <button
                        className={cn(
                          'w-full text-left p-3 hover:bg-accent transition flex gap-3',
                          !n.isRead && 'bg-emerald-50/50 dark:bg-emerald-950/20'
                        )}
                        onClick={async () => {
                          if (!n.isRead) {
                            try {
                              await notificationsApi.read(n.notificationId)
                              markRead(n.notificationId)
                            } catch {
                              /* ignore */
                            }
                          }
                          // Deep-link to the exact entity the notification is
                          // about (entityId is the entity's own id); fall
                          // back to the list page when it is missing.
                          if (n.entityType === 'review') {
                            navigate(n.entityId ? 'review-detail' : 'reviews', n.entityId ? { id: n.entityId } : undefined)
                          } else if (n.entityType === 'module_review') {
                            navigate(n.entityId ? 'module-review-detail' : 'reviews', n.entityId ? { id: n.entityId } : undefined)
                          } else if (n.entityType === 'test_case') {
                            navigate(n.entityId ? 'test-case-detail' : 'test-cases', n.entityId ? { id: n.entityId } : undefined)
                          } else if (n.entityType === 'bug') {
                            navigate('bugs')
                          }
                          setBellOpen(false)
                        }}
                      >
                        <span
                          className={cn(
                            'h-2 w-2 rounded-full mt-1.5 shrink-0',
                            n.isRead ? 'bg-transparent' : 'bg-emerald-500'
                          )}
                        />
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm font-medium truncate">{n.title}</span>
                          {n.body && (
                            <span className="block text-xs text-muted-foreground line-clamp-2">{n.body}</span>
                          )}
                          <span className="block text-[10px] text-muted-foreground mt-0.5">{timeAgo(n.createdAt)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </ScrollArea>
          </PopoverContent>
        </Popover>

        {/* User menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="gap-2 h-10 px-2">
              <Avatar className="h-7 w-7">
                {user?.avatarUrl && <AvatarImage src={user.avatarUrl} alt={user.fullName} />}
                <AvatarFallback className="bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300 text-xs">
                  {user ? initials(user.fullName) : '?'}
                </AvatarFallback>
              </Avatar>
              <span className="hidden md:inline text-sm font-medium">{user?.fullName}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <div className="px-2 py-1.5">
              <div className="text-sm font-medium">{user?.fullName}</div>
              <div className="text-xs text-muted-foreground truncate">{user?.email}</div>
              {user && (
                <Badge variant="outline" className="mt-1.5 capitalize text-[10px]">
                  {user.role.replace('_', ' ')}
                </Badge>
              )}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => navigate('settings-profile')}>
              <UserIcon className="h-4 w-4 mr-2" /> Profile
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleLogout} className="text-rose-600 focus:text-rose-700">
              <LogOut className="h-4 w-4 mr-2" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Global search palette (Ctrl/Cmd+K) */}
      <GlobalSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
    </header>
  )
}
