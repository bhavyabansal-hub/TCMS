'use client'

import { ReviewDetailView } from '@/components/views/review-detail'

/** /reviews/[id] — the id is picked up from the URL by RouteSync. */
export default function Page() {
  return <ReviewDetailView />
}
