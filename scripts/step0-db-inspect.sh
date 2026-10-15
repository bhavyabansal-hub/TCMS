#!/bin/bash
# STEP 0 inspection ONLY (read-only queries) — task "single versioned MySQL schema build".
# Reads creds from .env, never echoes them. Uses the sandbox mysql client.
cd /home/z/my-project || exit 1
[ -f /tmp/mysql84/bin/mysql ] || { echo "mysql client missing"; exit 1; }
export LD_LIBRARY_PATH="/tmp/mysql84/extra-lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

URL=$(grep -E '^DIRECT_URL=' .env | head -1 | cut -d= -f2- | tr -d '"' | tr -d $'\r')
case "$URL" in mysql://*) ;; *) echo "DIRECT_URL is not mysql://"; exit 1;; esac
REST=${URL#mysql://}
CREDS=${REST%%@*}
REST2=${REST#*@}
HOSTPORT=${REST2%%/*}
DBPART=${REST2#*/}
DB=${DBPART%%\?*}
DBUSER=${CREDS%%:*}
export MYSQL_PWD=${CREDS#*:}
HP_HOST=${HOSTPORT%%:*}
HP_PORT=${HOSTPORT##*:}

M="/tmp/mysql84/bin/mysql --no-defaults -h $HP_HOST -P $HP_PORT -u $DBUSER $DB"

echo "=== A. server version ==="
$M -e "SELECT VERSION() AS version;"

echo ""
echo "=== B. SHOW FULL COLUMNS FROM users (Collation column) ==="
$M -e "SHOW FULL COLUMNS FROM users;"

echo ""
echo "=== C. SHOW FULL COLUMNS FROM refresh_tokens ==="
$M -e "SHOW FULL COLUMNS FROM refresh_tokens;"

echo ""
echo "=== D. table collations (all base tables) ==="
$M -e "SELECT TABLE_NAME, TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA='$DB' AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME;"

echo ""
echo "=== E. distinct COLUMN collations in use (count per collation, excluding the two secret columns) ==="
$M -e "SELECT COLLATION_NAME, COUNT(*) AS cols FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$DB' AND COLLATION_NAME IS NOT NULL GROUP BY COLLATION_NAME ORDER BY cols DESC;"

echo ""
echo "=== F. the two secret columns, exact ==="
$M -e "SELECT TABLE_NAME, COLUMN_NAME, COLLATION_NAME, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$DB' AND ((TABLE_NAME='users' AND COLUMN_NAME='password_hash') OR (TABLE_NAME='refresh_tokens' AND COLUMN_NAME='token'));"

echo ""
echo "=== G. performance indexes present? ==="
$M -e "SELECT TABLE_NAME, INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='$DB' AND INDEX_NAME IN ('activity_logs_created_at_idx','notifications_user_id_created_at_idx') GROUP BY TABLE_NAME, INDEX_NAME;"

echo ""
echo "=== H. _prisma_migrations table exists? ==="
$M -e "SHOW TABLES LIKE '_prisma_migrations';"

echo ""
echo "=== I. table count + row samples (proof DB is the live seeded one) ==="
$M -e "SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM test_cases) AS test_cases, (SELECT COUNT(*) FROM refresh_tokens) AS refresh_tokens;"
unset MYSQL_PWD
