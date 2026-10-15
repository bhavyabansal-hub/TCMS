// Sandbox migration: applies the RBAC refactor to the existing database.
// 1. Drops the abandoned module_permissions table (feature removed).
// 2. Creates role_permissions + login_attempts.
// 3. Remaps legacy roles -> new 6-role hierarchy (admin->vp, team_lead->manager).
// 4. Inserts the 3 new demo accounts (product/developer/viewer) if absent.
// Idempotent: safe to run repeatedly. NOT part of the shipped package.
import bcrypt from 'bcryptjs'
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  // 1. Drop module-level permissions (feature removed by design).
  await db.$executeRaw`DROP TABLE IF EXISTS module_permissions`
  console.log('1. module_permissions dropped (if existed)')

  // 2. New tables.
  await db.$executeRaw`
    CREATE TABLE IF NOT EXISTS "role_permissions" (
      "role" TEXT NOT NULL,
      "action" TEXT NOT NULL,
      "enabled" BOOLEAN NOT NULL DEFAULT true,
      "updated_by_id" TEXT,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role","action")
    )`
  await db.$executeRaw`
    CREATE TABLE IF NOT EXISTS "login_attempts" (
      "email" TEXT NOT NULL,
      "failed_attempts" INTEGER NOT NULL DEFAULT 0,
      "locked_until" TIMESTAMP(3),
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("email")
    )`
  console.log('2. role_permissions + login_attempts ready')

  // 3. Role remap.
  const vp = await db.$executeRaw`UPDATE users SET role = 'vp' WHERE role = 'admin'`
  const mgr = await db.$executeRaw`UPDATE users SET role = 'manager' WHERE role = 'team_lead'`
  console.log(`3. roles remapped: ${vp} admin->vp, ${mgr} team_lead->manager`)

  // 4. New demo accounts (idempotent by unique email).
  const demos = [
    { email: 'product@tcms.com', fullName: 'Paula Product', password: 'Product@123', role: 'product' },
    { email: 'developer@tcms.com', fullName: 'Devon Developer', password: 'Dev@12345', role: 'developer' },
    { email: 'viewer@tcms.com', fullName: 'Vera Viewer', password: 'View@12345', role: 'viewer' },
  ]
  for (const u of demos) {
    await db.$executeRaw`
      INSERT INTO users (email, full_name, password_hash, role, is_active, updated_at)
      VALUES (${u.email}, ${u.fullName}, ${bcrypt.hashSync(u.password, 10)}, ${u.role}, true, NOW())
      ON CONFLICT (email) DO NOTHING`
  }
  console.log('4. demo accounts ensured (product/developer/viewer)')

  // Summary.
  const roles = await db.$queryRaw`
    SELECT role, COUNT(*)::int AS total FROM users GROUP BY role ORDER BY total DESC`
  console.log('Users by role:', roles.map((r) => `${r.role}=${r.total}`).join(', '))
  const tables = await db.$queryRaw`
    SELECT COUNT(*)::int AS total FROM information_schema.tables WHERE table_schema = 'public'`
  console.log(`Public tables: ${tables[0].total}`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
