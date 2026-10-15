// Sandbox-only DB state check: tables, role distribution, override rows.
// NOT part of the shipped package (uses Prisma client directly for convenience).
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()
try {
  const tables = await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`
  const names = tables.map((r) => r.tablename)
  console.log('TABLES (' + names.length + '):', names.join(', '))
  console.log('module_permissions present:', names.includes('module_permissions') ? 'YES - PROBLEM' : 'NO (correctly removed)')
  const overrides = await db.$queryRaw`SELECT COUNT(*)::int AS n FROM role_permissions`
  console.log('role_permissions override rows:', overrides[0].n, '(0 = pristine defaults)')
  const locks = await db.$queryRaw`SELECT COUNT(*)::int AS n FROM login_attempts`
  console.log('login_attempts rows:', locks[0].n)
  const roles = await db.$queryRaw`SELECT role, COUNT(*)::int AS n FROM users GROUP BY role ORDER BY role`
  console.log('users by role:', roles.map((r) => `${r.role}=${r.n}`).join(', '))
} finally {
  await db.$disconnect()
}
