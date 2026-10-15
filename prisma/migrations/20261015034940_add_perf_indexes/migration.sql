-- Dashboard/notification performance indexes (owner answer 1, task mysql-baseline-1).
-- Carried from the PG-era perf task; they existed on NO MySQL schema before
-- this migration (apply-indexes.mjs was PG-only). Generated with
-- `prisma migrate diff --from-migrations --to-schema-datamodel`.

-- CreateIndex
CREATE INDEX `activity_logs_created_at_idx` ON `activity_logs`(`created_at`);

-- CreateIndex
CREATE INDEX `notifications_user_id_created_at_idx` ON `notifications`(`user_id`, `created_at`);

