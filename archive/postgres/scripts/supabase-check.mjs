// Supabase connection checker for TCMS.
//
// Validates a Supabase (or any postgres) connection string for the three TCMS
// roles — app runtime (DATABASE_URL), migrations/tooling (DIRECT_URL), and the
// backup scheduler — and, with --probe, connects and reports the database's
// real connection capacity (max_connections vs current usage), which is the
// number that decides whether 200 concurrent USERS are safe (they are: the app
// bounds its Prisma pool via connection_limit, so 200 VU never means 200 DB
// connections — see docs/16-single-instance-and-scaling.md).
//
// Usage:
//   node scripts/supabase-check.mjs "<postgres-url>" [--probe]
//
// Env alternative: SUPABASE_DATABASE_URL
import { PrismaClient } from '@prisma/client'

const raw = process.argv[2] || process.env.SUPABASE_DATABASE_URL || ''
const probe = process.argv.includes('--probe')
const mask = (u) => u.replace(/\/\/[^@]+@/, '//***@')

if (!raw.startsWith('postgres')) {
  console.error('Usage: node scripts/supabase-check.mjs "<postgres-url>" [--probe]')
  console.error('  (a postgres:// or postgresql:// URL — Supabase Dashboard -> Connect)')
  process.exit(1)
}

console.log(`URL: ${mask(raw)}`)

// ---------- classify the endpoint ----------
let url
try {
  url = new URL(raw)
} catch {
  console.error('INVALID: not a parseable URL')
  process.exit(1)
}
const host = url.hostname
const port = url.port || '5432'
const params = url.searchParams
const isSupabasePooler = host.endsWith('.pooler.supabase.com')
const isSupabaseDirect = /^db\.[a-z0-9]{20}\.supabase\.(co|com)$/.test(host)

console.log(`\nhost: ${host}:${port}`)
if (isSupabaseDirect) {
  console.log('  DIRECT Supabase hostname — IPv6-only since 2024; fails on IPv4-only hosts.')
  console.log('  Use the POOLER hostnames instead (Dashboard -> Connect -> Session/Transaction pooler).')
} else if (isSupabasePooler) {
  if (port === '6543') {
    console.log('  Supabase TRANSACTION pooler (PgBouncer, transaction mode).')
    console.log('  -> the right DATABASE_URL for the app; requires pgbouncer=true for Prisma.')
  } else if (port === '5432') {
    console.log('  Supabase SESSION pooler — works over IPv4; good for DIRECT_URL (migrations, restore tools).')
  }
} else {
  console.log('  not a recognized Supabase hostname (local or other provider) — checks still apply.')
}

const issues = []
if (!params.has('sslmode')) issues.push('add sslmode=require (Supabase enforces TLS)')
if (!params.has('connection_limit')) issues.push('add connection_limit=40 for the app (bounds the Prisma pool)')
if (!params.has('pool_timeout')) issues.push('add pool_timeout=10 (busy requests queue instead of erroring)')
if (port === '6543' && params.get('pgbouncer') !== 'true') issues.push('transaction pooler REQUIRES pgbouncer=true for Prisma')
if (issues.length) {
  console.log('\nmissing/needed query params:')
  for (const i of issues) console.log(`  - ${i}`)
} else {
  console.log('\nquery params look complete.')
}

const u = new URL(raw)
console.log('\nrecommended strings (keep the same project ref/password):')
if (isSupabasePooler || isSupabaseDirect) {
  // Pooler hostnames carry only the region (aws-0-<region>.pooler.supabase.com);
  // the project ref lives in the username (postgres.<ref>) or the db.*.supabase.co host.
  const region = (host.match(/^aws-0-([a-z0-9-]+)\./) || [])[1] || '<region>'
  const ref = isSupabaseDirect
    ? host.split('.')[1]
    : (u.username.replace(/^postgres\./, '') || '<project-ref>')
  console.log(`  DATABASE_URL (app) = postgresql://postgres.${ref}:[PASSWORD]@aws-0-${region}.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=40&pool_timeout=10&sslmode=require`)
  console.log(`  DIRECT_URL (tools) = postgresql://postgres.${ref}:[PASSWORD]@aws-0-${region}.pooler.supabase.com:5432/postgres?sslmode=require`)
  console.log(`  backup scheduler   = BACKUP_DATABASE_URL '<DIRECT_URL above>'  (scheduler adds connection_limit=5 itself)`)
} else {
  console.log(`  (non-Supabase host — keep the current URL; the scheduler cap logic still applies)`)
}

// ---------- optional live probe ----------
if (!probe) {
  console.log('\n(--probe not given — no connection attempt)')
  process.exit(0)
}

const probeUrl = raw + (raw.includes('?') ? '&' : '?') + 'connection_limit=2'
const db = new PrismaClient({
  datasources: { db: { url: probeUrl } },
})
try {
  const ver = await db.$queryRawUnsafe('SELECT version() AS v')
  const maxc = await db.$queryRawUnsafe('SHOW max_connections')
  const used = await db.$queryRawUnsafe(
    'SELECT count(*)::int AS n, COALESCE(application_name, \'-\') AS app FROM pg_stat_activity WHERE datname = current_database() GROUP BY 2 ORDER BY 1 DESC'
  )
  const dbname = await db.$queryRawUnsafe('SELECT current_database() AS d')
  console.log(`\nLIVE PROBE OK — database "${dbname[0].d}"`)
  console.log(`  ${String(ver[0].v).split(',')[0]}`)
  console.log(`  max_connections = ${maxc[0].max_connections}`)
  const total = used.reduce((s, r) => s + r.n, 0)
  for (const r of used) console.log(`  in-use: ${r.n} x app=${r.app}`)
  console.log(`  current usage: ${total} / ${maxc[0].max_connections}`)
  console.log(`  TCMS app headroom at connection_limit=40: ${maxc[0].max_connections - total >= 45 ? 'SAFE' : 'CHECK'} (app pool 40 + backup 5 + tools ~5)`)
} catch (err) {
  console.error(`\nPROBE FAILED: ${err.message}`)
  process.exitCode = 1
} finally {
  await db.$disconnect()
}
