'use client'

// Global search (Ctrl/Cmd+K) — searches modules, test cases and bugs from
// anywhere in the app and jumps straight to them. PURELY ADDITIVE: it only
// adds a keyboard shortcut + an overlay dialog; no existing view, route or
// API behavior is modified. Results reuse the same data the user can already
// reach on the list pages (server endpoint is requireUser-gated).

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  Search,
  Folder,
  ListChecks,
  Bug as BugIcon,
  Loader2,
  CornerDownLeft,
  LayoutDashboard,
  ClipboardList,
  FileBarChart,
  History,
  ShieldCheck,
  ArrowRight,
  BookOpen,
} from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { searchApi } from '@/lib/client/api'
import { useViewStore, type ViewKey } from '@/store'
import { cn } from '@/lib/utils'
import type { GlobalSearchResult } from '@/types'

interface SearchTarget {
  key: string
  label: string
  sublabel?: string
  icon: ReactNode
  badge?: string
  view: ViewKey
  params?: Record<string, string>
}

/** Quick navigation shortcuts — always available, even before typing. */
const QUICK_LINKS: { label: string; view: ViewKey; icon: ReactNode }[] = [
  { label: 'Dashboard', view: 'dashboard', icon: <LayoutDashboard className="h-4 w-4" /> },
  { label: 'Modules', view: 'modules', icon: <Folder className="h-4 w-4" /> },
  { label: 'Test Cases', view: 'test-cases', icon: <ListChecks className="h-4 w-4" /> },
  { label: 'Wiki', view: 'wiki', icon: <BookOpen className="h-4 w-4" /> },
  { label: 'Bugs', view: 'bugs', icon: <BugIcon className="h-4 w-4" /> },
  { label: 'Reviews', view: 'reviews', icon: <ShieldCheck className="h-4 w-4" /> },
  { label: 'Tasks', view: 'tasks', icon: <ClipboardList className="h-4 w-4" /> },
  { label: 'Reports', view: 'reports', icon: <FileBarChart className="h-4 w-4" /> },
  { label: 'Activity Log', view: 'activity-log', icon: <History className="h-4 w-4" /> },
]

const GROUP_ICONS = {
  module: <Folder className="h-4 w-4" />,
  testCase: <ListChecks className="h-4 w-4" />,
  bug: <BugIcon className="h-4 w-4" />,
  wiki: <BookOpen className="h-4 w-4" />,
} as const

const GROUP_ICON_STYLE: Record<keyof typeof GROUP_ICONS, string> = {
  module: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  testCase: 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
  bug: 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
  wiki: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
}

export function GlobalSearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="sm:max-w-xl top-[12%] translate-y-0 gap-0 p-0 overflow-hidden"
      >
        <DialogTitle className="sr-only">Global search</DialogTitle>
        {/* Rendered only while open, so every open starts from a FRESH palette
            (query, debounce and highlight reset by unmount — no effects needed). */}
        {open && <SearchPalette onOpenChange={onOpenChange} />}
      </DialogContent>
    </Dialog>
  )
}

