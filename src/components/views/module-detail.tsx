'use client'

import { useInfiniteQuery } from '@tanstack/react-query'
import { ArrowLeft, FolderOpen, ListChecks, Loader2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { REFERENCE_STALE_TIME_MS, modulesApi } from '@/lib/client/api'
import { useViewStore } from '@/store'
import { formatDateTime, statusColor } from '@/lib/format'
import { PriorityBadge, StatusBadge } from '@/components/shared/badges'
import { DetailLoadError } from '@/components/shared/query-error'

/**
 * /modules/<id> — permanent module page. Shows the test cases of the WHOLE
 * module tree: the module's own cases plus everything inherited from its
 * submodules (a parent module usually holds zero direct cases, which used to
 * make this page look empty when opened from a Crew Desk comment link).
 * Large trees are paginated (100 per page, "Load more") so 500+ case modules
 * stay fast. Reuses the existing modules API (role permissions are enforced
 * server-side; this page is read-only). Logged-out visitors are bounced to
 * /login?next=/modules/<id> by the app shell and return here after login.
 * This is the URL a Crew Desk comment points back to.
 */
export function ModuleDetailView() {
  const { params, navigate } = useViewStore()
  const id = params.id

  const {
    data, isLoading, isError, refetch,
    fetchNextPage, hasNextPage, isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['modules', 'detail-tree', id],
    queryFn: ({ pageParam }) => modulesApi.get(id, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last) =>
      last.casePage.hasMore ? last.casePage.offset + last.subtreeTestCases.length : undefined,
    enabled: !!id,
    staleTime: REFERENCE_STALE_TIME_MS,
    // retries: global policy (a 403/404 is never retried — no duplicate call)
  })

  if (!id) {
    return (
      <div className="space-y-4">
        <BackToModules />
        <p className="text-sm text-muted-foreground">No module id in the URL.</p>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  const first = data?.pages[0]

  if (isError || !first?.module) {
    return (
      <div className="space-y-4">
        <BackToModules />
        <DetailLoadError title="Module could not be loaded" onRetry={() => refetch()} />
      </div>
    )
  }

  const { module: mod, casePage, submodules } = first
  // Flatten the aggregated (subtree) pages — this is the list we render.
  const testCases = data?.pages.flatMap((page) => page.subtreeTestCases) ?? []
  const inSubmodules = casePage.total - casePage.directTotal
  // The Module column only earns its space when cases actually come from
  // more than one module in the tree.
  const showModuleColumn = inSubmodules > 0 || submodules.length > 0

  return (
    <div className="space-y-6">
      <BackToModules />

      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <FolderOpen className="h-6 w-6 text-muted-foreground" aria-hidden />
            {mod.name}
          </h1>
          {mod.description && <p className="max-w-3xl text-sm text-muted-foreground">{mod.description}</p>}
          <p className="text-xs text-muted-foreground">
            {mod.owner && <>Owner: {mod.owner.fullName} · </>}
            {casePage.total} test case{casePage.total === 1 ? '' : 's'} in this module
            {inSubmodules > 0 && (
              <span className="ml-1">
                ({casePage.directTotal} direct · {inSubmodules} in {submodules.length} submodule{submodules.length === 1 ? '' : 's'})
              </span>
            )}
          </p>
        </div>
        {/* Bridge to the Test Cases page with this module pre-filtered —
            same deep link the modules panel's "View all" uses. */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => navigate('test-cases', { moduleId: mod.moduleId })}
        >
          View all →
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ListChecks className="h-4 w-4" aria-hidden />
            Test cases
          </CardTitle>
          <CardDescription>
            Every test case in this module and its submodules. The Crew Desk comment for a link points to this page.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {testCases.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">This module has no test cases yet.</p>
          ) : (
            <div className="space-y-3">
              <div className="max-h-[32rem] overflow-y-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {showModuleColumn && <TableHead>Module</TableHead>}
                      <TableHead>Title</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Priority</TableHead>
                      <TableHead>Author</TableHead>
                      <TableHead>Updated</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {testCases.map((tc) => (
                      <TableRow
                        key={tc.testCaseId}
                        className="cursor-pointer"
                        onClick={() => navigate('test-case-detail', { id: tc.testCaseId })}
                      >
                        {showModuleColumn && (
                          <TableCell className="max-w-44 truncate text-muted-foreground">
                            {tc.moduleId === mod.moduleId ? 'This module' : tc.module?.name ?? '—'}
                          </TableCell>
                        )}
                        <TableCell className="max-w-72 truncate font-medium">{tc.title}</TableCell>
                        <TableCell><StatusBadge status={tc.status} colorClass={statusColor(tc.status)} /></TableCell>
                        <TableCell><PriorityBadge priority={tc.priority} /></TableCell>
                        <TableCell className="text-muted-foreground">{tc.author?.fullName ?? '—'}</TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(tc.updatedAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {(hasNextPage || casePage.total > testCases.length) && (
                <div className="flex items-center justify-center gap-3">
                  <span className="text-xs text-muted-foreground">
                    Showing {testCases.length} of {casePage.total}
                  </span>
                  {hasNextPage && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isFetchingNextPage}
                      onClick={() => fetchNextPage()}
                    >
                      {isFetchingNextPage && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                      Load more
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function BackToModules() {
  const navigate = useViewStore((s) => s.navigate)
  return (
    <Button type="button" variant="ghost" size="sm" className="w-fit gap-1 px-2" onClick={() => navigate('modules')}>
      <ArrowLeft className="h-4 w-4" aria-hidden />
      All modules
    </Button>
  )
}
