'use client'

import { TestCaseDetailView } from '@/components/views/test-case-detail'

/** /test-cases/[id] — the id is picked up from the URL by RouteSync. */
export default function Page() {
  return <TestCaseDetailView />
}
