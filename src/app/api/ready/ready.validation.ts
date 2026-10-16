// Validation layer for the readiness probe. GET /api/ready takes no input; unknown
// query parameters (some load balancers add cache-busters) are stripped, never an error.

import { z } from 'zod'

const readyQuerySchema = z.object({})

export function validateReadyQuery(query: Record<string, string>) {
  return readyQuerySchema.parse(query)
}
