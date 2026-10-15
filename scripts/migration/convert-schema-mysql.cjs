// One-off: convert prisma/schema.prisma from PostgreSQL to MySQL 8.4.
// - provider swap
// - PK uuid defaults: gen_random_uuid()::text -> (uuid())
// - explicit native types on EVERY String (Char(36) ids, VarChar(n)/Text per map)
// - @db.DateTime(3) on EVERY DateTime (preserve milliseconds)
// Idempotent: writes schema.prisma.mysql only when run with --write.
const fs = require('node:fs')

const SRC = 'prisma/schema.prisma'
let text = fs.readFileSync(SRC, 'utf8')

// 1. provider
text = text.replace(/provider\s*=\s*"postgresql"/, 'provider = "mysql"')

// 2. uuid default
text = text.replaceAll(
  '@default(dbgenerated("gen_random_uuid()::text"))',
  '@default(dbgenerated("(uuid())"))'
)

// 3. per-field native types. Field name (lower) -> native type.
//    Validation caps: title 200, email 254, comments 2000, notes 4000,
//    crewdesk note 300 (stored 1200), wiki content MEDIUMTEXT.
const TYPE_BY_NAME = {
  // emails
  email: 'VarChar(254)',
  // people
  fullname: 'VarChar(120)',
  passwordhash: 'VarChar(255)',
  role: 'VarChar(32)',
  telegramchatid: 'VarChar(32)',
  avatarurl: 'VarChar(500)',
  crewdeskuserid: 'VarChar(64)',
  // tokens
  token: 'VarChar(255)',
  // modules
  name: 'VarChar(200)',
  description: 'Text',
  path: 'VarChar(1000)',
  // role_permission
  action: 'VarChar(64)',
  // test case
  title: 'VarChar(200)',
  preconditions: 'Text',
  expectedresult: 'Text',
  priority: 'VarChar(8)',
  status: 'VarChar(32)',
  // history
  changesummary: 'VarChar(2000)',
  // reviews
  verdict: 'VarChar(32)',
  comment: 'VarChar(2000)',
  // bugs
  severity: 'VarChar(16)',
  environment: 'VarChar(500)',
  stepstoreproduce: 'Text',
  expectedbehaviour: 'Text',
  actualbehaviour: 'Text',
  // task reports
  notes: 'Text',
  // notifications
  type: 'VarChar(64)',
  body: 'Text',
  entitytype: 'VarChar(64)',
  entityname: 'VarChar(200)',
  // activity log
  ipaddress: 'VarChar(64)',
  useragent: 'VarChar(512)',
  // crew desk
  ticketid: 'VarChar(64)',
  tickettitle: 'VarChar(500)',
  ticketstatus: 'VarChar(64)',
  crewdeskcommentid: 'VarChar(64)',
  lasterror: 'VarChar(1000)',
  note: 'VarChar(1200)',
  // wiki
  kind: 'VarChar(16)',
  content: 'MediumText',
  filename: 'VarChar(255)',
  filetype: 'VarChar(128)',
}

// 4. every DateTime -> @db.DateTime(3)
text = text.replace(/^(\s+[A-Za-z]+\??\s+DateTime)(\s|$)/gm, '$1 @db.DateTime(3)$2')

// 5. String fields: append native type unless it already has @db. or is a Json/etc.
const lines = text.split('\n')
const out = lines.map((line) => {
  const m = line.match(/^(\s+)([A-Za-z]+)(\?)?\s+String(\s|\?|$)/)
  if (!m) return line
  const [, indent, rawName] = m
  if (line.includes('@db.')) return line
  const name = rawName.toLowerCase()
  let native
  if (TYPE_BY_NAME[name]) {
    native = TYPE_BY_NAME[name]
  } else if (/[a-z]id$/.test(name) || name === 'id') {
    native = 'Char(36)'
  } else {
    throw new Error(`No MySQL native type mapped for field: ${rawName} (line: ${line.trim()})`)
  }
  // insert type annotation right after the type token (String or String?)
  const re = new RegExp(`^(\\s+${rawName}\\??\\s+String\\??)(\\s|$)`)
  return line.replace(re, `$1 @db.${native}$2`)
})
text = out.join('\n')

if (process.argv.includes('--write')) {
  fs.writeFileSync(SRC, text)
  console.log('schema converted in place')
} else {
  console.log(text)
}
