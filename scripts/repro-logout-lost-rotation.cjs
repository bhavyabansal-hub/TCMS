/* eslint-disable @typescript-eslint/no-require-imports */
// Repro: simulate a refresh-token rotation whose response never reached the
// client — the client keeps a token that is now REVOKED server-side.
// Then a hard refresh should (currently) hard-logout the user.
const { PrismaClient } = require('@prisma/client')
const db = new PrismaClient()

async function main() {
  const userId = '9e227cd7-47eb-4ec1-a166-f0481d21e30e'
  const rows = await db.$queryRaw`
    SELECT token FROM refresh_tokens
    WHERE user_id = ${userId} AND revoked = false
    ORDER BY created_at DESC LIMIT 1`
  if (!rows.length) { console.log('NO LIVE TOKEN FOUND'); return }
  const res = await db.$executeRaw`
    UPDATE refresh_tokens SET revoked = true
    WHERE token = ${rows[0].token}`
  console.log('revoked token starting:', rows[0].token.slice(0, 24), 'rows:', res)
}

main().finally(() => db.$disconnect())
