'use client'

// Wiki document detail (/wiki/<id>) — read view + permission-gated actions.
//
//   written docs: rendered rich text, Edit switches to the in-place editor
//   file docs:    file card (name/size/type), image inline preview,
//                 Download (authenticated route) and Replace file
//   delete:       author OR delete_wiki_doc holders — same rose confirm
//                 dialog pattern as the test-case bulk delete

import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft, CalendarDays, Download, FileText, FileUp, Loader2, Paperclip,
  Pencil, Trash2, User,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { wikiApi } from '@/lib/client/api'
import { invalidateAfterMutation } from '@/lib/client/invalidate'
import { useAuthStore, useViewStore } from '@/store'
import { formatDateTime } from '@/lib/format'
import { handleApiError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { DetailLoadError } from '@/components/shared/query-error'
import { RichTextEditor } from '@/components/shared/rich-text-editor'
import { toast } from 'sonner'

function formatBytes(bytes: number | null): string {
  if (!bytes && bytes !== 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function isImageMime(mime: string | null): boolean {
  return !!mime && mime.startsWith('image/')
}

export function WikiDocDetailView() {
  const user = useAuthStore((s) => s.user)
  const can = useAuthStore((s) => s.can)
  const navigate = useViewStore((s) => s.navigate)
  const params = useViewStore((s) => s.params)
  const id = params.id
  const qc = useQueryClient()

  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editContent, setEditContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [replaceFile, setReplaceFile] = useState<File | null>(null)
  const [replacing, setReplacing] = useState(false)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const { data: doc, isLoading, isError, refetch } = useQuery({
    queryKey: ['wiki', 'detail', id],
    queryFn: () => wikiApi.get(id!),
    enabled: !!id,
    // retries: global policy (a 403/404 is never retried — no duplicate call)
  })

  // Keep the editor buffer in sync with the loaded doc (initial load, refetch).
  useEffect(() => {
    if (doc) {
      setEditTitle(doc.title)
      setEditContent(doc.content ?? '')
    }
  }, [doc])

  if (!id) {
    return (
      <div className="space-y-4">
        <BackToWiki />
        <p className="text-sm text-muted-foreground">No document id in the URL.</p>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <BackToWiki />
        <Skeleton className="h-9 w-80" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (isError || !doc) {
    return (
      <div className="space-y-4">
        <BackToWiki />
        <DetailLoadError title="Wiki document could not be loaded" onRetry={() => refetch()} />
      </div>
    )
  }

  const isAuthor = !!user && doc.authorId === user.userId
  // Mirrors the server: author + edit_own, or edit_any. Delete: author OR matrix.
  const canEdit =
    (isAuthor && (can('edit_own_wiki_doc') || can('edit_any_wiki_doc'))) ||
    (!isAuthor && can('edit_any_wiki_doc'))
  const canDelete = isAuthor || can('delete_wiki_doc')

  async function saveEdit() {
    if (!editTitle.trim()) {
      toast.error('The document needs a title')
      return
    }
    setSaving(true)
    try {
      await wikiApi.update(id!, { title: editTitle.trim(), content: editContent })
      toast.success('Document saved')
      setEditing(false)
      invalidateAfterMutation(qc, 'wiki')
    } catch (err) {
      handleApiError(err, 'Could not save the document')
    } finally {
      setSaving(false)
    }
  }

  async function replaceUpload() {
    if (!replaceFile) {
      toast.error('Choose the new file first')
      return
    }
    setReplacing(true)
    try {
      await wikiApi.replaceFile(id!, { file: replaceFile })
      toast.success('File replaced')
      setReplaceOpen(false)
      setReplaceFile(null)
      invalidateAfterMutation(qc, 'wiki')
    } catch (err) {
      handleApiError(err, 'Could not replace the file')
    } finally {
      setReplacing(false)
    }
  }

  async function remove() {
    setDeleting(true)
    try {
      await wikiApi.remove(id!)
      toast.success('Document deleted permanently')
      setConfirmDeleteOpen(false)
      invalidateAfterMutation(qc, 'wiki')
      navigate('wiki')
    } catch (err) {
      handleApiError(err, 'Could not delete the document')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-4">
      <BackToWiki />

      {/* Header — title + meta left, actions right */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {editing ? (
            <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} maxLength={200} className="max-w-xl text-lg font-semibold" />
          ) : (
            <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
              {doc.kind === 'file'
                ? <Paperclip className="h-6 w-6 text-muted-foreground" aria-hidden />
                : <FileText className="h-6 w-6 text-muted-foreground" aria-hidden />}
              <span className="break-words">{doc.title}</span>
            </h1>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><User className="h-3.5 w-3.5" /> {doc.author?.fullName ?? 'Unknown'}</span>
            <span className="flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" /> Updated {formatDateTime(doc.updatedAt)}</span>
            {doc.lastEditedBy && doc.lastEditedBy.userId !== doc.authorId && (
              <span>edited by {doc.lastEditedBy.fullName}</span>
            )}
            {doc.tags.map((t) => <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>)}
          </div>
        </div>

        {!editing && (
          <div className="flex shrink-0 flex-wrap gap-2">
            {doc.kind === 'file' && (
              <Button variant="outline" asChild>
                <a href={wikiApi.downloadUrl(doc.wikiDocumentId)} download={doc.fileName ?? undefined}>
                  <Download className="h-4 w-4 mr-1" /> Download
                </a>
              </Button>
            )}
            {canEdit && doc.kind === 'file' && (
              <Button variant="outline" onClick={() => setReplaceOpen(true)}>
                <FileUp className="h-4 w-4 mr-1" /> Replace file
              </Button>
            )}
            {canEdit && doc.kind === 'written' && (
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil className="h-4 w-4 mr-1" /> Edit
              </Button>
            )}
            {canDelete && (
              <Button variant="destructive" onClick={() => setConfirmDeleteOpen(true)}>
                <Trash2 className="h-4 w-4 mr-1" /> Delete
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Body */}
      {doc.kind === 'file' ? (
        <Card>
          <CardContent className="p-6 flex flex-col items-center gap-3 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-950">
              <Paperclip className="h-7 w-7 text-amber-700 dark:text-amber-300" />
            </div>
            <div>
              <div className="font-medium break-all">{doc.fileName}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {formatBytes(doc.fileSize)} · {doc.fileType ?? 'unknown type'}
              </div>
            </div>
            {isImageMime(doc.fileType) && (
              // Uploaded images preview inline; everything else downloads.
              <img
                src={wikiApi.downloadUrl(doc.wikiDocumentId)}
                alt={doc.fileName ?? 'wiki file'}
                className="mt-2 max-h-96 rounded-md border object-contain"
              />
            )}
            <Button variant="outline" asChild className="mt-1">
              <a href={wikiApi.downloadUrl(doc.wikiDocumentId)} download={doc.fileName ?? undefined}>
                <Download className="h-4 w-4 mr-1" /> Download file
              </a>
            </Button>
          </CardContent>
        </Card>
      ) : editing ? (
        <div className="space-y-3">
          <RichTextEditor value={editContent} onChange={setEditContent} placeholder="Write the document…" />
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setEditing(false)
                setEditTitle(doc.title)
                setEditContent(doc.content ?? '')
              }}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button onClick={saveEdit} disabled={saving} className="min-w-32">
              {saving ? (<><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Saving…</>) : 'Save changes'}
            </Button>
          </div>
        </div>
      ) : (
        <Card>
          <CardContent className="p-6">
            {doc.content ? (
              <div
                className={cn(
                  'text-sm leading-relaxed',
                  '[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-semibold',
                  '[&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:text-lg [&_h3]:font-semibold',
                  '[&_p]:my-1.5 [&_blockquote]:border-l-2 [&_blockquote]:border-muted-foreground/40 [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-muted-foreground',
                  '[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1',
                  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]',
                  '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2'
                )}
                // Content was sanitized server-side on write (no script/handlers).
                dangerouslySetInnerHTML={{ __html: doc.content }}
              />
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">This document has no content yet.</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Replace file dialog */}
      {replaceOpen && (
        <Dialog open onOpenChange={setReplaceOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Replace the file</DialogTitle>
              <DialogDescription>The current file is overwritten permanently.</DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="wiki-replace-file">New file</Label>
              <Input id="wiki-replace-file" type="file" onChange={(e) => setReplaceFile(e.target.files?.[0] ?? null)} />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setReplaceOpen(false)} disabled={replacing}>Cancel</Button>
              <Button onClick={replaceUpload} disabled={replacing || !replaceFile} className="min-w-32">
                {replacing ? (<><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Uploading…</>) : 'Replace'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Delete confirm — same danger pattern as the test-case bulk delete */}
      {confirmDeleteOpen && (
        <Dialog open onOpenChange={setConfirmDeleteOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <div className="flex items-start gap-3.5">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-rose-100 dark:bg-rose-500/15">
                  <Trash2 className="h-5 w-5 text-rose-600 dark:text-rose-400" />
                </div>
                <div className="space-y-1.5">
                  <DialogTitle>Delete this document?</DialogTitle>
                  <DialogDescription>
                    “{doc.title}” will be removed from the wiki for the whole team.
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
              <span className="font-semibold">This cannot be undone.</span>
              {doc.kind === 'file' ? ' The uploaded file is removed with it.' : ' The written content is removed with it.'}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmDeleteOpen(false)} disabled={deleting}>Cancel</Button>
              <Button variant="destructive" onClick={remove} disabled={deleting} className="min-w-36">
                {deleting ? (
                  <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Deleting…</>
                ) : (
                  <><Trash2 className="h-4 w-4 mr-1.5" /> Delete permanently</>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

function BackToWiki() {
  const navigate = useViewStore((s) => s.navigate)
  return (
    <Button type="button" variant="ghost" size="sm" className="w-fit gap-1 px-2" onClick={() => navigate('wiki')}>
      <ArrowLeft className="h-4 w-4" aria-hidden />
      All documents
    </Button>
  )
}
