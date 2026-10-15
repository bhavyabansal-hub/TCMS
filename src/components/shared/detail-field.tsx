import type { ReactNode } from 'react'

// Label + value row used in detail views (bug sheet, review detail, test-case detail).
export function DetailField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-xs font-semibold text-muted-foreground uppercase mb-1">{label}</div>
      <div className="text-sm whitespace-pre-wrap">{children}</div>
    </div>
  )
}

// Titled content card for the long-text blocks of a detail view (description,
// steps to reproduce, expected/actual behaviour) so every detail screen renders
// them with identical borders, padding and typography.
export function DetailSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed">{children}</div>
    </div>
  )
}
