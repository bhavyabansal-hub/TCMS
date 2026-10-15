'use client'

// Wiki — the team knowledge base. Two kinds of documents:
//   * written  — created in-app with the rich-text (MS-Word-lite) editor
//   * file     — uploaded binaries (PDF / Office / images / text), streamed
//                back through the authenticated download route
// Everyone signed in can READ the wiki; creating/uploading requires
// create_wiki_doc and deleting follows the same author-or-matrix rule as
// test cases (delete_wiki_doc holders or the document's author).

import { useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, FileText, FileUp, Loader2, Paperclip, Pencil, Plus, Search } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { wikiApi } from '@/lib/client/api'
import { invalidateAfterMutation } from '@/lib/client/invalidate'
import { useAuthStore, useViewStore } from '@/store'
import { formatDateTime, truncate } from '@/lib/format'
import { handleApiError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { Pagination } from '@/components/shared/pagination'
import { StateLoadingCards, EmptyState } from '@/components/shared/state'
import { QueryErrorAlert } from '@/components/shared/query-error'
import { PageHeader } from '@/components/shared/page-header'
import { RichTextEditor } from '@/components/shared/rich-text-editor'
import { toast } from 'sonner'

/** Strip HTML tags for the card snippet — content is sanitized server-side. */
function htmlToSnippet(html: string | null, max = 120): string {
  if (!html) return ''
  const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  return truncate(text, max)
}

function formatBytes(bytes: number | null): string {
  if (!bytes && bytes !== 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function WikiView() {
  const user = useAuthStore((s) => s.user)
  const can = useAuthStore((s) => s.can)
  const navigate = useViewStore((s) => s.navigate)
  const qc = useQueryClient()
  const canCreate = !!user && can('create_wiki_doc')

  const [search, setSearch] = useState('')
  const [kindFilter, setKindFilter] = useState<string>('')
  const [page, setPage] = useState(1)
  const [createOpen, setCreateOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['wiki', 'list', { search, kindFilter, page }],
    queryFn: () => wikiApi.list({ search, kind: kindFilter, page, pageSize: 24 }),
    placeholderData: keepPreviousData,
  })

  const docs = data?.data ?? []

  return (
    <div className="space-y-4">
      <PageHeader
        title="Wiki"
        description="Team knowledge base — write documents or upload files so everyone can find them"
        actions={
          canCreate ? (
            <>
              <Button variant="outline" onClick={() => setUploadOpen(true)}>
                <FileUp className="h-4 w-4 mr-1" /> Upload File
              </Button>
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4 mr-1" /> New Document
              </Button>
            </>
          ) : undefined
        }
      />

      {/* Filter row — search + kind, always visible. */}
      <Card>
        <CardContent className="p-3 flex flex-col md:flex-row gap-2 items-start md:items-center">
          <div className="relative flex-1 w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search documents by title or content..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1) }}
              className="pl-9"
            />
          </div>
          <Select value={kindFilter} onValueChange={(v) => { setKindFilter(v === 'all' ? '' : v); setPage(1) }}>
            <SelectTrigger className="w-full md:w-40"><SelectValue placeholder="Type" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="written">Written</SelectItem>
              <SelectItem value="file">Uploaded files</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {isError ? (
        <QueryErrorAlert
          title="Could not load the wiki"
          onRetry={() => refetch()}
        />
      ) : isLoading ? (
        <StateLoadingCards count={8} />
      ) : docs.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={BookOpen}
              message={search || kindFilter ? 'No documents match your filters' : 'The wiki is empty — create the first document or upload a file'}
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {docs.map((doc) => (
            <Card
              key={doc.wikiDocumentId}
              className="group cursor-pointer transition-colors hover:border-primary/40 hover:bg-accent/40"
              onClick={() => navigate('wiki-doc', { id: doc.wikiDocumentId })}
            >
              <CardContent className="p-4 flex flex-col gap-2 min-h-[9.5rem]">
                <div className="flex items-start gap-2.5">
                  <div
                    className={cn(
                      'flex h-9 w-9 shrink-0 items-center justify-center rounded-md',
                      doc.kind === 'file'
                        ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
                        : 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300'
                    )}
                  >
                    {doc.kind === 'file' ? <Paperclip className="h-4.5 w-4.5" /> : <FileText className="h-4.5 w-4.5" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium leading-snug line-clamp-2">{doc.title}</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5">
                      {doc.kind === 'file' ? `${doc.fileName ?? 'file'} · ${formatBytes(doc.fileSize)}` : 'Written document'}
                    </div>
                  </div>
                </div>
                {doc.kind === 'written' && (
                  <p className="text-xs text-muted-foreground line-clamp-2 min-h-8">
                    {htmlToSnippet(doc.content) || 'No content yet'}
                  </p>
                )}
                <div className="mt-auto flex items-center gap-1.5 flex-wrap">
                  {doc.tags.slice(0, 2).map((t) => (
                    <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>
                  ))}
                  {doc.tags.length > 2 && <Badge variant="secondary" className="text-[10px]">+{doc.tags.length - 2}</Badge>}
                </div>
                <div className="text-[11px] text-muted-foreground border-t pt-2">
                  {doc.author?.fullName ?? 'Unknown'} · {formatDateTime(doc.updatedAt)}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {data && data.totalPages > 1 && (
        <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onPageChange={setPage} />
      )}

      {createOpen && (
        <CreateWikiDocDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={(id) => {
            invalidateAfterMutation(qc, 'wiki')
            // Jump straight into the fresh document — matches the create flow
            // users already know from test cases.
            navigate('wiki-doc', { id })
          }}
        />
      )}

      {uploadOpen && (
        <UploadWikiFileDialog
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          onUploaded={() => invalidateAfterMutation(qc, 'wiki')}
        />
      )}
    </div>
  )
}

// ---------- Create written document ----------

function CreateWikiDocDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (id: string) => void
}) {
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [tags, setTags] = useState('')
  const [saving, setSaving] = useState(false)

  function parseTags(): string[] {
    return tags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 10)
  }

  async function save() {
    if (!title.trim()) {
      toast.error('Give the document a title')
      return
    }
    setSaving(true)
    try {
      const doc = await wikiApi.createWritten({ title: title.trim(), content, tags: parseTags() })
      toast.success('Document created')
      setTitle(''); setContent(''); setTags('')
      onOpenChange(false)
      onCreated(doc.wikiDocumentId)
    } catch (err) {
      handleApiError(err, 'Could not create the document')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>New wiki document</DialogTitle>
          <DialogDescription>
            Write it here with the formatting toolbar — the team will find it through search.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3.5">
          <div className="space-y-1.5">
            <Label htmlFor="wiki-title">Title</Label>
            <Input
              id="wiki-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Release checklist, Onboarding guide, API conventions"
              maxLength={200}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wiki-tags">Tags (comma separated)</Label>
            <Input
              id="wiki-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="e.g. process, qa, onboarding"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Content</Label>
            <RichTextEditor value={content} onChange={setContent} placeholder="Start writing…" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving} className="min-w-36">
            {saving ? (<><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Saving…</>) : (<><Pencil className="h-4 w-4 mr-1.5" /> Create document</>)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------- Upload file document ----------

function UploadWikiFileDialog({
  open,
  onOpenChange,
  onUploaded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onUploaded: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [tags, setTags] = useState('')
  const [uploading, setUploading] = useState(false)

  async function save() {
    if (!file) {
      toast.error('Choose a file to upload')
      return
    }
    setUploading(true)
    try {
      await wikiApi.upload({ file, title: title.trim() || undefined, tags: tags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 10) })
      toast.success('File uploaded to the wiki')
      setFile(null); setTitle(''); setTags('')
      onOpenChange(false)
      onUploaded()
    } catch (err) {
      handleApiError(err, 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload a file to the wiki</DialogTitle>
          <DialogDescription>
            PDF, Word/Excel/PowerPoint, text or images — up to 10 MB. Everyone with access can find and download it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3.5">
          <div className="space-y-1.5">
            <Label htmlFor="wiki-file">File</Label>
            <Input
              id="wiki-file"
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            {file && (
              <p className="text-xs text-muted-foreground">
                {file.name} · {formatBytes(file.size)}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wiki-upload-title">Title (optional — defaults to the file name)</Label>
            <Input
              id="wiki-upload-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Q3 test strategy"
              maxLength={200}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wiki-upload-tags">Tags (comma separated)</Label>
            <Input
              id="wiki-upload-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="e.g. strategy, reports"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={uploading}>Cancel</Button>
          <Button onClick={save} disabled={uploading || !file} className="min-w-32">
            {uploading ? (<><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Uploading…</>) : (<><FileUp className="h-4 w-4 mr-1.5" /> Upload</>)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
