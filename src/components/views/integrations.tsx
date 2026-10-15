'use client'

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BadgeCheck, BadgeX, Copy, History, Link2, RefreshCw, Search, ShieldAlert, X,
} from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { PageHeader } from '@/components/shared/page-header'
import { crewdeskApi, modulesApi } from '@/lib/client/api'
import { invalidateAfterMutation } from '@/lib/client/invalidate'
import type { Module } from '@/types'
import { formatDateTime } from '@/lib/format'
import { handleApiError } from '@/lib/errors'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { CrewDeskLink } from '@/lib/client/api'
import { useAuthStore, useViewStore } from '@/store'
import { PermissionDenied } from '@/components/shared/permission-denied'

const NOTE_MAX = 300

/**
 * /integrations — Crew Desk module<->ticket linking.
 *
 * Modes (from server config):
 *   - manual: NOTHING is sent to Crew Desk. Pick a module, optionally type a
 *     note, "Generate comment" -> copy the comment / module link and paste
 *     them into Crew Desk yourself. Every copy is kept in the history.
 *   - test:   only the single designated test ticket may receive comments.
 *   - live:   any ticket (production, set deliberately on the server).
 *
 * In test/live the comment is posted AS THE SHARED TCMS service account with
 * an automatic "Linked by" line + the optional note, AFTER the verification-
 * only email check passes. Failures land in history with Retry. There are NO
 * email exceptions: everyone is matched by their own TCMS login email.
 *
 * LAYOUT NOTE (owner feedback, 3rd round): "no how-it-works panel — expand
 * horizontally". The explainer card is GONE. The page is now three plain,
 * full-width blocks, top to bottom:
 *   1. header + one slim status strip (connection · mode · email · counts),
 *   2. ONE full-width form card with the three fields side by side
 *      (Module | Ticket | Note), a full-width preview strip and action bar,
 *   3. the full-width link history table.
 */