function SearchPalette({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const navigate = useViewStore((s) => s.navigate)
  const [raw, setRaw] = useState('')
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  // Hover-selection guard: when the palette opens under a stationary cursor,
  // the browser fires a synthetic mouseenter for whatever row happens to be
  // under it — that must NOT hijack the keyboard highlight. Selection by
  // hover only turns on after a REAL pointer movement inside the list.
  const pointerMovedRef = useRef(false)

  // Debounce the typed value into the actual query (250ms) so typing
  // "checkout" fires 1 request, not 8.
  useEffect(() => {
    const t = setTimeout(() => setQuery(raw.trim()), 250)
    return () => clearTimeout(t)
  }, [raw])

  const hasQuery = query.length >= 2

  const { data, isLoading, isError } = useQuery<GlobalSearchResult>({
    queryKey: ['global-search', query],
    queryFn: () => searchApi.global(query),
    enabled: hasQuery,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  })

  const targets = useMemo<SearchTarget[]>(() => {
    const links: SearchTarget[] = QUICK_LINKS.filter(
      (l) => !raw.trim() || l.label.toLowerCase().includes(raw.trim().toLowerCase())
    ).map((l) => ({ key: `go:${l.view}`, label: l.label, icon: l.icon, view: l.view }))

    if (!hasQuery || !data) return links

    const modules: SearchTarget[] = data.modules.map((m) => ({
      key: `module:${m.moduleId}`,
      label: m.name,
      sublabel: 'Module',
      icon: GROUP_ICONS.module,
      // Jump straight into the module's own page (info + its test cases +
      // the "View all" bridge to the pre-filtered test-cases list).
      view: 'module-detail',
      params: { id: m.moduleId },
    }))
    const cases: SearchTarget[] = data.testCases.map((tc) => ({
      key: `tc:${tc.testCaseId}`,
      label: tc.title,
      sublabel: tc.moduleName ?? 'Test Case',
      badge: tc.status,
      icon: GROUP_ICONS.testCase,
      view: 'test-case-detail',
      params: { id: tc.testCaseId },
    }))
    const bugs: SearchTarget[] = data.bugs.map((b) => ({
      key: `bug:${b.bugId}`,
      label: b.title,
      sublabel: 'Bug',
      badge: b.status,
      icon: GROUP_ICONS.bug,
      view: 'bugs',
    }))
    const wiki: SearchTarget[] = (data.wiki ?? []).map((w) => ({
      key: `wiki:${w.wikiDocumentId}`,
      label: w.title,
      sublabel: w.kind === 'file' ? 'Wiki — uploaded file' : 'Wiki — document',
      icon: GROUP_ICONS.wiki,
      view: 'wiki-doc',
      params: { id: w.wikiDocumentId },
    }))
    return [...links, ...modules, ...cases, ...bugs, ...wiki]
  }, [raw, hasQuery, data])

  // Clamp the highlight during render instead of an effect — the list can
  // shrink any time and the state must never point past the last row.
  const maxIndex = Math.max(0, targets.length - 1)
  const active = Math.min(activeIndex, maxIndex)

  // Scroll the keyboard-highlighted row into view (no jumpiness for mouse users).
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  function go(target: SearchTarget) {
    onOpenChange(false)
    navigate(target.view, target.params)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (targets.length ? (Math.min(i, maxIndex) + 1) % targets.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) =>
        targets.length ? (Math.min(i, maxIndex) - 1 + targets.length) % targets.length : 0
      )
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = targets[active]
      if (target) go(target)
    }
  }

  return (
    <>
      {/* Input row */}
        <div className="flex items-center gap-3 border-b px-4">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={onKeyDown}
            placeholder="Search modules, test cases, bugs…"
            maxLength={100}
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            aria-label="Search"
          />
          <kbd className="hidden sm:inline-flex h-5 items-center rounded border bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div
          ref={listRef}
          className="max-h-96 overflow-y-auto p-2"
          role="listbox"
          aria-label="Search results"
          onMouseMove={() => {
            pointerMovedRef.current = true
          }}
        >
          {hasQuery && isLoading && (
            <div className="flex items-center gap-2 px-3 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Searching…
            </div>
          )}

          {hasQuery && isError && (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              Search failed — check your connection and try again.
            </div>
          )}

          {hasQuery && !isLoading && !isError && data?.empty && targets.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              No matches for “{query}”
            </div>
          )}

          {targets.map((t, i) => {
            // Section headers derived purely from the item key — an item shows
            // a header when its group differs from the previous item's group
            // (no render-phase mutation, React-safe).
            const thisSection = sectionOfTarget(t)
            const prevSection = i > 0 ? sectionOfTarget(targets[i - 1]) : null
            const showHeader = thisSection !== prevSection
            const isActive = i === active
            return (
              <div key={t.key}>
                {showHeader && (
                  <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {thisSection}
                  </div>
                )}
                <button
                  data-index={i}
                  role="option"
                  aria-selected={isActive}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors',
                    isActive && 'bg-accent'
                  )}
                  onMouseEnter={() => {
                    if (pointerMovedRef.current) setActiveIndex(i)
                  }}
                  onClick={() => go(t)}
                >
                  <span
                    className={cn(
                      'flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
                      thisSection === 'Go to'
                        ? 'bg-muted text-muted-foreground'
                        : GROUP_ICON_STYLE[
                            thisSection === 'Modules' ? 'module' : thisSection === 'Test Cases' ? 'testCase' : thisSection === 'Wiki' ? 'wiki' : 'bug'
                          ]
                    )}
                  >
                    {t.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{t.label}</span>
                    {t.sublabel && (
                      <span className="block truncate text-xs text-muted-foreground">{t.sublabel}</span>
                    )}
                  </span>
                  {t.badge && (
                    <Badge variant="outline" className="shrink-0 text-[10px] capitalize">
                      {t.badge.replace('_', ' ')}
                    </Badge>
                  )}
                  {isActive && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                </button>
              </div>
            )
          })}

          {!hasQuery && targets.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              Type at least 2 characters to search.
            </div>
          )}
        </div>

        {/* Footer hints */}
        <div className="flex items-center gap-4 border-t px-4 py-2 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <kbd className="rounded border bg-muted px-1">↑</kbd>
            <kbd className="rounded border bg-muted px-1">↓</kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border bg-muted px-1">↵</kbd> open
          </span>
          <span className="ml-auto flex items-center gap-1">
            <ArrowRight className="h-3 w-3" /> jumps to the item’s page
          </span>
        </div>
    </>
  )
}

/** Group label for a target — quick links, then the entity types. */
function sectionOfTarget(t: SearchTarget): 'Go to' | 'Modules' | 'Test Cases' | 'Bugs' | 'Wiki' {
  if (t.key.startsWith('module:')) return 'Modules'
  if (t.key.startsWith('tc:')) return 'Test Cases'
  if (t.key.startsWith('bug:')) return 'Bugs'
  if (t.key.startsWith('wiki:')) return 'Wiki'
  return 'Go to'
}
