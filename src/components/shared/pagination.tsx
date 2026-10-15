'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'

// Shared pagination control. Use instead of repeating Prev/Next in every list view.
export function Pagination({
  page,
  totalPages,
  total,
  onPageChange,
}: {
  page: number
  totalPages: number
  total: number
  onPageChange: (page: number) => void
}) {
  if (totalPages <= 1) return null
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-muted-foreground">
        Page {page} of {totalPages} · {total} total
      </span>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page === 1}
        >
          Previous
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          disabled={page === totalPages}
        >
          Next
        </Button>
      </div>
    </div>
  )
}

// Footer-style pagination ("{total} {unit} · page X of Y" + Prev/Next icon
// buttons) used by the table views that always render the counter row.
export function PaginationFooter({
  page,
  totalPages,
  total,
  singular,
  plural,
  isFetching,
  onPageChange,
}: {
  page: number
  totalPages: number
  total: number
  singular: string
  plural: string
  isFetching?: boolean
  onPageChange: (page: number) => void
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-muted-foreground">
        {total} {total === 1 ? singular : plural} · page {page} of {Math.max(1, totalPages)}
      </span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1 || isFetching}
          onClick={() => onPageChange(Math.max(1, page - 1))}
        >
          <ChevronLeft className="h-4 w-4" /> Prev
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages || isFetching}
          onClick={() => onPageChange(page + 1)}
        >
          Next <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
