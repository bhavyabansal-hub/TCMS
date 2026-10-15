// One-off: add the required `status` column to crew_desk_links (pre-migration
// PG source sync for the adopted 2026-10-14 baseline). Idempotent.
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()
try {
  await prisma.$executeRawUnsafe(
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='crew_desk_links' AND column_name='status') THEN
         ALTER TABLE crew_desk_links ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'posted';
       END IF;
     END $$;`
  )
  console.log('status column present (default posted)')
} finally {
  await prisma.$disconnect()
}
