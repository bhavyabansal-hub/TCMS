// Layering refactor (coding standard #10): services must never import
// `next/server`. Controllers now extract RequestMeta via extractRequestMeta()
// and pass the plain object down; services accept `meta: RequestMeta` instead
// of `req: NextRequest`, and logActivity receives `meta`.
import fs from 'node:fs'

const SERVICES = [
  'auth',
  'users',
  'task-reports',
  'test-cases',
  'modules',
  'reviews',
  'bugs',
  'module-reviews',
  'permissions',
]
const ROUTES = [
  'auth',
  'users',
  'task-reports',
  'test-cases',
  'modules',
  'reviews',
  'bugs',
  'module-reviews',
  'permissions',
]

let touched = 0
function apply(file, rules) {
  let src = fs.readFileSync(file, 'utf8')
  const before = src
  for (const [re, to] of rules) src = src.replace(re, to)
  if (src !== before) {
    fs.writeFileSync(file, src)
    touched++
    console.log('updated', file)
  }
}

for (const name of SERVICES) {
  apply(`src/app/api/${name}/${name}.service.ts`, [
    // import swap
    [/import type \{ NextRequest \} from 'next\/server'/, "import type { RequestMeta } from '@/lib/activity'"],
    // parameter type
    [/req: NextRequest/g, 'meta: RequestMeta'],
    // logActivity call sites
    [/request: req,/g, 'meta,'],
  ])
}

for (const name of ROUTES) {
  apply(`src/app/api/${name}/route.ts`, [
    // extend the shared api import with the extractor
    [/import \{ (withApi[^}]*?) \} from '@\/lib\/api'/, (m, p1) => `import { ${p1}, extractRequestMeta } from '@/lib/api'`],
    // hand plain meta to services
    [/,\s*req\)\)/g, ', extractRequestMeta(req)))'],
  ])
}

console.log('done,', touched, 'file(s) changed')
