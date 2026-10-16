#!/usr/bin/env node
// Persistent CODING-STANDARDS auditor (`docs/CODING-STANDARDS.md` §2) — the 14 user standards
// encoded as greppable rules over src/. Run from the project root:
//   node scripts/audit-standards.mjs
//   node scripts/audit-standards.mjs --self-test   (naming-rule check, reads no files)
// Exit code 1 when any violation is found (CI / pre-delivery gate).

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')

// Naming rule (7): kebab-case file names, dot-separated segments validated
// separately (e.g. auth.service.ts). Returns the offending base name or null.
// win32.basename splits on both \ and /, so the result is the same on Windows
// and POSIX (backlog B12: split('/') returned the whole path on Windows).
function namingViolation(file) {
  const base = win32.basename(file)
  const segments = base.replace(/\.(?:ts|tsx)$/, '').split('.')
  return segments.every((s) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)) ? null : base
}

// --self-test: runs namingViolation (the same function the audit uses) on
// fixed samples. Touches no file. Prints PASS=n FAIL=n; exit 1 on any failure.
if (process.argv.includes('--self-test')) {
  const samples = [
    ['BadName.ts', 'BadName.ts'],
    ['bad_name.service.ts', 'bad_name.service.ts'],
    ['src\\components\\views\\BadName.tsx', 'BadName.tsx'],
    ['src/components/views/BadName.tsx', 'BadName.tsx'],
    ['C:\\dev\\tcms\\src\\components\\views\\BadName.tsx', 'BadName.tsx'],
    ['test-cases.service.ts', null],
    ['page.tsx', null],
    ['src\\app\\api\\test-cases\\test-cases.service.ts', null],
    ['src/app/api/test-cases/test-cases.service.ts', null],
    ['src\\app\\(app)\\activity-log\\page.tsx', null],
    ['C:\\dev\\tcms\\src\\app\\(app)\\module-reviews\\[id]\\page.tsx', null],
    ['/home/ci/tcms/src/app/(app)/module-reviews/[id]/page.tsx', null],
  ]
  let pass = 0
  let fail = 0
  for (const [input, expected] of samples) {
    const got = namingViolation(input)
    if (got === expected) {
      pass++
      console.log(`  PASS ${input} -> ${got === null ? 'ok' : `violation "${got}"`}`)
    } else {
      fail++
      console.log(`  FAIL ${input} -> got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`)
    }
  }
  console.log(`PASS=${pass} FAIL=${fail}`)
  process.exit(fail ? 1 : 0)
}

// ---------- collect files ----------
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name)
    if (name.isDirectory()) out.push(...walk(p))
    else if (/\.(ts|tsx)$/.test(name.name)) out.push(p)
  }
  return out
}
const files = walk(SRC)
const findings = []

// Strip comments so doc comments quoting banned calls (e.g. "legacy used
// db.bug.count()") do not false-positive. Block comments always removed; line
// comments removed only when the // is not part of a URL (not after : " ').
function stripComments(content) {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'])\/\/.*$/gm, '$1')
}

function report(file, rule, message, content, index = -1) {
  const line = index >= 0 ? content.slice(0, index).split('\n').length : null
  findings.push(`${relative(ROOT, file)}${line ? `:${line}` : ''} [${rule}] ${message}`)
}

