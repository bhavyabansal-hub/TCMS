// One-off audit: find src files that are never imported by any other src file.
// Entry points (app pages/layouts, API routes) are exempt.
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(process.cwd(), 'src')
const files = []
;(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f)
    const s = fs.statSync(p)
    if (s.isDirectory()) walk(p)
    else if (/\.(ts|tsx)$/.test(f)) files.push(p)
  }
})(ROOT)

const norm = (p) => p.replace(/\\/g, '/')
const allSources = files.map((f) => ({ f: norm(f), code: fs.readFileSync(f, 'utf8') }))
const everything = allSources.map((s) => s.code).join('\n')

const isEntry = (f) =>
  /src\/app\/(page|layout)\.tsx$/.test(f) || /route\.ts$/.test(f)

const dead = []
for (const { f } of allSources) {
  if (isEntry(f)) continue
  const base = path.basename(f).replace(/\.(ts|tsx)$/, '')
  if (base === 'index') continue // barrel re-exports are referenced by folder alias
  // look for any import reference to this module name anywhere in src
  const needle = base
  const re = new RegExp(`['"@/\\.\\-\\w/]*${needle}['"]`)
  const referenced = allSources.some(
    (s) => s.f !== f && re.test(s.code)
  )
  if (!referenced) dead.push(f)
}

console.log('files scanned:', allSources.length)
if (dead.length) {
  console.log('POSSIBLY DEAD:')
  for (const d of dead) console.log(' -', norm(d).replace(process.cwd() + '/', ''))
} else {
  console.log('no dead files found')
}