export function IntegrationsView() {
  const qc = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const can = useAuthStore((s) => s.can)
  const navigate = useViewStore((s) => s.navigate)
  const [moduleSearch, setModuleSearch] = useState('')
  const [selectedModule, setSelectedModule] = useState<Module | null>(null)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [ticketId, setTicketId] = useState('')
  const [note, setNote] = useState('')
  const [preview, setPreview] = useState<{ title: string; status: string; canLink: boolean } | null>(null)
  const [manualCopy, setManualCopy] = useState<{ comment: string; moduleUrl: string } | null>(null)

  const modulesQuery = useQuery({ queryKey: ['modules', 'flat'], queryFn: () => modulesApi.tree() })
  const configQuery = useQuery({ queryKey: ['crewdesk', 'config'], queryFn: crewdeskApi.config })
  const linksQuery = useQuery({
    queryKey: ['crewdesk', 'links'],
    queryFn: () => crewdeskApi.list({ pageSize: '50' }),
  })
  const emailCheckQuery = useQuery({
    queryKey: ['crewdesk', 'email-check'],
    queryFn: crewdeskApi.emailCheck,
    retry: 0,
  })

  const invalidate = () => {
    invalidateAfterMutation(qc, 'crewdesk')
  }

  const lookupMutation = useMutation({
    mutationFn: () => crewdeskApi.lookup(ticketId.trim()),
    onSuccess: (data) => {
      setPreview({ title: data.title, status: data.status, canLink: data.canLinkInCurrentMode })
    },
    onError: (err) => {
      setPreview(null)
      handleApiError(err)
    },
  })

  const createMutation = useMutation({
    mutationFn: () =>
      crewdeskApi.create({
        moduleId: selectedModule!.moduleId,
        ticketId: ticketId.trim(),
        note: note.trim() || null,
      }),
    onSuccess: async (link) => {
      if (link.status === 'posted') {
        toast.success(`Linked to ticket ${link.ticketId} (comment ${link.crewdeskCommentId})`)
        resetForm()
      } else if (link.status === 'manual') {
        // Fetch the EXACT generated text (same server builder) for copying.
        const copy = await crewdeskApi.commentFor(link.linkId)
        setManualCopy(copy)
        toast.success('Comment generated — copy it into Crew Desk.')
        setNote('')
        setTicketId('')
        setPreview(null)
      } else {
        toast.error(link.lastError ?? 'Crew Desk link failed')
        resetForm()
      }
      invalidate()
    },
    onError: (err) => handleApiError(err),
  })

  const retryMutation = useMutation({
    mutationFn: (linkId: string) => crewdeskApi.retry(linkId),
    onSuccess: (link) => {
      if (link.status === 'posted') toast.success(`Retry posted (comment ${link.crewdeskCommentId})`)
      else toast.error(link.lastError ?? 'Retry failed')
      invalidate()
    },
    onError: (err) => handleApiError(err),
  })

  const copyMutation = useMutation({
    mutationFn: (linkId: string) => crewdeskApi.commentFor(linkId),
    onSuccess: async ({ comment, moduleUrl }) => {
      await copyText(`${comment}\n\n${moduleUrl}`)
      toast.success('Comment and module link copied')
    },
    onError: (err) => handleApiError(err),
  })

  // PRE-LINK copy (manual fallback): builds the exact comment/link from the
  // selected module + current note WITHOUT creating a link. Available before
  // any linking so the module link can be pasted into Crew Desk by hand when
  // the automatic link is not possible.
  const previewCopyMutation = useMutation({
    mutationFn: () => crewdeskApi.previewComment(selectedModule!.moduleId, note.trim() || null),
    onSuccess: async ({ comment, moduleUrl }) => {
      await copyText(`${comment}\n\n${moduleUrl}`)
      toast.success('Comment and module link copied — paste them into Crew Desk')
    },
    onError: (err) => handleApiError(err),
  })
  const previewLinkMutation = useMutation({
    mutationFn: () => crewdeskApi.previewComment(selectedModule!.moduleId, note.trim() || null),
    onSuccess: async ({ moduleUrl }) => {
      await copyText(moduleUrl)
      toast.success('Module link copied — paste it into the Crew Desk ticket')
    },
    onError: (err) => handleApiError(err),
  })

  function resetForm() {
    setPreview(null)
    setTicketId('')
    setNote('')
    setSelectedModule(null)
    setModuleSearch('')
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Clipboard API can be unavailable (http, permissions) — fall back.
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
  }

  const allModules = useMemo(() => modulesQuery.data?.flat ?? [], [modulesQuery.data])
  const filteredModules = useMemo(() => {
    const q = moduleSearch.trim().toLowerCase()
    if (!q) return allModules
    return allModules.filter((m) => m.name.toLowerCase().includes(q))
  }, [allModules, moduleSearch])

  const mode = configQuery.data?.mode ?? 'test'
  const testTicketId = configQuery.data?.testTicketId ?? '1355'
  const accountEmail = configQuery.data?.accountEmail ?? null
  const authMode = configQuery.data?.authMode ?? 'none'
  const credentialExpiresAt = configQuery.data?.credentialExpiresAt ?? null
  // Fixed-token lifeguard: warn BEFORE the hourly dev token dies (chip turns
  // red only once it is actually expired — posting will 401 after that).
  const tokenMsLeft = credentialExpiresAt ? Date.parse(credentialExpiresAt) - Date.now() : null
  const tokenState: 'ok' | 'soon' | 'expired' | null =
    tokenMsLeft === null ? null : tokenMsLeft <= 0 ? 'expired' : tokenMsLeft < 30 * 60_000 ? 'soon' : 'ok'
  const manual = mode === 'manual'
  const links: CrewDeskLink[] = linksQuery.data?.data ?? []
  const emailStatus = emailCheckQuery.data?.status
  const postedCount = links.filter((l) => l.status === 'posted').length
  const failedCount = links.filter((l) => l.status === 'failed').length

  const refreshAll = () => {
    void configQuery.refetch()
    void linksQuery.refetch()
    if (!manual) void emailCheckQuery.refetch()
  }

  // STRICT in-view guard (second layer; the sidebar already hides the tab):
  // the integrations workspace — and every Crew Desk API behind it — is for
  // manage_integrations holders only. Must sit AFTER all hooks (rules of hooks).
  if (user && !can('manage_integrations')) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Integrations"
          description="Connect TCMS modules to external tools such as Crew Desk."
        />
        <PermissionDenied description="Integrations are only available to roles with the manage-integrations permission. A VP can enable it for your role under Permissions." />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Integrations"
        description="Link TCMS modules to Crew Desk tickets — the ticket receives a comment pointing back to the module's test cases."
        actions={
          <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={refreshAll}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            Refresh
          </Button>
        }
      />

      {/* ---- 1. Status strip: connection · mode · email · counts, one row ---- */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5 rounded-lg border bg-card px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden
            className={cn(
              'h-2.5 w-2.5 shrink-0 rounded-full',
              accountEmail ? 'bg-emerald-500' : 'bg-destructive',
            )}
          />
          {configQuery.isLoading ? (
            <Skeleton className="h-5 w-56" />
          ) : accountEmail ? (
            <p className="min-w-0 truncate text-sm">
              <span className="font-medium">Connected</span>
              <span className="text-muted-foreground">
                {' '}· posting as <span className="font-mono text-xs" title={accountEmail}>{accountEmail}</span>
                {' '}· {authMode === 'login' ? 'password login' : 'fixed token'}
              </span>
            </p>
          ) : (
            <p className="text-sm font-medium text-destructive">
              Not configured — ask an admin to set the Crew Desk credentials
            </p>
          )}
        </div>

        <Chip
          tone={manual ? 'neutral' : mode === 'test' ? 'amber' : 'emerald'}
          label={manual ? 'Manual mode' : mode === 'test' ? 'Test mode' : 'Live mode'}
          title={
            manual
              ? 'Nothing is sent to Crew Desk; you copy the generated comment yourself'
              : mode === 'test'
                ? `Comments go only to the designated test ticket ${testTicketId}`
                : 'Comments are allowed on any ticket'
          }
        />

        {tokenState === 'expired' && (
          <Chip tone="red" label="Token expired — paste a fresh one" title="The fixed Crew Desk token in .env has expired. Posting is refused until an admin updates it." />
        )}
        {tokenState === 'soon' && (
          <Chip
            tone="amber"
            label={`Token expires in ${Math.max(1, Math.round((tokenMsLeft ?? 0) / 60_000))} min`}
            title="The fixed Crew Desk token is short-lived (dev backend). Ask for a fresh one before it lapses."
          />
        )}

        <Chip
          tone={
            manual
              ? 'neutral'
              : emailStatus === 'verified'
                ? 'emerald'
                : emailStatus === 'not_found'
                  ? 'red'
                  : 'neutral'
          }
          icon={
            manual ? undefined : emailStatus === 'verified' ? (
              <BadgeCheck className="h-3.5 w-3.5" aria-hidden />
            ) : emailStatus === 'not_found' ? (
              <BadgeX className="h-3.5 w-3.5" aria-hidden />
            ) : undefined
          }
          label={
            manual
              ? 'Verification not required'
              : emailCheckQuery.isLoading
                ? 'Checking your email…'
                : emailStatus === 'verified'
                  ? 'Email verified'
                  : emailStatus === 'not_found'
                    ? 'Email not in Crew Desk'
                    : 'Verification pending'
          }
          title={
            emailStatus === 'not_found'
              ? 'Posting is blocked until your TCMS email exists in Crew Desk — ask your admin'
              : undefined
          }
        />

        <span className="ml-auto text-xs text-muted-foreground" data-testid="crewdesk-history-count">
          {linksQuery.isLoading
            ? '…'
            : `${links.length} link${links.length === 1 ? '' : 's'} · ${postedCount} posted${failedCount > 0 ? ` · ${failedCount} failed` : ''}`}
        </span>
      </div>

      {/* ---- 2. Link form: full width, three fields side by side ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Link a module to a ticket</CardTitle>
          <CardDescription>
            Pick the module, check the ticket, then link — nothing else on the ticket changes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {manual && (
            <Note tone="neutral">
              Manual mode is on: nothing is sent to Crew Desk. Generate the comment, then copy and
              paste it into Crew Desk yourself.
            </Note>
          )}
          {mode === 'test' && (
            <Note tone="amber">
              Test mode: comments go only to the designated test ticket{' '}
              <strong className="font-mono">{testTicketId}</strong>. Links to any other ticket are
              refused before anything is sent.
            </Note>
          )}
          {mode === 'test' && emailStatus === 'not_found' && (
            <Note tone="red" role="alert">
              Your email was not found in Crew Desk, so posting is blocked. Ask your admin to add you.
            </Note>
          )}

          {/* Fields row: Module | Ticket | Note */}
          <div className="grid gap-5 md:grid-cols-3">
            {/* Module */}
            <div className="space-y-2">
              <Label htmlFor="crewdesk-module">Module</Label>
              {selectedModule ? (
                <div className="flex items-center gap-2">
                  <Input readOnly value={selectedModule.name} aria-label="Selected module" />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9 shrink-0"
                    onClick={() => { setSelectedModule(null); setModuleSearch(''); setDropdownOpen(true) }}
                  >
                    Change
                  </Button>
                </div>
              ) : (
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
                  <Input
                    id="crewdesk-module"
                    className="pl-8"
                    placeholder="Search modules…"
                    value={moduleSearch}
                    autoComplete="off"
                    onChange={(e) => { setModuleSearch(e.target.value); setDropdownOpen(true) }}
                    onFocus={() => setDropdownOpen(true)}
                    onBlur={() => window.setTimeout(() => setDropdownOpen(false), 150)}
                    aria-expanded={dropdownOpen}
                    role="combobox"
                    aria-controls="crewdesk-module-list"
                  />
                  {dropdownOpen && (
                    <ul
                      id="crewdesk-module-list"
                      className="absolute z-20 mt-1 max-h-48 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-md"
                      role="listbox"
                    >
                      {modulesQuery.isLoading && <li className="px-2 py-1.5 text-sm text-muted-foreground">Loading…</li>}
                      {!modulesQuery.isLoading && filteredModules.length === 0 && (
                        <li className="px-2 py-1.5 text-sm text-muted-foreground">No modules match “{moduleSearch}”</li>
                      )}
                      {filteredModules.map((m) => (
                        <li key={m.moduleId}>
                          <button
                            type="button"
                            className="w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                            onMouseDown={(e) => { e.preventDefault(); setSelectedModule(m); setDropdownOpen(false) }}
                          >
                            {m.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <p className="text-xs text-muted-foreground">The module whose test cases will be shared.</p>
            </div>

            {/* Ticket */}
            <div className="space-y-2">
              <Label htmlFor={manual ? 'crewdesk-ticket-manual' : 'crewdesk-ticket'}>
                Crew Desk ticket ID
                {manual && <span className="font-normal text-muted-foreground"> — optional</span>}
              </Label>
              {manual ? (
                <Input
                  id="crewdesk-ticket-manual"
                  placeholder="e.g. 1355"
                  value={ticketId}
                  autoComplete="off"
                  onChange={(e) => { setTicketId(e.target.value); setPreview(null) }}
                />
              ) : (
                <div className="flex gap-2">
                  <Input
                    id="crewdesk-ticket"
                    className="flex-1"
                    placeholder={`e.g. ${testTicketId}`}
                    value={ticketId}
                    autoComplete="off"
                    onChange={(e) => { setTicketId(e.target.value); setPreview(null) }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && ticketId.trim() && !lookupMutation.isPending) {
                        e.preventDefault()
                        lookupMutation.mutate()
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="shrink-0"
                    disabled={!ticketId.trim() || lookupMutation.isPending}
                    onClick={() => lookupMutation.mutate()}
                  >
                    {lookupMutation.isPending ? 'Checking…' : 'Check'}
                  </Button>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {manual ? 'For your records only.' : 'Check the ticket before linking.'}
              </p>
            </div>

            {/* Note */}
            <div className="space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <Label htmlFor="crewdesk-note">Note (optional)</Label>
                <span className={cn('text-xs', note.length >= NOTE_MAX ? 'font-medium text-amber-600' : 'text-muted-foreground')}>
                  {note.length}/{NOTE_MAX}
                </span>
              </div>
              <Input
                id="crewdesk-note"
                placeholder="Add context, e.g. your team or a request"
                value={note}
                maxLength={NOTE_MAX}
                autoComplete="off"
                onChange={(e) => setNote(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Added to the comment after your automatic “Linked by” line.
              </p>
            </div>
          </div>

          {/* Ticket preview — full width strip under the fields */}
          {!manual && preview && (
            <div
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border bg-muted/30 px-4 py-3"
              data-testid="crewdesk-ticket-preview"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{preview.title}</p>
                <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  Ticket <span className="font-mono">{ticketId.trim()}</span> · current status
                  <Badge variant="outline" className="px-1.5 py-0 text-[11px]">{preview.status}</Badge>
                </p>
              </div>
              {!preview.canLink && (
                <p className="text-xs font-medium text-destructive">
                  Only the designated test ticket {testTicketId} can receive comments in test mode.
                </p>
              )}
            </div>
          )}

          {/* Manual mode generated copy — full width */}
          {manual && manualCopy && (
            <div className="space-y-2 rounded-md border bg-muted/30 p-4" data-testid="crewdesk-manual-copy">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">Generated comment — paste it into Crew Desk</p>
                <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={() => setManualCopy(null)}>
                  <X className="h-3.5 w-3.5" aria-hidden />
                  Dismiss
                </Button>
              </div>
              <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs">{manualCopy.comment}</pre>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1"
                  onClick={() => copyText(manualCopy.comment).then(() => toast.success('Comment copied'))}
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden />
                  Copy comment
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1"
                  onClick={() => copyText(manualCopy.moduleUrl).then(() => toast.success('Module link copied'))}
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden />
                  Copy module link
                </Button>
              </div>
            </div>
          )}

          {/* Action bar — the Copy buttons stay available BEFORE linking:
              if the automatic link does not attach, paste the module link
              into Crew Desk manually. */}
          <div className="flex flex-wrap items-center gap-3 border-t pt-4">
            {manual ? (
              <Button
                type="button"
                className="gap-2"
                disabled={!selectedModule || createMutation.isPending}
                onClick={() => createMutation.mutate()}
              >
                {createMutation.isPending ? 'Generating…' : 'Generate comment'}
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  className="gap-2"
                  disabled={!selectedModule || !preview || !preview.canLink || createMutation.isPending}
                  onClick={() => createMutation.mutate()}
                >
                  <Link2 className="h-4 w-4" aria-hidden />
                  {createMutation.isPending ? 'Linking…' : 'Link module'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="gap-1.5"
                  disabled={!selectedModule || previewCopyMutation.isPending}
                  onClick={() => previewCopyMutation.mutate()}
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden />
                  Copy comment
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="gap-1.5"
                  disabled={!selectedModule || previewLinkMutation.isPending}
                  onClick={() => previewLinkMutation.mutate()}
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden />
                  Copy module link
                </Button>
              </>
            )}
            <p className="text-xs text-muted-foreground">
              {manual
                ? 'TCMS builds the text — nothing is sent for you.'
                : !preview
                  ? 'Check the ticket first — its title and status appear above before you link.'
                  : 'A short comment pointing to the module is posted as the shared TCMS account.'}
              {manual
                ? null
                : ' The Copy buttons work before linking too — add the link to the ticket by hand if the link does not attach.'}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* ---- 3. Link history: full-width table ---- */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="text-lg">Link history</CardTitle>
            <CardDescription>
              Every attempt is kept. Failed rows remember what was typed — press Retry, or Copy a posted comment again any time.
            </CardDescription>
          </div>
          {!linksQuery.isLoading && links.length > 0 && (
            <div className="flex shrink-0 gap-1.5">
              <Badge variant="secondary">{links.length} total</Badge>
              {postedCount > 0 && <Badge className="bg-emerald-600 hover:bg-emerald-600">{postedCount} posted</Badge>}
              {failedCount > 0 && <Badge variant="destructive">{failedCount} failed</Badge>}
            </div>
          )}
        </CardHeader>
        <CardContent>
          {linksQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-2/3" />
            </div>
          ) : links.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed py-12 text-center">
              <History className="h-8 w-8 text-muted-foreground/50" aria-hidden />
              <p className="text-sm font-medium">No links yet</p>
              <p className="text-xs text-muted-foreground">Create the first one with the form above.</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Module</TableHead>
                    <TableHead>Ticket</TableHead>
                    <TableHead>Linked by</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {links.map((link) => (
                    <TableRow key={link.linkId} className="hover:bg-muted/40">
                      <TableCell className="max-w-48 truncate">
                        <button
                          type="button"
                          className="font-medium underline-offset-2 hover:underline"
                          title={`Open module ${link.moduleName}`}
                          onClick={() => navigate('module-detail', { id: link.moduleId })}
                        >
                          {link.moduleName}
                        </button>
                      </TableCell>
                      <TableCell>
                        <span className="font-mono">{link.ticketId || '—'}</span>
                        {link.ticketTitle && (
                          <span className="block max-w-48 truncate text-xs text-muted-foreground" title={link.ticketTitle}>
                            {link.ticketTitle}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{link.linkedByName}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(link.createdAt)}</TableCell>
                      <TableCell>
                        {link.status === 'posted' ? (
                          <Badge className="gap-1 bg-emerald-600 hover:bg-emerald-600" title={`comment ${link.crewdeskCommentId ?? ''}`}>
                            <BadgeCheck className="h-3 w-3" aria-hidden /> posted
                          </Badge>
                        ) : link.status === 'manual' ? (
                          <Badge variant="secondary">manual</Badge>
                        ) : (
                          <div className="max-w-56">
                            <Badge variant="destructive" title={link.lastError ?? 'Failed'}>failed</Badge>
                            {link.lastError && (
                              <p className="mt-0.5 truncate text-xs text-muted-foreground" title={link.lastError}>
                                {link.lastError}
                              </p>
                            )}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          {link.status === 'failed' && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="gap-1"
                              disabled={retryMutation.isPending}
                              onClick={() => retryMutation.mutate(link.linkId)}
                            >
                              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                              Retry
                            </Button>
                          )}
                          {(link.status === 'manual' || link.status === 'posted') && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="gap-1"
                              disabled={copyMutation.isPending}
                              onClick={() => copyMutation.mutate(link.linkId)}
                            >
                              <Copy className="h-3.5 w-3.5" aria-hidden />
                              Copy
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ---------- Small presentational helpers ----------

/** Inline pill used in the status strip. */
function Chip({
  tone,
  label,
  icon,
  title,
}: {
  tone: 'neutral' | 'amber' | 'emerald' | 'red'
  label: string
  icon?: React.ReactNode
  title?: string
}) {
  const tones = {
    neutral: 'border-border bg-muted/50 text-muted-foreground',
    amber: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
    emerald: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    red: 'border-destructive/40 bg-destructive/10 text-destructive',
  } as const
  return (
    <span
      title={title}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
        tones[tone],
      )}
    >
      {icon}
      {label}
    </span>
  )
}

/** Inline callout used inside the form card. */
function Note({
  tone,
  role,
  children,
}: {
  tone: 'neutral' | 'amber' | 'red'
  role?: 'alert' | 'note'
  children: React.ReactNode
}) {
  const tones = {
    neutral: 'border-border bg-muted/40 text-foreground',
    amber: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
    red: 'border-destructive/40 bg-destructive/10 text-destructive',
  } as const
  return (
    <div
      role={role ?? 'note'}
      className={cn('flex items-start gap-2 rounded-md border p-3 text-sm', tones[tone])}
    >
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </div>
  )
}
