// Wiki repository — raw SQL data access for wiki_documents.
// Contains ONLY data access: no permission checks, no business conditionals,
// no HTTP concepts.
//
// FILE BYTES: `file_data` is deliberately excluded from every query here —
// only findWikiFileDataById() reads it (the download route). List/get responses
// never carry megabytes of binary.

import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { insertReturningId } from '@/lib/server/insert'
import type { WikiDocumentSqlRow } from '@/types/sql-rows'

/** Standard JOIN select — document plus author/lastEditedBy refs
 *  (alias convention `<relation>_<column>`, consumed by serializeWikiDocument). */
const WIKI_SELECT = Prisma.sql`
  SELECT w.wiki_document_id, w.title, w.kind, w.content,
    w.file_name, w.file_type, w.file_size, w.tags,
    w.author_id, w.last_edited_by_id, w.created_at, w.updated_at,
    au.user_id AS author_user_id, au.full_name AS author_full_name, au.avatar_url AS author_avatar_url,
    le.user_id AS last_edited_by_user_id, le.full_name AS last_edited_by_full_name, le.avatar_url AS last_edited_by_avatar_url
  FROM wiki_documents w
  LEFT JOIN users au ON au.user_id = w.author_id
  LEFT JOIN users le ON le.user_id = w.last_edited_by_id`

export interface WikiFilters {
  kind?: string
  authorId?: string
  tag?: string
  search?: string
}

function buildWhere(filters: WikiFilters): Prisma.Sql {
  const parts: Prisma.Sql[] = []
  if (filters.kind) parts.push(Prisma.sql`w.kind = ${filters.kind}`)
  if (filters.authorId) parts.push(Prisma.sql`w.author_id = ${filters.authorId}`)
  // Tag filter: JSON string array containment.
  if (filters.tag) parts.push(Prisma.sql`JSON_CONTAINS(w.tags, CAST(${JSON.stringify([filters.tag])} AS JSON))`)
  // LIKE (utf8mb4_unicode_ci) = case-insensitive search across title AND written content.
  if (filters.search) parts.push(Prisma.sql`(w.title LIKE ${`%${filters.search}%`} OR w.content LIKE ${`%${filters.search}%`})`)
  return parts.length ? Prisma.sql`WHERE ${Prisma.join(parts, ' AND ')}` : Prisma.empty
}

export async function countWikiDocuments(filters: WikiFilters): Promise<number> {
  const rows = await db.$queryRaw<{ total: number | bigint }[]>`
    SELECT COUNT(*) AS total FROM wiki_documents w ${buildWhere(filters)}`
  return Number(rows[0]?.total ?? 0)
}

export async function listWikiDocuments(
  filters: WikiFilters,
  limit: number,
  offset: number
): Promise<WikiDocumentSqlRow[]> {
  return db.$queryRaw<WikiDocumentSqlRow[]>(Prisma.sql`
    ${WIKI_SELECT} ${buildWhere(filters)}
    ORDER BY w.updated_at DESC
    LIMIT ${limit} OFFSET ${offset}`)
}

export async function findWikiDocumentById(id: string): Promise<WikiDocumentSqlRow | null> {
  const rows = await db.$queryRaw<WikiDocumentSqlRow[]>`
    ${WIKI_SELECT} WHERE w.wiki_document_id = ${id} LIMIT 1`
  return rows[0] ?? null
}

export interface WikiDocumentInsert {
  title: string
  kind: 'written' | 'file'
  content: string | null
  fileName: string | null
  fileType: string | null
  fileSize: number | null
  fileData: Buffer | null
  tags: string[]
  authorId: string
}

export async function insertWikiDocument(input: WikiDocumentInsert): Promise<string> {
  // MySQL has no RETURNING: insert, take the new key from LAST_INSERT_ID(), return it.
  const id = await insertReturningId(Prisma.sql`
    INSERT INTO wiki_documents
      (title, kind, content, file_name, file_type, file_size, file_data, tags, author_id, created_at, updated_at)
    VALUES
      (${input.title}, ${input.kind}, ${input.content}, ${input.fileName},
       ${input.fileType}, ${input.fileSize}, ${input.fileData},
       CAST(${JSON.stringify(input.tags)} AS JSON), ${input.authorId}, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`)
  return id
}

export interface WikiDocumentUpdateFields {
  title?: string
  content?: string | null
  fileName?: string | null
  fileType?: string | null
  fileSize?: number | null
  fileData?: Buffer | null
  tags?: string[]
  lastEditedById?: string
}

export async function updateWikiDocument(
  id: string,
  fields: WikiDocumentUpdateFields
): Promise<void> {
  const sets: Prisma.Sql[] = [Prisma.sql`updated_at = UTC_TIMESTAMP(3)`]
  if (fields.title !== undefined) sets.push(Prisma.sql`title = ${fields.title}`)
  if (fields.content !== undefined) sets.push(Prisma.sql`content = ${fields.content}`)
  if (fields.fileName !== undefined) sets.push(Prisma.sql`file_name = ${fields.fileName}`)
  if (fields.fileType !== undefined) sets.push(Prisma.sql`file_type = ${fields.fileType}`)
  if (fields.fileSize !== undefined) sets.push(Prisma.sql`file_size = ${fields.fileSize}`)
  if (fields.fileData !== undefined) sets.push(Prisma.sql`file_data = ${fields.fileData}`)
  if (fields.tags !== undefined) sets.push(Prisma.sql`tags = CAST(${JSON.stringify(fields.tags)} AS JSON)`)
  if (fields.lastEditedById !== undefined) sets.push(Prisma.sql`last_edited_by_id = ${fields.lastEditedById}`)
  await db.$queryRaw(Prisma.sql`
    UPDATE wiki_documents SET ${Prisma.join(sets, ', ')} WHERE wiki_document_id = ${id}`)
}

export async function deleteWikiDocumentById(id: string): Promise<boolean> {
  // MySQL DELETE has no RETURNING — $executeRaw returns the affected row count.
  const result = await db.$executeRaw`
    DELETE FROM wiki_documents WHERE wiki_document_id = ${id}`
  return Number(result) > 0
}

/** The ONLY query that reads file bytes (download route). */
export async function findWikiFileDataById(
  id: string
): Promise<{ file_name: string; file_type: string | null; file_data: Buffer } | null> {
  const rows = await db.$queryRaw<{ file_name: string; file_type: string | null; file_data: Buffer }[]>`
    SELECT file_name, file_type, file_data FROM wiki_documents
    WHERE wiki_document_id = ${id} AND kind = 'file' LIMIT 1`
  return rows[0] ?? null
}