// Prisma model-query API (db.<model>.findMany(...) etc.) — raw SQL only.
const PRISMA_MODEL_QUERY =
  /\b(?:db|tx)\s*\.\s*[A-Za-z_$][\w$]*\s*\.\s*(?:findMany|findFirst|findFirstOrThrow|findUnique|findUniqueOrThrow|createMany|createManyAndReturn|updateMany|updateManyAndReturn|upsert|deleteMany|aggregate|groupBy|findRaw|aggregateRaw|create|update|delete|count)\s*\(/g
// Unsafe interpolated SQL — tagged templates ($queryRaw`...`) are the only allowed form.
const RAW_UNSAFE = /\$(?:queryRawUnsafe|executeRawUnsafe)\(/g
// Client components must not reach the DB layer.
const CLIENT_DB_IMPORT = /from\s+['"](?:@\/lib\/db|@prisma\/client)['"]/
// Controllers must not touch the DB or hand-build responses.
const ROUTE_DB_IMPORT = /from\s+['"](?:@\/lib\/db|@prisma\/client)['"]/
const NEXT_RESPONSE_JSON = /NextResponse\.json\s*\(/g
// Services/repositories stay HTTP-agnostic.
const NEXT_SERVER_IMPORT = /from\s+['"]next\/server['"]/
// Repositories must not import services (no inverted dependencies).
const REPO_IMPORTS_SERVICE = /from\s+['"][^'"]*\.service['"]/

const VERB = /\bexport\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/g

for (const file of files) {
  const content = stripComments(readFileSync(file, 'utf8'))
  const rel = relative(ROOT, file)
  const isRoute = rel.endsWith('route.ts')
  const isClient = /^['"]use client['"]/m.test(content.slice(0, 200))
  const isService = /\.service\.ts$/.test(file)
  const isRepository = /\.repository\.ts$/.test(file)

  // 1. Raw-SQL-only: no Prisma model queries, no unsafe interpolated SQL.
  for (const m of content.matchAll(PRISMA_MODEL_QUERY)) report(file, 'raw-sql-only', `Prisma model-query API used (${m[0].trim()}) — use $queryRaw/$executeRaw tagged templates`, content, m.index)
  for (const m of content.matchAll(RAW_UNSAFE)) report(file, 'raw-sql-only', `${m[0]} is banned — SQL injection risk; use tagged templates`, content, m.index)

  // 2. Client components must not import the DB layer.
  if (isClient && CLIENT_DB_IMPORT.test(content)) report(file, 'client-boundary', 'client component imports the DB layer (@/lib/db or @prisma/client)')

  // 3. Controllers: no DB access, no hand-built JSON responses.
  if (isRoute) {
    if (ROUTE_DB_IMPORT.test(content)) report(file, 'thin-controller', 'route.ts imports the DB layer — data access belongs in a repository')
    for (const m of content.matchAll(NEXT_RESPONSE_JSON)) report(file, 'thin-controller', 'NextResponse.json() used — return ok()/paginate() via withApi', content, m.index)
    // 4. Every exported verb handler must be wrapped in withApi.
    if (VERB.test(content) && !/withApi\s*\(/.test(content)) report(file, 'withApi', 'route.ts exports verb handlers but never wraps them in withApi()')
  }

  // 5. Layer isolation: services/repositories stay HTTP-agnostic.
  if ((isService || isRepository) && NEXT_SERVER_IMPORT.test(content)) report(file, 'http-agnostic', `${isService ? 'service' : 'repository'} imports next/server — HTTP types stay in the controller`)

  // 6. No inverted dependencies: repositories never import services.
  if (isRepository && REPO_IMPORTS_SERVICE.test(content)) report(file, 'no-inverted-deps', 'repository imports a service')

  // 7. Naming: kebab-case file names under src/ (dot-separated segments,
  //     e.g. auth.service.ts, are validated per segment).
  const badName = namingViolation(file)
  if (badName) report(file, 'naming', `file name "${badName}" is not kebab-case`)
}

// 8. Structure: every API resource dir needs dedicated validation + service modules.
const apiDir = join(SRC, 'app', 'api')
for (const name of readdirSync(apiDir, { withFileTypes: true })) {
  if (!name.isDirectory()) continue
  const dir = join(apiDir, name.name)
  if (!readdirSync(dir).includes('route.ts')) continue
  for (const needed of ['validation', 'service']) {
    if (!readdirSync(dir).some((f) => f === `${name.name}.${needed}.ts`)) {
      report(dir, 'layered-structure', `resource "${name.name}" is missing its dedicated ${name.name}.${needed}.ts module`)
    }
  }
}

// ---------- report ----------
if (findings.length) {
  console.error(`STANDARDS AUDIT: ${findings.length} violation(s) across ${files.length} TS files`)
  for (const f of findings) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log(`STANDARDS AUDIT: 0 violations across ${files.length} TS files`)
