'use client'

import { DashboardViewV2 } from '@/components/views/dashboard-v2'

// /dashboard — the QA Command Center (approved redesign). The legacy classic
// view stays available in components/views/dashboard.tsx and the original
// side-by-side review route remains at /dashboard-preview.
export default function Page() {
  return <DashboardViewV2 />
}
