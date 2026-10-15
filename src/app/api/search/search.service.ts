// Service for the global search — orchestrates the three entity lookups in
// parallel and shapes camelCase results for the client. No permissions
// filtering needed beyond "is signed in": every authenticated user may see
// modules/test cases/bugs lists today (page-level gates handle actions), so
// search surfaces the same data they can already reach.

import {
  searchBugs,
  searchModules,
  searchTestCases,
  searchWikiDocuments,
  type BugSearchRow,
  type ModuleSearchRow,
  type TestCaseSearchRow,
  type WikiSearchRow,
} from './search.repository'

export interface GlobalSearchResult {
  modules: { moduleId: string; name: string; path: string }[]
  testCases: {
    testCaseId: string
    title: string
    status: string
    priority: string
    moduleName: string | null
  }[]
  bugs: { bugId: string; title: string; status: string; severity: string }[]
  wiki: { wikiDocumentId: string; title: string; kind: string }[]
  /** True when every group came back empty — the UI shows a friendly empty state. */
  empty: boolean
}

const toModule = (r: ModuleSearchRow) => ({ moduleId: r.module_id, name: r.name, path: r.path })

const toTestCase = (r: TestCaseSearchRow) => ({
  testCaseId: r.test_case_id,
  title: r.title,
  status: r.status,
  priority: r.priority,
  moduleName: r.module_name,
})

const toBug = (r: BugSearchRow) => ({
  bugId: r.bug_id,
  title: r.title,
  status: r.status,
  severity: r.severity,
})

const toWikiDoc = (r: WikiSearchRow) => ({
  wikiDocumentId: r.wiki_document_id,
  title: r.title,
  kind: r.kind,
})

export async function globalSearch(term: string, limit: number): Promise<GlobalSearchResult> {
  const [modules, testCases, bugs, wiki] = await Promise.all([
    searchModules(term, limit),
    searchTestCases(term, limit),
    searchBugs(term, limit),
    searchWikiDocuments(term, limit),
  ])

  return {
    modules: modules.map(toModule),
    testCases: testCases.map(toTestCase),
    bugs: bugs.map(toBug),
    wiki: wiki.map(toWikiDoc),
    empty:
      modules.length === 0 && testCases.length === 0 && bugs.length === 0 && wiki.length === 0,
  }
}
