// Prune unused dependencies from package.json (verified via precise import scan)
// and rename the package to match the project (coding standard: purposeful names).
import fs from 'node:fs'

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))

const REMOVE = new Set([
  '@dnd-kit/sortable',
  '@dnd-kit/utilities',
  '@hookform/resolvers',
  'date-fns',
  'framer-motion',
  'uuid',
  'embla-carousel-react',
  'react-day-picker',
  'vaul',
  'input-otp',
  'cmdk',
  'react-resizable-panels',
  'sharp',
  'next-auth',
  'next-intl',
  '@mdxeditor/editor',
  '@reactuses/core',
  '@tanstack/react-table',
  'react-markdown',
  'react-syntax-highlighter',
  '@radix-ui/react-accordion',
  '@radix-ui/react-aspect-ratio',
  '@radix-ui/react-collapsible',
  '@radix-ui/react-context-menu',
  '@radix-ui/react-hover-card',
  '@radix-ui/react-menubar',
  '@radix-ui/react-navigation-menu',
  '@radix-ui/react-slider',
  '@radix-ui/react-toggle',
  '@radix-ui/react-toggle-group',
])

let removed = 0
for (const section of ['dependencies', 'devDependencies']) {
  for (const name of Object.keys(pkg[section] || {})) {
    if (REMOVE.has(name)) {
      delete pkg[section][name]
      removed++
    }
  }
}

pkg.name = 'tcms'
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')
console.log(`removed ${removed} dependencies; package renamed to "tcms"`)
