'use client'

import { Badge } from '@/components/ui/badge'
import { priorityColor, severityColor } from '@/lib/format'
import type { Priority, Severity } from '@/types'

// Small badge renderers shared by the list/detail views, so the outline-badge
// markup stays identical everywhere. Color maps stay in src/lib/format.ts.

export function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <Badge variant="outline" className={`text-[10px] ${priorityColor(priority)}`}>
      {priority}
    </Badge>
  )
}

export function StatusBadge({ status, colorClass }: { status: string; colorClass: string }) {
  return (
    <Badge variant="outline" className={`text-[10px] capitalize ${colorClass}`}>
      {status.replace('_', ' ')}
    </Badge>
  )
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <Badge variant="outline" className={`text-[10px] capitalize ${severityColor(severity)}`}>
      {severity}
    </Badge>
  )
}
