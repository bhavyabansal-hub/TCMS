'use client'

import { QueryCache, QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { useState, useEffect, useRef, type ReactNode } from 'react'
import { ThemeProvider } from 'next-themes'
import { useAuthStore } from '@/store'
import { getStoredUser, hasSessionHint, statsApi } from '@/lib/client/api'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

function QueryInit({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => {
      // Mutable box so the cache's onError can reach the client instance that
      // is still being constructed (onError only fires after construction).
      let instance: QueryClient | null = null
      const created = new QueryClient({
        // CACHE HYGIENE (owner requirement): when a query FINALLY fails (all
        // retries spent), drop every INACTIVE cached copy of it so stale data
        // can never linger under a failed page. The active copy keeps
        // rendering the error UI; its next mount refetches fresh.
        queryCache: new QueryCache({
          onError: (_error, query) => {
            instance?.removeQueries({ queryKey: query.queryKey, type: 'inactive' })
          },
        }),
        defaultOptions: {
          queries: {
            // SPEED CONTRACT (owner requirement 2026-10-09): tab switches must
            // be INSTANT. Two levers:
            //  - staleTime 60s: flipping between tabs inside a minute never
            //    hits the network at all (mutations invalidate explicitly,
            //    so freshness after YOUR OWN actions is guaranteed anyway).
            //  - gcTime 30min: cached tab data survives half an hour of
            //    inactivity, so returning to any tab paints its cached rows
            //    immediately and only refreshes in the background.
            staleTime: 60_000,
            gcTime: 30 * 60_000,
            // LOAD RETRY POLICY (owner requirement: "at least 7 attempts"):
            // every failed load is attempted up to 7 times with exponential
            // backoff (~12s worst case) before the error UI shows.
            retry: (failureCount, error) => {
              // Deterministic client errors are NEVER retried — 401 is the
              // session-refresh flow in request(), 403/404 answers cannot
              // change by trying again. Everything else (network down, 408,
              // 429, 5xx) retries up to the 7-attempt budget.
              const status = (error as { status?: number })?.status
              if (status && status < 500 && status !== 408 && status !== 429) return false
              return failureCount < 7
            },
            retryDelay: (attempt) => Math.min(300 * 2 ** attempt, 3_000),
            refetchOnWindowFocus: false,
          },
        },
      })
      instance = created
      return created
    }
  )
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

function AuthGate({ children }: { children: ReactNode }) {
  const { user, isInitialized, sessionError, initialize, retrySession } = useAuthStore()
  const queryClient = useQueryClient()
  const [booted, setBooted] = useState(false)
  // Cross-account safety: when the signed-in user changes (logout -> login as
  // a different role, no page reload), drop the whole React Query cache so one
  // user's server data can never flash into the next user's session.
  // Runs DURING RENDER — before children (re)mount — so it can never race a
  // child query's mount the way an effect-order wipe did (child queries fired,
  // then a parent clear() orphaned them mid-flight, leaving skeletons forever).
  // (Owner report 2026-10-09: a product login still saw the previous account's
  // reviews — stale client cache, the SERVER was correctly scoped all along.)
  // Only a change AWAY from a real user (logout, or another account) clears:
  // the boot transition null -> user must keep the boot prefetch, otherwise
  // every page fetched its data twice (page-API audit 2026-10-17).
  const lastUserIdRef = useRef<string | null>(null)
  if (lastUserIdRef.current !== (user?.userId ?? null)) {
    if (lastUserIdRef.current !== null) queryClient.clear()
    lastUserIdRef.current = user?.userId ?? null
  }

  // MULTI-TAB GUARD: the cache wipe above only covers THIS tab. A second tab
  // signed in as someone else (cookies are browser-wide) would keep rendering
  // the previous account's data — refetchOnWindowFocus is off, so the stale
  // rows never self-correct. Watch the shared localStorage profile on focus /
  // visibility / interval; on mismatch the tab reloads into the real session.
  useEffect(() => {
    if (!user) return
    const checkProfileMatch = () => {
      const stored = getStoredUser()
      if (stored && stored.userId !== user.userId) window.location.reload()
    }
    checkProfileMatch()
    window.addEventListener('focus', checkProfileMatch)
    document.addEventListener('visibilitychange', checkProfileMatch)
    const timer = window.setInterval(checkProfileMatch, 15_000)
    return () => {
      window.removeEventListener('focus', checkProfileMatch)
      document.removeEventListener('visibilitychange', checkProfileMatch)
      window.clearInterval(timer)
    }
  }, [user])

  useEffect(() => {
    // Warm the dashboard stats in parallel with the session check, ONLY when
    // the dashboard is the page being opened (the query key matches
    // DashboardViewV2's). Other pages fetch their own data on mount — a boot
    // prefetch there would load data the page does not show.
    // Session hint = the local display profile exists; a stale hint is
    // harmless because a failed prefetch is swallowed.
    const path = window.location.pathname
    if (hasSessionHint() && (path === '/' || path === '/dashboard')) {
      queryClient.prefetchQuery({
        queryKey: ['stats', 'dashboard'],
        queryFn: statsApi.dashboard,
        staleTime: 30_000,
      })
    }
    initialize().finally(() => setBooted(true))
    // Runs once on mount — session bootstrap + one-time cache warm.
  }, [])

  if (!booted || !isInitialized) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  // FALLBACK: the session check failed for transient reasons (server
  // unreachable). The stored tokens are INTENTIONALLY kept — show a retry
  // card instead of bouncing the user to /login, which would look exactly
  // like "I got logged out".
  if (sessionError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md text-center">
          <CardContent className="p-8">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-500/15 text-2xl">
              ⚠️
            </div>
            <h2 className="mt-4 text-lg font-semibold">Can&apos;t reach the server</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              We couldn&apos;t verify your session just now — you are still
              signed in. Check your connection and try again; your data is safe.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <Button onClick={() => void retrySession()}>Try again</Button>
              <Button variant="outline" onClick={() => window.location.reload()}>
                Reload page
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return <>{children}</>
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    // Class-based theming (globals.css ships a full .dark palette). Default
    // stays LIGHT so every existing screen looks exactly as before — dark
    // mode only activates when the user flips the topbar toggle, persisted
    // in localStorage by next-themes.
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} disableTransitionOnChange>
      <QueryInit>
        <AuthGate>{children}</AuthGate>
      </QueryInit>
    </ThemeProvider>
  )
}
