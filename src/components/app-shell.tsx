'use client'

import { useState, useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { useAuthStore } from '@/store'
import { useNotificationSocket } from '@/hooks/use-notification-socket'
import { Sidebar } from '@/components/layout/sidebar'
import { Topbar } from '@/components/layout/topbar'

/**
 * Authenticated app layout: sidebar + topbar + footer around the ROUTED page
 * (each URL under (app) renders its own view — see src/lib/routes.ts).
 * Unauthenticated visitors are redirected to /login (route-level guard).
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, isInitialized, sessionError } = useAuthStore()
  const router = useRouter()
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  // Subscribe to real-time notifications
  useNotificationSocket()

  // Route-level auth guard: deep links to any page require a session.
  // (Providers' AuthGate already holds the spinner until the session check
  // finishes, so this only fires for genuinely signed-out visitors.
  // sessionError means the check could not RUN — the fallback card is shown
  // instead and redirecting to /login here would look like a logout.)
  // The current path rides along as ?next= so after signing in the user
  // lands back on the page they wanted, not dumped on the dashboard.
  useEffect(() => {
    if (isInitialized && !user && !sessionError) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`)
    }
  }, [isInitialized, user, sessionError, router, pathname])

  // SPEED: prefetch every main tab's route payload once the session is up.
  // All pages are thin client wrappers, so the payloads are tiny — warming
  // them removes the router round trip from the FIRST click on each tab
  // (programmatic navigate() calls bypass <Link> hover-prefetch, so this
  // is the only guarantee every tab switch starts instantly).
  useEffect(() => {
    if (!user) return
    const mainRoutes = [
      '/dashboard',
      '/modules',
      '/test-cases',
      '/wiki',
      '/reviews',
      '/bugs',
      '/tasks',
      '/reports',
      '/integrations',
      '/activity-log',
      '/notifications',
      '/settings/profile',
    ]
    for (const route of mainRoutes) router.prefetch(route)
  }, [user, router])

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="min-h-screen flex bg-background">
      {/* Desktop sidebar */}
      <div className="hidden md:flex">
        <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} />
      </div>

      {/* Mobile sidebar drawer */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <div className="relative z-10">
            <Sidebar collapsed={false} onToggle={() => setMobileOpen(false)} />
          </div>
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0 min-h-screen">
        <Topbar onMenuClick={() => setMobileOpen(true)} />
        {/* Keyed by pathname: every navigation mounts the view with a short
            fade — makes page switches feel instant and intentional instead
            of a hard content swap. */}
        <main key={pathname} className="flex-1 p-4 md:p-6 animate-in fade-in duration-150">
          {children}
        </main>
        <footer className="mt-auto border-t bg-background px-4 py-3 text-xs text-muted-foreground text-center">
          TCMS — Test Case Management System · Built for QA teams · {new Date().getFullYear()}
          {/* Build stamp: lets anyone verify the browser is running THIS
              deployment (changes on every commit) — stale caches are
              instantly recognizable instead of invisible. */}
          <span className="ml-2 font-mono text-[10px] opacity-70" data-testid="build-id">
            build {process.env.NEXT_PUBLIC_BUILD_ID ?? 'dev'}
          </span>
        </footer>
      </div>
    </div>
  )
}
