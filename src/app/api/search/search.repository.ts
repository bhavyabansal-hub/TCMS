// Repository for the global search — read-only SQL across the three main
// entities (modules, test cases, bugs). Mirrors the LIKE conventions used
// by the per-page list filters (LIKE on utf8mb4_unicode_ci = case-insensitive
// substring match).

import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'

export interface ModuleSearchRow {
  module_id: string
  name: string
  path: string
}

export interface TestCaseSearchRow {
  test_case_id: string
  title: string
  status: string
  priority: string
  module_name: string | null
}

export interface BugSearchRow {
  bug_id: string
  title: string
  status: string
  severity: string
}

export interface WikiSearchRow {
  wiki_document_id: string
  title: string
  kind: string
}

export async function searchModules(term: string, limit: number): Promise<ModuleSearchRow[]> {
  return db.$queryRaw<ModuleSearchRow[]>(Prisma.sql`
    SELECT m.module_id, m.name, m.path
    FROM modules m
    WHERE m.name LIKE ${`%${term}%`}
    ORDER BY m.name
    LIMIT ${limit}`
  )
}

export async function searchTestCases(term: string, limit: number): Promise<TestCaseSearchRow[]> {
  return db.$queryRaw<TestCaseSearchRow[]>(Prisma.sql`
    SELECT tc.test_case_id, tc.title, tc.status, tc.priority, m.name AS module_name
    FROM test_cases tc
    LEFT JOIN modules m ON m.module_id = tc.module_id
    WHERE tc.title LIKE ${`%${term}%`}
    ORDER BY tc.updated_at DESC
    LIMIT ${limit}`
  )
}

export async function searchBugs(term: string, limit: number): Promise<BugSearchRow[]> {
  return db.$queryRaw<BugSearchRow[]>(Prisma.sql`
    SELECT b.bug_id, b.title, b.status, b.severity
    FROM bugs b
    WHERE b.title LIKE ${`%${term}%`}
    ORDER BY b.updated_at DESC
    LIMIT ${limit}`
  )
}

export async function searchWikiDocuments(term: string, limit: number): Promise<WikiSearchRow[]> {
  return db.$queryRaw<WikiSearchRow[]>(Prisma.sql`
    SELECT w.wiki_document_id, w.title, w.kind
    FROM wiki_documents w
    WHERE w.title LIKE ${`%${term}%`}
    ORDER BY w.updated_at DESC
    LIMIT ${limit}`
  )
}
