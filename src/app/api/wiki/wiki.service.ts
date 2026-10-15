// Wiki service — business logic and orchestration for the team knowledge base.
//
// PERMISSION MODEL (mirrors test cases exactly — owner requirement:
// "same permissions of delete all test cases"):
//   - READ (list/get/download): every authenticated user — the wiki exists so
//     the whole team can find everything, no read gate.
//   - CREATE: create_wiki_doc matrix holders.
//   - EDIT:   author with edit_own_wiki_doc, OR edit_any_wiki_doc holders.
//   - DELETE: author OR delete_wiki_doc holders (same author-or-matrix rule
//     as single test-case delete). Every cell is VP-togglable at runtime.
//
// Data access goes exclusively through the repository; responses through the
// serializer. Uploaded binaries live in `file_data` (bytea) and NEVER flow
// through list/get — only through the download route.

import type { RequestMeta } from '@/lib/activity'
import { ApiError, getPagination, paginate, type PaginatedResponse } from '@/lib/api'
import { can, ensurePermission, type SessionUser } from '@/lib/auth'
import { logActivity } from '@/lib/activity'
import { logger } from '@/lib/logger'
import { serializeWikiDocument, type SerializedWikiDocument } from '@/lib/serializers'
import sanitizeHtml from 'sanitize-html'
import {
  countWikiDocuments,
  deleteWikiDocumentById,
  findWikiDocumentById,
  findWikiFileDataById,
  insertWikiDocument,
  listWikiDocuments,
  updateWikiDocument,
  type WikiFilters,
  type WikiDocumentUpdateFields,
} from './wiki.repository'
import type { CreateWikiDocInput, UpdateWikiDocInput } from './wiki.validation'

// ---------- Constraints ----------

export const WIKI_MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB

/** Upload allowlist — office docs, PDFs, text formats and images. Checked by
 *  extension; the browser-provided MIME type is stored for serving. */
const WIKI_ALLOWED_EXTENSIONS = [
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'txt', 'md', 'csv', 'json',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'zip',
] as const

// ---------- HTML sanitizer (defense-in-depth) ----------
// The editor produces trusted-ish HTML from authenticated teammates, but the
// content is rendered with dangerouslySetInnerHTML — so stored HTML is
// sanitized server-side BEFORE it ever reaches the database.
//
// AUDIT FIX (2026-10-09): the previous 4-regex chain was bypassable —
// `<svg/onload=…>` (slash separator), unquoted/entity-encoded `javascript:`
// URLs, `<base>`, `<form>` phishing and inline `style: url(...)` exfil all
// survived it. Replaced with an ALLOWLIST sanitizer: only the tags/attributes
// the editor actually produces survive; everything else (including content
// of script/style) is dropped; URI schemes are limited to http/https/mailto;
// links get rel=noopener enforced.
const WIKI_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4',
    'strong', 'b', 'em', 'i', 'u', 's', 'code', 'pre', 'blockquote',
    'ul', 'ol', 'li', 'a', 'img', 'span', 'div',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
  ],
  allowedAttributes: {
    // rel MUST be allowed or the transformTags rel=noopener (tabnabbing
    // defense) is silently stripped right after being added.
    a: ['href', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    // Class stays available for code-block language hints (hljs-*).
    code: ['class'],
    span: ['class'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  // No data: URIs anywhere (they smuggle scripts/unknown content).
  allowProtocolRelative: false,
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow', target: '_blank' }, true),
  },
  disallowedTagsMode: 'discard', // dangerous tags dropped entirely, content kept
}

/**
 * Sanitizes rich-text HTML with the allowlist options above. Applied on BOTH
 * create and update (audit-verified) — the database only ever stores clean HTML.
 */
export function sanitizeWikiHtml(html: string): string {
  return sanitizeHtml(html ?? '', WIKI_SANITIZE_OPTIONS)
}

// ---------- Helpers ----------

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase()
}

