// One-off audit: find duplicate top-level function/const declarations across
// component files — catches copy-paste helpers that should live in a shared
// module instead (DRY / "no duplicate components" requirement).
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(process.cwd(), 'src', 'components')
const files = []
;(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p)
    else if (/\.tsx$/.test(entry.name)) files.push(p)
  }
})(ROOT)

// Strip comments + strings so doc mentions don't false-positive.
function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, "''")
}

const declRe = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*[=:]|^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/gm

/** name -> [{file, kind}] */
const index = new Map()
for (const f of files) {
  const rel = path.relative(process.cwd(), f)
  const src = strip(fs.readFileSync(f, 'utf8'))
  for (const m of src.matchAll(declRe)) {
    const name = m[1] || m[2] || m[3]
    if (!name) continue
    if (!index.has(name)) index.set(name, [])
    index.get(name).push(rel)
  }
}

const dupes = [...index.entries()].filter(([, locs]) => new Set(locs).size > 1)
if (dupes.length === 0) {
  console.log('NO DUPLICATE DECLARATIONS across', files.length, 'component files')
} else {
  console.log('DUPLICATES FOUND:')
  for (const [name, locs] of dupes) {
    console.log(`  ${name} (${new Set(locs).size}x):`)
    for (const loc of new Set(locs)) console.log(`    - ${loc}`)
  }
}
