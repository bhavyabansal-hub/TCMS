#!/bin/bash
# Nightly logical backup of the TCMS MySQL database via mysqldump
# (task mysql-backup-1: the ONLY backup path the scheduler runs — the
# PostgreSQL-era backup-db.mjs is retired and must never be invoked again).
#
# Output:  backups/tcms-backup-<UTC-timestamp>.sql.gz   (gzip, ~350 KB)
# Restore: bash scripts/restore-mysql.sh --file <backup.sql.gz> [--database scratch]
# Schedule: node scripts/backup-scheduler.mjs (daemon) or --run-now (ops/cron).
#
# SAFETY CONTRACT (all verified by scripts/backup-test.mjs):
#   1. Least privilege  — dumps run as the read-only tcms_backup user
#      (SELECT + SHOW VIEW + TRIGGER, created by mysql84-boot.sh), NEVER as
#      the DML app user or the DDL migrate user. Override the whole URL with
#      BACKUP_DATABASE_URL (mysql://tcms_backup:<pw>@host:port/schema) in
#      production; without it the script uses tcms_backup against the
#      host/port/schema of DATABASE_URL (sandbox: 127.0.0.1:5500/tcms_test).
#   2. Credentials live in a per-run defaults-extra-file (mktemp, chmod 600,
#      removed on exit) — the password NEVER appears on a command line, so
#      it can never leak through ps or /proc.
#   3. Every backup is verified before success is reported: non-empty,
#      `gzip -t` passes, and the dump ends with mysqldump's
#      "-- Dump completed on ..." footer. A failed check deletes the file,
#      appends a line to logs/error-<UTC-day>.log and exits non-zero —
#      the scheduler turns that into an in-app alert to manage_users holders.
#   4. Retention: files older than 14 days are removed here (age-based;
#      find -mtime +13 because mtime is truncated). The scheduler ALSO caps
#      the newest BACKUP_KEEP=14 files (count-based) — identical at the
#      daily cadence, belt-and-suspenders when one mechanism is skipped.
#
# mysqldump flags (owner-fixed): --single-transaction (consistent InnoDB
# snapshot, no write blocking), --no-tablespaces (avoids the PROCESS
# privilege), --hex-blob, --routines, --triggers; --set-gtid-purged=OFF
# keeps the dump restorable into any scratch schema.
set -uo pipefail
cd /home/z/my-project
# Safe env load (single source of truth) — never `source .env` (URLs contain &).
. scripts/mysql-env.sh

MYSQLDUMP="mysqldump"
MYSQL="mysql"
[ -x /tmp/mysql84/bin/mysqldump ] && MYSQLDUMP=/tmp/mysql84/bin/mysqldump
[ -x /tmp/mysql84/bin/mysql ] && MYSQL=/tmp/mysql84/bin/mysql
export LD_LIBRARY_PATH="/tmp/mysql84/extra-lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

# ---------- credential resolution (read-only dump user; never app creds) ---
urldecode() { printf '%b' "${1//%/\\x}"; }  # BACKUP_DATABASE_URL is percent-encoded

