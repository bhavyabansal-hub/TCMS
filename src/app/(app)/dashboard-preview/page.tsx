'use client'

import { DashboardViewV2 } from '@/components/views/dashboard-v2'

// PREVIEW ROUTE — the redesigned dashboard ("QA Command Center").
// Served at /dashboard-preview purely for side-by-side review against the
// current /dashboard. Once approved, this component replaces DashboardView
// on /dashboard and this route is removed.
export default function Page() {
  return <DashboardViewV2 />
}
