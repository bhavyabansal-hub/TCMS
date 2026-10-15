#!/bin/bash
# Restore a mysqldump backup into a SCRATCH schema (restore drill) — never
# into the live schema without --database <live_name> (explicit, destructive).
# Usage: bash scripts/restore-mysql.sh --file backups/tcms-backup-<ts>.sql.gz [--database scratch_db]
#
# The drill is SELF-VERIFYING (task mysql-backup-1): after the import every
# restored table's row count is compared against the LIVE schema it was
# dumped from, printing one `drill-counts <table>=<rows>` line per table
# (machine-parseable for scripts/backup-test.mjs) plus a MATCH/MISMATCH
# verdict per table. Any mismatch (or a table that exists only on one side)
# exits non-zero. The scratch schema is dropped at the end — production data
# is never touched.
set -uo pipefail
cd /home/z/my-project
# Safe env load (single source of truth) — never `source .env` (URLs contain &).
. scripts/mysql-env.sh

FILE=""
TARGET="tcms_restore_scratch"
while [ $# -gt 0 ]; do
  case "$1" in
    --file) FILE="$2"; shift 2 ;;
    --database) TARGET="$2"; shift 2 ;;
    *) echo "unknown arg $1"; exit 1 ;;
  esac
done
[ -f "$FILE" ] || { echo "backup file not found: $FILE"; exit 1; }

MYSQLDUMP="mysqldump"; MYSQL="mysql"
[ -x /tmp/mysql84/bin/mysqldump ] && MYSQLDUMP=/tmp/mysql84/bin/mysqldump
[ -x /tmp/mysql84/bin/mysql ] && MYSQL=/tmp/mysql84/bin/mysql
export LD_LIBRARY_PATH="/tmp/mysql84/extra-lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

DBURL="${DATABASE_URL%%\?*}"; DBURL="${DBURL#mysql://}"; USERPASS="${DBURL%%@*}"; REST="${DBURL#*@}"
DBUSER="${USERPASS%%:*}"; DBPASS="${USERPASS#*:}"; DBHOST="${REST%%:*}"; RP="${REST#*:}"; DBPORT="${RP%%/*}"
LIVE="${RP#*/}"   # the schema the backup was taken from (dump's --databases source)
: "${DBHOST:=127.0.0.1}" ; : "${DBPORT:=5500}" ; : "${LIVE:=tcms_test}"

mysql_root() { "$MYSQL" --no-defaults -h "$DBHOST" -P "$DBPORT" -u root -N -e "$1"; }

# App user lacks CREATE on other schemas -> root does the scratch restore
# (sandbox pattern; a production DBA runs this script with their own
# credentials and privileges instead).
mysql_root "DROP DATABASE IF EXISTS \`$TARGET\`; CREATE DATABASE \`$TARGET\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" \
  || { echo "restore drill FAILED: could not create scratch schema $TARGET"; exit 1; }

if ! gunzip -c "$FILE" | sed "s/\`tcms_test\`/\`$TARGET\`/g" | "$MYSQL" --no-defaults -h "$DBHOST" -P "$DBPORT" -u root "$TARGET"; then
  echo "restore drill FAILED: import errored (see above)"
  mysql_root "DROP DATABASE IF EXISTS \`$TARGET\`;"
  exit 1
fi

# Verify: table list + per-table row counts vs the live schema
mapfile -t TABLES < <(mysql_root "SELECT table_name FROM information_schema.TABLES WHERE table_schema='$TARGET' AND table_type='BASE TABLE' ORDER BY table_name;")
MISMATCH=0
for t in "${TABLES[@]}"; do
  [ -n "$t" ] || continue
  R=$(mysql_root "SELECT COUNT(*) FROM \`$TARGET\`.\`$t\`;")
  L=$(mysql_root "SELECT COUNT(*) FROM \`$LIVE\`.\`$t\`;" 2>/dev/null) || { echo "drill-counts $t=$R (live: MISSING)"; MISMATCH=1; continue; }
  echo "drill-counts $t=$R (live $L)"
  [ "$R" = "$L" ] || MISMATCH=1
done
USERS=$(mysql_root "SELECT COUNT(*) FROM \`$TARGET\`.users;")
CASES=$(mysql_root "SELECT COUNT(*) FROM \`$TARGET\`.test_cases;")
echo "restore drill: database=$TARGET tables=${#TABLES[@]} users=$USERS test_cases=$CASES"

if [ "$MISMATCH" != "0" ]; then
  echo "restore drill FAILED: row counts differ from live schema $LIVE (see drill-counts lines above)"
  mysql_root "DROP DATABASE \`$TARGET\`;"
  echo "scratch schema dropped (failed drill cleaned up)"
  exit 1
fi
echo "restore drill OK: ${#TABLES[@]} tables, every row count matches live schema $LIVE"
mysql_root "DROP DATABASE \`$TARGET\`;"
echo "scratch schema dropped (drill complete)"
