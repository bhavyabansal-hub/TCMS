'use client'

import { ModuleDetailView } from '@/components/views/module-detail'

/** /modules/[id] — permanent module page. The id is picked up from the URL by
 *  RouteSync; logged-out visitors are bounced to /login?next=/modules/<id> by
 *  the app shell and land back here after signing in. */
export default function Page() {
  return <ModuleDetailView />
}
