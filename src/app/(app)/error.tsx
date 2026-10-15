'use client'

/**
 * Segment-level error boundary for the authenticated (app) route group.
 *
 * Catches render errors inside the app shell (any page under the sidebar
 * layout) so a single broken view can never take the whole application down
 * with the generic "client-side exception" screen. The shell itself keeps
 * rendering, and the user gets a friendly recovery card with Try again /
 * Reload + a link back to the dashboard.
 */

import { useEffect } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[app-error]', error)
  }, [error])

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-4">
      <Card className="w-full max-w-md text-center">
        <CardContent className="p-8">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-2xl">
            ⚠️
          </div>
          <h2 className="mt-4 text-lg font-semibold">Something went wrong</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            This page failed to render. Try again — if the problem persists,
            reload the page or head back to the dashboard. Your data is safe.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <Button onClick={() => reset()}>Try again</Button>
            <Button variant="outline" onClick={() => window.location.reload()}>
              Reload page
            </Button>
            <Button variant="ghost" asChild>
              <Link href="/dashboard">Go to dashboard</Link>
            </Button>
          </div>
          {error?.digest ? (
            <p className="mt-6 font-mono text-xs text-muted-foreground/70">
              Error ID: {error.digest}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
