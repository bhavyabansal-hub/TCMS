'use client'

import Link from 'next/link'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

/**
 * Shared fallback UI for a failed React Query data fetch.
 *
 * Every primary view query renders this instead of silently falling through
 * to an empty state — a network blip or server error must never look like
 * "no data". Includes a Retry button wired to the query's refetch so the
 * user can recover without leaving the page.
 */
export function QueryErrorAlert({
  title = 'Could not load data',
  message,
  onRetry,
  className,
}: {
  title?: string
  message?: string
  onRetry?: () => void
  className?: string
}) {
  return (
    <Alert variant="destructive" className={className} role="alert">
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0">
          <span className="font-medium">{title}</span>
          {message ? <span className="text-destructive/80"> — {message}</span> : null}
          <span className="block text-xs text-destructive/70">
            Check your connection and try again.
          </span>
        </span>
        {onRetry ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={onRetry}
          >
            Retry
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}

/**
 * Full-page fallback for a failed DETAIL fetch (404 gone / 403 no access /
 * network error) — replaces the previous behavior of rendering a skeleton
 * forever, which made deleted or forbidden records look like a frozen page.
 */
export function DetailLoadError({
  title = 'Not found or unavailable',
  message = 'This record may have been deleted, or you may not have access to it.',
  onRetry,
  backHref,
  backLabel = 'Go back',
}: {
  title?: string
  message?: string
  onRetry?: () => void
  backHref?: string
  backLabel?: string
}) {
  return (
    <div className="flex min-h-[50vh] items-center justify-center p-4">
      <div className="w-full max-w-md rounded-lg border bg-background p-8 text-center shadow-sm">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted text-2xl">
          🔍
        </div>
        <h2 className="mt-4 text-lg font-semibold">{title}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          {onRetry ? (
            <Button size="sm" variant="outline" onClick={onRetry}>
              Retry
            </Button>
          ) : null}
          {backHref ? (
            <Button size="sm" asChild>
              <Link href={backHref}>{backLabel}</Link>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
