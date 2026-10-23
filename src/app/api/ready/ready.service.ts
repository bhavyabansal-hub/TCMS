// Readiness service — "can this instance serve real traffic right now?" (backlog B5).
// GET /api (liveness) only proves the Node process is up; this also proves the database
// answers within READY_DB_TIMEOUT_MS. Load balancers and the go-live checklist use it.

import { ApiError } from '@/lib/api'
import { logger } from '@/lib/logger'
import { READ_ONLY } from '@/lib/server/config'
import { pingDatabase } from './ready.repository'

const READY_DB_TIMEOUT_MS = 3_000

export interface ReadinessReport {
  status: 'ready'
  database: 'ok'
  databaseLatencyMs: number
  readOnly: boolean
}

export async function checkReadiness(): Promise<ReadinessReport> {
  const startedAt = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('database ping timed out')), READY_DB_TIMEOUT_MS)
  })
  try {
    await Promise.race([pingDatabase(), timeout])
  } catch (err) {
    logger.error('Readiness check failed: database not answering', err)
    throw new ApiError(503, 'Not ready: the database is not answering')
  } finally {
    clearTimeout(timer)
  }
  return { status: 'ready', database: 'ok', databaseLatencyMs: Date.now() - startedAt, readOnly: READ_ONLY }
}
