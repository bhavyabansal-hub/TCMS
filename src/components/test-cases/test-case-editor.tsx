'use client'

// TestCaseEditor — focused edit form for one test case (fields only; the
// legacy steps feature has been removed from the product entirely).

import { useState } from 'react'
import { Save, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { testCasesApi } from '@/lib/client/api'
import { handleApiError } from '@/lib/errors'
import { PRIORITIES } from '@/types'
import type { Module, Priority, TestCase, UserOption } from '@/types'

// ---------- Editor ----------
export function TestCaseEditor({
  tc,
  modules,
  options,
  onCancel,
  onSaved,
}: {
  tc: TestCase
  modules: Module[]
  options: UserOption[]
  onCancel: () => void
  onSaved: () => void
}) {
  const [title, setTitle] = useState(tc.title)
  const [moduleId, setModuleId] = useState(tc.moduleId ?? '')
  const [priority, setPriority] = useState<Priority>(tc.priority)
  const [description, setDescription] = useState(tc.description ?? '')
  const [preconditions, setPreconditions] = useState(tc.preconditions ?? '')
  const [expectedResult, setExpectedResult] = useState(tc.expectedResult ?? '')
  const [tags, setTags] = useState(tc.tags.join(', '))
  const [assigneeId, setAssigneeId] = useState(tc.assigneeId ?? '')
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    // Same required trio as the create dialog: title, module, description.
    if (!title.trim()) {
      toast.error('Title is required')
      return
    }
    if (!moduleId) {
      toast.error('Module is required — choose where this test case belongs')
      return
    }
    if (!description.trim()) {
      toast.error('Description is required — describe what this test case verifies')
      return
    }
    setSaving(true)
    try {
      await testCasesApi.update(tc.testCaseId, {
        title: title.trim(),
        moduleId,
        priority,
        description: description.trim(),
        preconditions: preconditions.trim() || undefined,
        expectedResult: expectedResult.trim() || undefined,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        assigneeId: assigneeId || null,
      })
      toast.success('Test case updated')
      onSaved()
    } catch (err) {
      handleApiError(err, 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base">Edit Test Case</CardTitle>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onCancel}><X className="h-3.5 w-3.5 mr-1" /> Cancel</Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : <><Save className="h-3.5 w-3.5 mr-1" /> Save</>}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="e-title">Title *</Label>
          <Input id="e-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="e-module">Module *</Label>
            <Select value={moduleId} onValueChange={setModuleId}>
              <SelectTrigger id="e-module" className="w-full min-w-0 [&>span]:truncate"><SelectValue placeholder="Choose the module" /></SelectTrigger>
              <SelectContent className="max-h-64">
                {modules.map((m) => (
                  <SelectItem key={m.moduleId} value={m.moduleId} className="truncate max-w-[280px]" title={m.name}>{m.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="e-priority">Priority</Label>
            <Select value={priority} onValueChange={(v) => setPriority(v as Priority)}>
              <SelectTrigger id="e-priority"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PRIORITIES.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="e-assignee">Reviewer (assignee)</Label>
            <Select value={assigneeId} onValueChange={setAssigneeId}>
              <SelectTrigger id="e-assignee"><SelectValue placeholder="Unassigned" /></SelectTrigger>
              <SelectContent>
                {/* Matrix-driven: only perform_review holders are selectable. */}
                {options.filter((u) => u.canPerformReview).map((u) => (
                  <SelectItem key={u.userId} value={u.userId}>{u.fullName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="e-tags">Tags (comma-separated)</Label>
          <Input id="e-tags" value={tags} onChange={(e) => setTags(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="e-desc">Description *</Label>
          <Textarea id="e-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="e-pre">Preconditions</Label>
          <Textarea id="e-pre" value={preconditions} onChange={(e) => setPreconditions(e.target.value)} rows={2} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="e-expected">Expected Result</Label>
          <Textarea id="e-expected" value={expectedResult} onChange={(e) => setExpectedResult(e.target.value)} rows={2} />
        </div>
      </CardContent>
    </Card>
  )
}