BK_USER="" ; BK_PASS="" ; BK_HOST="" ; BK_PORT="" ; BK_NAME=""
if [ -n "${BACKUP_DATABASE_URL:-}" ]; then
  case "$BACKUP_DATABASE_URL" in
    mysql://*) : ;;
    *) echo "FATAL: BACKUP_DATABASE_URL must be a mysql:// URL" ; exit 1 ;;
  esac
  blob="${BACKUP_DATABASE_URL%%\?*}"; blob="${blob#mysql://}"
  userpass="${blob%%@*}"; rest="${blob#*@}"
  BK_USER="$(urldecode "${userpass%%:*}")"
  BK_PASS="$(urldecode "${userpass#*:}")"
  BK_HOST="${rest%%:*}"
  restport="${rest#*:}"
  BK_PORT="${restport%%/*}"
  BK_NAME="$(urldecode "${restport#*/}")"
else
  # Host/port/schema follow DATABASE_URL (sandbox .env or mysql-env.sh
  # defaults); the USER is forced to the read-only dump user so a backup can
  # never run with the app's DML credentials — even by accident. Production
  # hosts MUST set BACKUP_DATABASE_URL instead (.env.example contract): with
  # only DATABASE_URL present this would try the sandbox password against the
  # production host and FAIL LOUDLY, which is the intended failure mode.
  dburl="${DATABASE_URL%%\?*}"; dburl="${dburl#mysql://}"
  rest="${dburl#*@}"
  BK_HOST="${rest%%:*}"
  restport="${rest#*:}"
  BK_PORT="${restport%%/*}"
  BK_NAME="${restport#*/}"
  BK_USER="tcms_backup"
  BK_PASS="ChangeMe_local_backup"   # sandbox default set by mysql84-boot.sh
fi
: "${BK_HOST:=127.0.0.1}" ; : "${BK_PORT:=5500}" ; : "${BK_NAME:=tcms_test}"
if [ -z "$BK_USER" ] || [ -z "$BK_PASS" ]; then
  echo "FATAL: backup user/password could not be resolved (set BACKUP_DATABASE_URL)"; exit 1
fi

# ---------- loud failure helper (error log + non-zero exit) ----------------
errlog_line() { # errlog_line <message> — matches src/lib/logger.ts format/day
  mkdir -p logs
  echo "[tcms] $(date -u '+%Y-%m-%dT%H:%M:%S.000Z') ERROR backup-db-mysql: $1" \
    >> "logs/error-$(date -u +%F).log"
}
sanitize() { sed "s/${BK_PASS//\//\\/}/******/g" ; }
fail() { # fail <context> — always non-empty stderr detail in the message
  echo "ERROR: backup failed: $1${2:+ — $(sanitize <<<"$2" | head -n 1)}" >&2
  errlog_line "backup failed: $1${2:+ — $(sanitize <<<"$2" | head -n 1)}"
  exit 1
}

# ---------- credentials file (chmod 600, removed on exit) ------------------
CNF="$(mktemp "${TMPDIR:-/tmp}/tcms-backup-XXXXXX.cnf")"
ERRFILE="$(mktemp "${TMPDIR:-/tmp}/tcms-backup-err-XXXXXX")"
chmod 600 "$CNF"
trap 'rm -f "$CNF" "$ERRFILE"' EXIT
{
  echo '[client]'
  echo "user=$BK_USER"
  echo "password=$BK_PASS"
  echo "host=$BK_HOST"
  echo "port=$BK_PORT"
} > "$CNF"

# ---------- dump + verify ---------------------------------------------------
mkdir -p backups logs
TS=$(date -u +%Y-%m-%dT%H-%M-%S)
OUT="backups/tcms-backup-${TS}.sql.gz"

# --defaults-extra-file must be the FIRST argument (MySQL option contract).
if ! "$MYSQLDUMP" --defaults-extra-file="$CNF" \
    --single-transaction --no-tablespaces --hex-blob --routines --triggers \
    --set-gtid-purged=OFF --databases "$BK_NAME" \
    2>"$ERRFILE" | gzip > "$OUT"; then
  rm -f "$OUT"
  fail "mysqldump/gzip exited non-zero for schema $BK_NAME (dump file removed)" "$(cat "$ERRFILE")"
fi

[ -s "$OUT" ] || { rm -f "$OUT"; fail "backup is empty: $OUT"; }
gzip -t "$OUT" 2>/dev/null || { rm -f "$OUT"; fail "gzip integrity check failed: $OUT"; }
LAST="$(gunzip -c "$OUT" | tail -n 1)"
case "$LAST" in
  *"-- Dump completed"*) : ;;
  *) rm -f "$OUT"; fail "dump does not end with 'Dump completed' (truncated?): $OUT" ;;
esac

SIZE=$(du -h "$OUT" | cut -f1)
LINES=$(gunzip -c "$OUT" | grep -c "INSERT INTO" || true)
echo "backup written: $OUT ($SIZE, ${LINES} INSERT statements) — verified: gzip OK, Dump completed footer present"
echo "[backup] $(date -u '+%FT%TZ') written $OUT ($SIZE, ${LINES} INSERT statements) as $BK_USER@${BK_HOST}:${BK_PORT}" >> logs/backup.log

# ---------- 14-day retention (age-based; see header) ------------------------
while IFS= read -r old; do
  [ -n "$old" ] || continue
  rm -f "$old" && { echo "retention: removed $old (>14 days old)"; \
    echo "[backup] $(date -u '+%FT%TZ') retention removed $old" >> logs/backup.log; }
done < <(find backups -maxdepth 1 -type f -name 'tcms-backup-*.sql.gz' -mtime +13 -print 2>/dev/null)
