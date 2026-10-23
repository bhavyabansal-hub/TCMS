'use client'

// Change Reviewer dialog — pick any active TCMS user except the current
// reviewer. Your own name carries a "(me)" marker: choosing it takes over the
// review (owner rule — self-takeover is how a request gets assigned to you).
// Shared by the case-review detail and the module-review detail screens.

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { usersApi, REFERENCE_STALE_TIME_MS } from '@/lib/client/api'
import { useAuthStore } from '@/store'

export function ChangeReviewerDialog({
  currentReviewerId,
  title = 'Change Reviewer',
  description = 'Hand this review to any TCMS user — they will be notified and it lands in their queue. Choose yourself to take over the review; only the assigned reviewer can submit the verdict.',
  onOpenChange,
  onSubmit,
}: {
  currentReviewerId: string
  title?: string
  description?: string
  onOpenChange: (v: boolean) => void
  onSubmit: (reviewerId: string) => Promise<void>
}) {
  const [target, setTarget] = useState('')
  const [saving, setSaving] = useState(false)
  const meId = useAuthStore((s) => s.user?.userId ?? null)
  const optionsQuery = useQuery({
    queryKey: ['users', 'options'],
    queryFn: usersApi.options,
    staleTime: REFERENCE_STALE_TIME_MS,
  })
  const options = (optionsQuery.data ?? []).filter((u) => u.userId !== currentReviewerId)

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="cr-reviewer">New reviewer</Label>
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger id="cr-reviewer">
              <SelectValue placeholder={optionsQuery.isLoading ? 'Loading users…' : 'Choose a user'} />
            </SelectTrigger>
            <SelectContent>
              {options.map((u) => (
                <SelectItem key={u.userId} value={u.userId}>
                  {u.fullName}{u.userId === meId ? ' (me)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={async () => { setSaving(true); try { await onSubmit(target) } finally { setSaving(false) } }}
            disabled={!target || saving}
          >
            {saving ? 'Assigning…' : 'Assign reviewer'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
