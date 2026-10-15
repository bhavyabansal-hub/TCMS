#!/bin/bash
# TCMS full-stack auto-start worker, invoked by .zscripts/dev.sh at container boot.
# Runs fully in the background (dev.sh returns immediately so the platform boot
# gate is never blocked). Idempotent: safe when the stack is already running.
#
# Flow:
#   1. scripts/start-tcms.sh  -> Postgres :5499 + WS :3003 + Next prod :3000
#      (builds .next first if missing, gates on GET /api health)
#   2. Login probe with the seeded admin account.
#      If login fails (fresh DB after a sandbox reset) -> prisma db push + seed.
#
# Logs: /tmp/tcms-autostart.log

cd /home/z/my-project || exit 0

# Env + DB wiring has ONE source of truth: scripts/mysql-env.sh (safe .env
# loader + mysql-only wiring; never re-wire or `source .env` here).
. scripts/mysql-env.sh

echo "[autostart] $(date -u +%FT%TZ) boot autostart beginning..."

# 0. Ensure dependencies (fresh sandbox resets wipe node_modules; when present
#    these checks are instant no-ops). Root install also regenerates the
#    Prisma client via the package.json postinstall hook.
if [ ! -d node_modules/next ]; then
  echo "[autostart] root node_modules missing - running bun install..."
  bun install || echo "[autostart] WARNING: root bun install failed"
fi
if [ ! -d scripts/pg-sandbox/node_modules/@embedded-postgres ]; then
  echo "[autostart] pg-sandbox deps missing - installing..."
  ( cd scripts/pg-sandbox && bun install ) || echo "[autostart] WARNING: pg-sandbox bun install failed"
fi

# 1. Stack (idempotent: every step no-ops when its port is already listening)
bash scripts/start-tcms.sh || echo "[autostart] WARNING: start-tcms.sh exited non-zero"

# 2. Seed-if-empty (only when the seeded admin cannot log in). Runs against
#    the MySQL database via the app API (TCMS_ENABLE_SEED=true).
#    SCHEMA IS NOT HANDLED HERE (task mysql-baseline-1): start-tcms.sh section
#    2c applies it with `npx prisma migrate deploy` as the DDL-only
#    tcms_migrate user — the same command production runs. The old
#    db-push + mysql-json-defaults.sh dance was the reason a fresh schema
#    only worked after manual fix-ups; that path no longer exists.
LOGIN_CODE=$(curl -s -o /dev/null -m 8 -w "%{http_code}" -X POST "http://localhost:3000/api/auth?path=login" \
  -H "Content-Type: application/json" -H "X-Requested-With: tcms" \
  -d '{"email":"admin@tcms.com","password":"Admin@123"}' 2>/dev/null)

if [ "$LOGIN_CODE" = "200" ]; then
  echo "[autostart] admin login OK - database already provisioned, skipping seed"
else
  echo "[autostart] admin login returned $LOGIN_CODE - seeding (schema already deployed by start-tcms.sh)..."
  SEED=$(curl -s -m 30 -X POST http://localhost:3000/api/seed \
    -H "Content-Type: application/json" -H "X-Requested-With: tcms" \
    -d '{"confirm":true}' 2>/dev/null)
  echo "[autostart] seed result: $SEED"
fi

# ---- 3. Daily backup scheduler (mysqldump, 14-copy retention). Idempotent:
#         skipped when another scheduler instance is already running. Runs via
#         nohup so it survives this script exiting; its own catch-up logic
#         takes the daily backup at BACKUP_AT (default 02:30). ----
if pgrep -f 'node scripts/backup-scheduler.mjs' > /dev/null 2>&1; then
  echo "[autostart] backup scheduler already running - skipping"
else
  echo "[autostart] starting daily backup scheduler (keep=14, see scripts/backup-scheduler.mjs)..."
  nohup setsid node scripts/backup-scheduler.mjs >> /tmp/tcms-backup-scheduler.log 2>&1 &
fi

echo "[autostart] $(date -u +%FT%TZ) boot autostart finished"
