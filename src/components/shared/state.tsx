'use client'

import { AlertTriangle, Inbox, Loader2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

// ---------- Loading ----------
// Use <StateLoading /> instead of repeating skeleton grids in every view.
export function StateLoading({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-10" />
      ))}
    </div>
  )
}

export function StateLoadingCards({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="h-32" />
      ))}
    </div>
  )
}

export function StateSpinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center py-12 text-muted-foreground">
      <Loader2 className="h-6 w-6 animate-spin mr-2" />
      {label ?? 'Loading…'}
    </div>
  )
}

// ---------- Empty ----------
// Use <StateEmpty /> for any "no data" state.
export function StateEmpty({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode
  title?: string
  description?: string
  action?: ReactNode
  className?: string
}) {
  return (
    <Card className={className}>
      <CardContent className="py-16 text-center text-muted-foreground">
        <div className="flex justify-center mb-3 opacity-50">
          {icon ?? <Inbox className="h-10 w-10" />}
        </div>
        <div className="font-medium text-foreground">{title ?? 'Nothing here yet'}</div>
        {description && <div className="text-sm mt-1">{description}</div>}
        {action && <div className="mt-4">{action}</div>}
      </CardContent>
    </Card>
  )
}

// Bare "no data" block (small icon + message) used inside cards/tables, e.g.
// <EmptyState icon={Filter} message="No test cases match your filters" />
export function EmptyState({ icon: Icon, message }: { icon?: LucideIcon; message: string }) {
  return (
    <div className="py-16 text-center text-muted-foreground">
      {Icon && <Icon className="h-8 w-8 mx-auto mb-2 opacity-50" />}
      {message}
    </div>
  )
}

// ---------- Error ----------
// Use <StateError /> for failed data fetches.
export function StateError({
  message,
  onRetry,
  className,
}: {
  message?: string
  onRetry?: () => void
  className?: string
}) {
  return (
    <Card className={className}>
      <CardContent className="py-12 text-center text-muted-foreground">
        <AlertTriangle className="h-8 w-8 mx-auto mb-2 text-amber-500" />
        <div className="text-sm">{message ?? 'Failed to load data.'}</div>
        {onRetry && (
          <button
            onClick={onRetry}
            className="mt-3 text-sm text-primary underline hover:no-underline"
          >
            Try again
          </button>
        )}
      </CardContent>
    </Card>
  )
}
