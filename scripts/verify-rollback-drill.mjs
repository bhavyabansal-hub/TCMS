// One-off rollback-drill verifier: compares row counts between the scratch
// restore DB and the live DB, then drops the scratch. Part of the drill in
// docs/17-operations-runbook.md (backup -> restore --database tcms_drill ->
// this check -> drop).
import { PrismaClient } from '@prisma/client'

const LIVE_URL = process.env.DATABASE_URL
if (!LIVE_URL?.startsWith('postgres')) {
  console.error('DATABASE_URL must be a postgres URL'); process.exit(1)
}
const BASE = LIVE_URL.split('?')[0]
const drill = new PrismaClient({ datasourceUrl: `${BASE.replace(/\/tcms$/, '')}/tcms_drill?sslmode=disable` })
const live = new PrismaClient({ datasourceUrl: LIVE_URL })

const MODELS = ['user', 'testCase', 'bug', 'notification', 'activityLog', 'reviewRequest']
try {
  let allMatch = true
  for (const m of MODELS) {
    const d = await drill[m].count()
    const l = await live[m].count()
    const ok = d === l
    if (!ok) allMatch = false
    console.log(m.padEnd(14), 'drill:', String(d).padStart(6), 'live:', String(l).padStart(6), ok ? 'MATCH' : 'DIFF')
  }
  console.log(allMatch ? 'INDEPENDENT COUNT CHECK: all tables MATCH' : 'COUNT MISMATCH DETECTED')
  await drill.$disconnect()
  const admin = new PrismaClient({ datasourceUrl: `${BASE.replace(/\/tcms$/, '')}/postgres?sslmode=disable` })
  await admin.$executeRawUnsafe('DROP DATABASE IF EXISTS tcms_drill')
  console.log('scratch database tcms_drill DROPPED (rollback drill complete)')
  await admin.$disconnect()
} catch (e) {
  console.error(e.message); process.exit(1)
} finally {
  await live.$disconnect().catch(() => {})
}
