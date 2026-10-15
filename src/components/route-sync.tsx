'use client'

import { Suspense, useEffect } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { viewFromPath, setRouterBridge } from '@/lib/routes'
import { useViewStore } from '@/store'

/**
 * Glue between the Next router and the view store — mount once in the root
 * layout. Two jobs:
 *  1. Registers the router so store.navigate() can push real URLs.
 *  2. On every URL change (in-app navigation, back/forward, deep links,
 *     hard loads) derives the active view + params from the URL and syncs
 *     the store, so all views keep reading `useViewStore` unchanged.
 * The query string is part of the contract (e.g. /test-cases?moduleId=…),
 * hence useSearchParams — wrapped in Suspense because static pages bail out
 * to the server otherwise.
 */
export function RouteSync() {
  return (
    <Suspense fallback={null}>
      <RouteSyncInner />
    </Suspense>
  )
}

function RouteSyncInner() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const router = useRouter()

  useEffect(() => {
    setRouterBridge(router)
    return () => setRouterBridge(null)
  }, [router])

  useEffect(() => {
    const match = viewFromPath(pathname, searchParams.toString())
    if (!match) return
    const state = useViewStore.getState()
    // Deep-compare instead of matching only the path id: two navigations can
    // share a pathname but differ in filters (/test-cases?moduleId=A vs B).
    if (
      state.current !== match.current ||
      JSON.stringify(state.params) !== JSON.stringify(match.params)
    ) {
      useViewStore.setState({ current: match.current, params: match.params })
    }
  }, [pathname, searchParams])

  return null
}
