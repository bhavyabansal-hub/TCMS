'use client'

import { ShieldAlert } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

// Single shared "you can't open this view" screen, used by every view-level
// permission gate. The backend remains the authoritative gatekeeper — this is
// the consistent second layer, so all views deny access with the same look
// and wording structure instead of six hand-rolled Alert variants.
export function PermissionDenied({
  title = 'Access restricted',
  description,
}: {
  /** Short headline; defaults to the generic restricted-access title. */
  title?: string
  /** Why access was denied / which right unlocks the view. */
  description: string
}) {
  return (
    <Alert variant="destructive">
      <ShieldAlert className="h-4 w-4" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
    </Alert>
  )
}
