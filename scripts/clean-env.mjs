#!/usr/bin/env node
// Tidies .env into the sections and short comments of .env.example WITHOUT changing
// or printing any value. Prints key NAMES only.
//
//   node scripts/clean-env.mjs           dry run: shows what would change, writes nothing
//   node scripts/clean-env.mjs --write   copies .env to .env.bak (git-ignored), then rewrites .env
//
// Rules:
//   - every existing value is kept byte for byte (quotes included);
//   - keys are ordered by the sections of .env.example and get its comment line;
//   - "Required ..." sections are always written; an unset key there becomes a
//     commented placeholder (`# KEY=`) so you see what to fill;
//   - optional keys you have not set are left out (the full list is .env.example),
//     so nothing changes in behaviour;
//   - keys that .env.example does not know are REMOVED only when no file in src/,
//     scripts/, mini-services/ or prisma/ mentions them; otherwise they are kept in
//     an "Other keys" section;
//   - keys of "Required (every machine)" that are missing are listed by name (exit
//     code 2); unset "Required on the live server" keys are listed for information.
// Cross-platform Node, no dependencies.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENV_FILE = path.join(ROOT, '.env')
const EXAMPLE_FILE = path.join(ROOT, '.env.example')
const BACKUP_FILE = path.join(ROOT, '.env.bak')
const WRITE = process.argv.includes('--write')
const KEY_LINE = /^\s*(#\s*)?([A-Z_][A-Z0-9_]*)\s*=/

/** Parses .env.example into a header, sections and key slots (comment + required flag). */
function parseTemplate(text) {
  const header = []
  const sections = []
  let current = null
  let pendingComments = []
  for (const line of text.split(/\r?\n/)) {
    const section = line.match(/^#\s*====\s*(.+?)\s*====\s*$/)
    if (section) {
      const title = section[1]
      current = { title, keys: [], required: /^Required\b/.test(title), always: /^Required \(every machine\)/.test(title) }
      sections.push(current)
      pendingComments = []
      continue
    }
    const key = line.match(KEY_LINE)
    if (key && current) {
      const comment = pendingComments.join('\n')
      current.keys.push({ name: key[2], comment })
      pendingComments = []
      continue
    }
    if (!current) header.push(line)
    else if (line.startsWith('#')) pendingComments.push(line)
    else pendingComments = []
  }
  while (header.length && header[header.length - 1].trim() === '') header.pop()
  return { header, sections }
}

/** Parses .env into ordered entries { name, raw } — raw = everything after "KEY=", untouched. */
function parseEnv(text) {
  const entries = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*#/.test(line) || !line.trim()) continue
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/)
    if (!match) continue
    let raw = match[2]
    // A quoted value may span lines: keep collecting until the closing quote.
    const quote = raw.trimStart()[0]
    if ((quote === '"' || quote === "'") && !closesQuote(raw.trimStart(), quote)) {
      while (i + 1 < lines.length) {
        raw += '\n' + lines[++i]
        if (lines[i].includes(quote)) break
      }
    }
    const existing = entries.find((e) => e.name === match[1])
    if (existing) existing.raw = raw // last one wins, like dotenv
    else entries.push({ name: match[1], raw })
  }
  return entries
}

function closesQuote(value, quote) {
  return value.length > 1 && value.indexOf(quote, 1) !== -1
}

/** True when any project source file mentions the key (then it is never removed). */
function isReferencedInCode(name) {
  const dirs = ['src', 'scripts', 'mini-services', 'prisma'].map((d) => path.join(ROOT, d))
  const stack = [...dirs]
  while (stack.length) {
    const dir = stack.pop()
    let items = []
    try {
      items = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const item of items) {
      if (item.name === 'node_modules' || item.name.startsWith('.')) continue
      const full = path.join(dir, item.name)
      if (item.isDirectory()) stack.push(full)
      else if (/\.(m?[jt]sx?|cjs|sh|prisma|json)$/.test(item.name) && fs.readFileSync(full, 'utf8').includes(name)) return true
    }
  }
  return false
}

function main() {
  if (!fs.existsSync(ENV_FILE)) {
    console.log('No .env found — copy .env.example to .env and fill the required keys.')
    process.exit(1)
  }
  const template = parseTemplate(fs.readFileSync(EXAMPLE_FILE, 'utf8'))
  const original = fs.readFileSync(ENV_FILE, 'utf8')
  const entries = parseEnv(original)
  const values = new Map(entries.map((e) => [e.name, e.raw]))
  const known = new Set(template.sections.flatMap((s) => s.keys.map((k) => k.name)))

  const kept = []
  const liveNotSet = []
  const missingRequired = []
  const out = [...template.header, '# Only the keys in use are listed here; every key is in .env.example.', '']
  for (const section of template.sections) {
    const lines = []
    for (const key of section.keys) {
      if (values.has(key.name)) {
        if (key.comment) lines.push(key.comment)
        lines.push(`${key.name}=${values.get(key.name)}`)
        kept.push(key.name)
      } else if (section.required) {
        if (key.comment) lines.push(key.comment)
        lines.push(`# ${key.name}=`)
        if (section.always) missingRequired.push(key.name)
        else liveNotSet.push(key.name)
      }
    }
    if (lines.length) out.push(`# ==== ${section.title} ====`, ...lines, '')
  }

  const unknown = entries.filter((e) => !known.has(e.name))
  const keptUnknown = unknown.filter((e) => isReferencedInCode(e.name))
  const removed = unknown.filter((e) => !keptUnknown.includes(e)).map((e) => e.name)
  if (keptUnknown.length) {
    out.push('# ==== Other keys (not in .env.example, still used by scripts) ====')
    for (const e of keptUnknown) out.push(`${e.name}=${e.raw}`)
    out.push('')
  }
  const next = out.join('\n').replace(/\n{3,}/g, '\n\n')

  const list = (names) => (names.length ? names.join(', ') : '-')
  console.log(`kept (value unchanged)        : ${kept.length} — ${list(kept)}`)
  console.log(`kept, not in .env.example     : ${keptUnknown.length} — ${list(keptUnknown.map((e) => e.name))}`)
  console.log(`live-server keys not set      : ${liveNotSet.length} — ${list(liveNotSet)} (fine on a dev machine)`)
  console.log(`removed (unused)              : ${removed.length} — ${list(removed)}`)
  console.log(`MISSING REQUIRED              : ${missingRequired.length} — ${list(missingRequired)}`)

  // Self-check: every kept value must come out byte-identical.
  const after = new Map(parseEnv(next).map((e) => [e.name, e.raw]))
  const changed = [...kept, ...keptUnknown.map((e) => e.name)].filter((n) => after.get(n) !== values.get(n))
  if (changed.length) {
    console.log(`ABORT: value check failed for ${list(changed)} — nothing written.`)
    process.exit(1)
  }

  if (!WRITE) {
    console.log('DRY RUN — nothing written. Run with --write to back up .env to .env.bak and rewrite it.')
  } else {
    fs.copyFileSync(ENV_FILE, BACKUP_FILE)
    fs.writeFileSync(ENV_FILE, next)
    console.log('WRITTEN: .env rewritten; the old file is in .env.bak (git-ignored). Delete .env.bak once the app works.')
  }
  process.exit(missingRequired.length ? 2 : 0)
}

main()