export function validateWikiUpload(file: File): void {
  if (!file || typeof file === 'string') throw ApiError.badRequest('No file uploaded')
  if (file.size === 0) throw ApiError.badRequest('The uploaded file is empty')
  if (file.size > WIKI_MAX_FILE_BYTES) {
    throw ApiError.badRequest(`File is too large — the limit is ${Math.floor(WIKI_MAX_FILE_BYTES / (1024 * 1024))} MB`)
  }
  const ext = extensionOf(file.name)
  if (!(WIKI_ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
    throw ApiError.badRequest(`File type ".${ext || 'unknown'}" is not allowed — allowed: ${WIKI_ALLOWED_EXTENSIONS.join(', ')}`)
  }
}

function assertCanEdit(me: SessionUser, doc: { authorId: string }): void {
  const isAuthor = doc.authorId === me.userId
  if (isAuthor) {
    if (can(me.role, 'edit_any_wiki_doc') || can(me.role, 'edit_own_wiki_doc')) return
    throw ApiError.forbidden('You need edit-own-wiki rights to edit your own documents')
  }
  if (!can(me.role, 'edit_any_wiki_doc')) {
    throw ApiError.forbidden('Only the author or edit-any-wiki holders can edit this document')
  }
}

// ---------- Queries ----------

export async function listWikiPaginated(
  q: Record<string, string>
): Promise<PaginatedResponse<SerializedWikiDocument>> {
  const filters: WikiFilters = {
    kind: q.kind === 'written' || q.kind === 'file' ? q.kind : undefined,
    authorId: q.authorId,
    tag: q.tag,
    search: q.search,
  }
  const { page, pageSize, offset } = getPagination(q, 24)
  const [total, rows] = await Promise.all([
    countWikiDocuments(filters),
    listWikiDocuments(filters, pageSize, offset),
  ])
  return paginate(rows.map(serializeWikiDocument), total, page, pageSize)
}

export async function getWikiDocument(id: string): Promise<SerializedWikiDocument> {
  const doc = await findWikiDocumentById(id)
  if (!doc) throw ApiError.notFound('Wiki document not found')
  return serializeWikiDocument(doc)
}

/** Binary payload for GET ?id=...&action=download — served by the route with
 *  Content-Disposition: attachment (download-only by design; SVG/HTML cannot
 *  execute in the app origin this way). */
export async function getWikiFileDownload(id: string): Promise<{
  fileName: string
  fileType: string
  body: Buffer
}> {
  const file = await findWikiFileDataById(id)
  if (!file) throw ApiError.notFound('Wiki document not found')
  return {
    fileName: file.file_name,
    fileType: file.file_type || 'application/octet-stream',
    body: Buffer.from(file.file_data),
  }
}

// ---------- Commands ----------

export async function createWrittenWikiDoc(
  me: SessionUser,
  input: CreateWikiDocInput,
  meta: RequestMeta
): Promise<SerializedWikiDocument> {
  ensurePermission(me, 'create_wiki_doc', 'Only roles with create-wiki rights can create documents')
  const id = await insertWikiDocument({
    title: input.title,
    kind: 'written',
    content: sanitizeWikiHtml(input.content ?? ''),
    fileName: null,
    fileType: null,
    fileSize: null,
    fileData: null,
    tags: input.tags ?? [],
    authorId: me.userId,
  })
  logger.info('Wiki document created', { wikiDocumentId: id, title: input.title, author: me.userId })
  await logActivity({
    userId: me.userId,
    action: 'CREATE',
    entityType: 'wiki_document',
    entityId: id,
    entityName: input.title,
    after: { title: input.title, kind: 'written', tags: input.tags ?? [] },
    meta,
  })
  return getWikiDocument(id)
}

export interface WikiUploadInput {
  file: File
  title?: string
  tags?: string[]
}

export async function createUploadedWikiDoc(
  me: SessionUser,
  input: WikiUploadInput,
  meta: RequestMeta
): Promise<SerializedWikiDocument> {
  ensurePermission(me, 'create_wiki_doc', 'Only roles with create-wiki rights can upload documents')
  validateWikiUpload(input.file)
  const buffer = Buffer.from(await input.file.arrayBuffer())
  const title = input.title?.trim() || input.file.name
  const id = await insertWikiDocument({
    title,
    kind: 'file',
    content: null,
    fileName: input.file.name,
    fileType: input.file.type || 'application/octet-stream',
    fileSize: buffer.length,
    fileData: buffer,
    tags: input.tags ?? [],
    authorId: me.userId,
  })
  logger.info('Wiki file uploaded', { wikiDocumentId: id, fileName: input.file.name, bytes: buffer.length })
  await logActivity({
    userId: me.userId,
    action: 'CREATE',
    entityType: 'wiki_document',
    entityId: id,
    entityName: title,
    after: { title, kind: 'file', fileName: input.file.name, fileSize: buffer.length },
    meta,
  })
  return getWikiDocument(id)
}

export async function updateWikiDoc(
  me: SessionUser,
  id: string,
  input: UpdateWikiDocInput,
  meta: RequestMeta
): Promise<SerializedWikiDocument> {
  const before = await findWikiDocumentById(id)
  if (!before) throw ApiError.notFound('Wiki document not found')
  assertCanEdit(me, { authorId: before.author_id })

  const fields: WikiDocumentUpdateFields = { lastEditedById: me.userId }
  if (input.title !== undefined) fields.title = input.title
  if (input.content !== undefined && before.kind === 'written') {
    fields.content = sanitizeWikiHtml(input.content)
  }
  if (input.tags !== undefined) fields.tags = input.tags

  await updateWikiDocument(id, fields)
  await logActivity({
    userId: me.userId,
    action: 'UPDATE',
    entityType: 'wiki_document',
    entityId: id,
    entityName: fields.title ?? before.title,
    before: { title: before.title, tags: before.tags },
    after: { title: fields.title ?? before.title, tags: fields.tags ?? before.tags },
    meta,
  })
  return getWikiDocument(id)
}

/** Replace the binary of a file document (multipart). Written docs reject this. */
export async function replaceWikiFile(
  me: SessionUser,
  id: string,
  input: WikiUploadInput,
  meta: RequestMeta
): Promise<SerializedWikiDocument> {
  const before = await findWikiDocumentById(id)
  if (!before) throw ApiError.notFound('Wiki document not found')
  assertCanEdit(me, { authorId: before.author_id })
  if (before.kind !== 'file') throw ApiError.badRequest('Only file documents can have their file replaced')
  validateWikiUpload(input.file)
  const buffer = Buffer.from(await input.file.arrayBuffer())

  const fields: WikiDocumentUpdateFields = {
    lastEditedById: me.userId,
    fileName: input.file.name,
    fileType: input.file.type || 'application/octet-stream',
    fileSize: buffer.length,
    fileData: buffer,
  }
  if (input.title?.trim()) fields.title = input.title.trim()
  if (input.tags) fields.tags = input.tags

  await updateWikiDocument(id, fields)
  await logActivity({
    userId: me.userId,
    action: 'UPDATE',
    entityType: 'wiki_document',
    entityId: id,
    entityName: fields.title ?? before.title,
    after: { fileName: fields.fileName, fileSize: buffer.length },
    meta,
  })
  return getWikiDocument(id)
}

export async function deleteWikiDoc(
  me: SessionUser,
  id: string,
  meta: RequestMeta
): Promise<{ success: boolean }> {
  const before = await findWikiDocumentById(id)
  if (!before) throw ApiError.notFound('Wiki document not found')
  // Same rule as single test-case delete: the author may remove their own
  // document; otherwise delete_wiki_doc matrix holders (VP / Manager by
  // default) — runtime-togglable like every other cell.
  const isAuthor = before.author_id === me.userId
  if (!isAuthor && !can(me.role, 'delete_wiki_doc')) {
    throw ApiError.forbidden('Only the author or delete-wiki holders can delete this document')
  }
  const deleted = await deleteWikiDocumentById(id)
  if (!deleted) throw ApiError.notFound('Wiki document not found')
  logger.info('Wiki document deleted', { wikiDocumentId: id, by: me.userId })
  await logActivity({
    userId: me.userId,
    action: 'DELETE',
    entityType: 'wiki_document',
    entityId: id,
    entityName: before.title,
    before: { title: before.title, kind: before.kind },
    meta,
  })
  return { success: true }
}
