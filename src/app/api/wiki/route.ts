// Controller for /api/wiki — thin HTTP adapter.
// Parses the request, delegates to validators + services, returns responses.
// NO business logic and NO SQL live here.
//
//   GET    /api/wiki                          -> paginated list (search/kind/tag filters)
//   GET    /api/wiki?id=...                   -> single document (NO file bytes)
//   GET    /api/wiki?id=...&action=download   -> the uploaded file (attachment)
//   POST   /api/wiki                          -> create written doc (JSON)
//   POST   /api/wiki?action=upload            -> create file doc (multipart)
//   PUT    /api/wiki?id=...                   -> update title/content/tags (JSON)
//   PUT    /api/wiki?id=...&action=upload     -> replace the file of a file doc (multipart)
//   DELETE /api/wiki?id=...                   -> delete (author OR delete_wiki_doc)

import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { withApi, ok, ApiError, getQueryParams, extractRequestMeta } from '@/lib/api'
import { requireUser } from '@/lib/auth'
import {
  createUploadedWikiDoc,
  createWrittenWikiDoc,
  deleteWikiDoc,
  getWikiDocument,
  getWikiFileDownload,
  listWikiPaginated,
  replaceWikiFile,
  updateWikiDoc,
  type WikiUploadInput,
} from './wiki.service'
import { validateCreateWikiDocBody, validateUpdateWikiDocBody } from './wiki.validation'

/** Parses the shared multipart fields for upload requests. */
async function parseUploadForm(req: NextRequest): Promise<WikiUploadInput> {
  const form = await req.formData().catch(() => null)
  if (!form) throw ApiError.badRequest('Expected multipart/form-data with a "file" field')
  const file = form.get('file')
  if (!(file instanceof File)) throw ApiError.badRequest('Missing "file" field')
  const title = form.get('title')
  const rawTags = form.get('tags')
  let tags: string[] | undefined
  if (typeof rawTags === 'string' && rawTags.trim()) {
    try {
      const parsed = JSON.parse(rawTags)
      if (Array.isArray(parsed)) tags = parsed.map(String)
    } catch {
      tags = rawTags.split(',').map((t) => t.trim()).filter(Boolean)
    }
  }
  return { file, title: typeof title === 'string' ? title : undefined, tags }
}

export async function GET(req: NextRequest) {
  return withApi(req, async () => {
    await requireUser()
    const q = getQueryParams(req)
    if (q.id && q.action === 'download') {
      const file = await getWikiFileDownload(q.id)
      // attachment disposition: files always download (never render in-app),
      // so even SVG/HTML uploads cannot execute inside the app origin.
      return new NextResponse(new Uint8Array(file.body), {
        status: 200,
        headers: {
          'Content-Type': file.fileType,
          'Content-Disposition': `attachment; filename="${encodeURIComponent(file.fileName)}"`,
          'Cache-Control': 'no-store, must-revalidate',
        },
      })
    }
    if (q.id) return ok(await getWikiDocument(q.id))
    return ok(await listWikiPaginated(q))
  })
}

export async function POST(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const { action } = getQueryParams(req)
    if (action === 'upload') {
      const input = await parseUploadForm(req)
      return ok(await createUploadedWikiDoc(me, input, extractRequestMeta(req)))
    }
    const body = await req.json().catch(() => ({}))
    const input = validateCreateWikiDocBody(body)
    return ok(await createWrittenWikiDoc(me, input, extractRequestMeta(req)))
  })
}

export async function PUT(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const { id, action } = getQueryParams(req)
    if (!id) throw ApiError.badRequest('Missing wiki document id')
    if (action === 'upload') {
      const input = await parseUploadForm(req)
      return ok(await replaceWikiFile(me, id, input, extractRequestMeta(req)))
    }
    const body = await req.json().catch(() => ({}))
    const input = validateUpdateWikiDocBody(body)
    return ok(await updateWikiDoc(me, id, input, extractRequestMeta(req)))
  })
}

export async function DELETE(req: NextRequest) {
  return withApi(req, async () => {
    const me = await requireUser()
    const { id } = getQueryParams(req)
    if (!id) throw ApiError.badRequest('Missing wiki document id')
    return ok(await deleteWikiDoc(me, id, extractRequestMeta(req)))
  })
}
