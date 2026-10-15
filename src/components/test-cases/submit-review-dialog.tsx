'use client'

// SubmitReviewDialog — pick a reviewer (optional) and start a review cycle.
// Extracted from the detail view so each file stays single-responsibility.

import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { testCasesApi } from '@/lib/client/api'
import { handleApiError } from '@/lib/errors'
import type { TestCase, UserOption } from '@/types'

// ---------- Submit Review Dialog ----------
export function SubmitReviewDialog({
  open,
  onOpenChange,
  tc,
  options,
  onSubmitted,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  tc: TestCase
  options: UserOption[]
  onSubmitted: () => void
}) {
  const [reviewerId, setReviewerId] = useState(tc.assigneeId ?? '')
  const [dueDate, setDueDate] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit() {
    setSaving(true)
    try {
      await testCasesApi.submitReview(tc.testCaseId, {
        reviewerId: reviewerId || undefined,
        dueDate: dueDate || undefined,
      })
      toast.success('Submitted for review')
      onSubmitted()
      onOpenChange(false)
    } catch (err) {
      handleApiError(err, 'Failed to submit')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Submit for Review</DialogTitle>
          <DialogDescription>
            Choose a reviewer. If left blank, the assigned reviewer or first available team lead will be used.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="sr-reviewer">Reviewer</Label>
            <Select value={reviewerId} onValueChange={setReviewerId}>
              <SelectTrigger id="sr-reviewer"><SelectValue placeholder="Auto-assign" /></SelectTrigger>
              <SelectContent>
                {/* Matrix-driven: only perform_review holders are selectable. */}
                {options.filter((u) => u.canPerformReview).map((u) => (
                  <SelectItem key={u.userId} value={u.userId}>{u.fullName} ({u.role.replace('_', ' ')})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sr-due">Due date (optional)</Label>
            <Input id="sr-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving ? 'Submitting...' : 'Submit for Review'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
