// Sandbox maintenance: hard-delete self-test users and ALL their child rows,
// child-first (refresh_tokens -> activity_logs -> notifications -> login_attempts -> users).
// Usage:  node scripts/cleanup-selftest-users.mjs <email> [<email> ...]
// Requires DATABASE_URL in the environment.
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const emails = process.argv.slice(2)

if (emails.length === 0) {
  console.error('Usage: node scripts/cleanup-selftest-users.mjs <email> [<email> ...]')
  process.exit(1)
}

const bigints = (obj) => JSON.parse(JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? Number(v) : v)))

async function main() {
  for (const email of emails) {
    const rows = await prisma.$queryRaw`SELECT user_id FROM users WHERE email = ${email}`
    if (rows.length === 0) {
      console.log(`SKIP ${email}: not found`)
      continue
    }
    const userId = rows[0].user_id

    const t1 = await prisma.$executeRaw`DELETE FROM refresh_tokens WHERE user_id = ${userId}`
    const a1 = await prisma.$executeRaw`DELETE FROM activity_logs WHERE user_id = ${userId}`
    const n1 = await prisma.$executeRaw`DELETE FROM notifications WHERE user_id = ${userId}`
    const l1 = await prisma.$executeRaw`DELETE FROM login_attempts WHERE email = ${email}`
    const u1 = await prisma.$executeRaw`DELETE FROM users WHERE user_id = ${userId}`

    console.log(`DELETED ${email}: refresh_tokens=${t1} activity_logs=${a1} notifications=${n1} login_attempts=${l1} users=${u1}`)
  }
  const remaining = bigints(await prisma.$queryRaw`SELECT email FROM users WHERE email LIKE '%@tcms-test.com' ORDER BY email`)
  console.log('remaining @tcms-test.com users:', JSON.stringify(remaining))
}

main()
  .catch((e) => {
    console.error('CLEANUP FAIL:', e.message)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
