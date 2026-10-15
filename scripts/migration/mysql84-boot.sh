#!/bin/bash
# Boot a REAL MySQL 8.4 server for the TCMS migration (TEST schema only).
# - port 5500, socket /tmp/mysql84.sock, datadir /tmp/mysql84/data
# - utf8mb4, full MySQL 8.4 default sql_mode (ONLY_FULL_GROUP_BY + STRICT +
#   NO_ZERO_IN_DATE/NO_ZERO_DATE + ERROR_FOR_DIVISION_BY_ZERO + NO_ENGINE_SUBSTITUTION),
#   caching_sha2_password default auth
# - creates: tcms_test schema + limited app user tcms_app (NO root usage)
# Idempotent: skips init when datadir exists, skips start when port is up.
set -u
export LD_LIBRARY_PATH=/tmp/mysql84/extra-lib
MYSQLD=/tmp/mysql84/bin/mysqld
MYSQL=/tmp/mysql84/bin/mysql
DATA=/tmp/mysql84/data
PORT=5500

port_up() { ss -tln 2>/dev/null | grep -q ":$1 "; }

if [ ! -d "$DATA/mysql" ]; then
  echo "[mysql84] initializing datadir..."
  "$MYSQLD" --no-defaults --initialize-insecure \
    --basedir=/tmp/mysql84 --datadir="$DATA" \
    --log-error-verbosity=3 > /tmp/mysql84-init.log 2>&1 || { tail -5 /tmp/mysql84-init.log; exit 1; }
fi

if ! port_up $PORT; then
  echo "[mysql84] starting mysqld on :$PORT..."
  ("$MYSQLD" --no-defaults \
    --basedir=/tmp/mysql84 --datadir="$DATA" \
    --port=$PORT --socket=/tmp/mysql84.sock \
    --bind-address=127.0.0.1 \
    --character-set-server=utf8mb4 --collation-server=utf8mb4_0900_ai_ci \
    --sql-mode="ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION" \
    --default-time-zone='+00:00' \
    --max_connections=200 \
    --log-error=/tmp/mysql84.err > /dev/null 2>&1 &)
  for i in $(seq 1 30); do port_up $PORT && break; sleep 1; done
  port_up $PORT || { echo "[mysql84] FAILED to start"; tail -20 /tmp/mysql84.err; exit 1; }
fi
echo "[mysql84] server up on :$PORT"

# Create test schema + users (idempotent). 8.4 default auth = caching_sha2_password.
# THREE-USER MODEL (two-user model: owner addition B, task mysql-baseline-1;
# tcms_backup added by task mysql-backup-1):
#   tcms_app     — RUNTIME app user, DML ONLY (SELECT,INSERT,UPDATE,DELETE).
#   tcms_migrate — schema migrations ONLY (prisma migrate deploy via DIRECT_URL);
#                  holds the DDL rights the app user must not have.
#   tcms_backup  — NIGHTLY mysqldump ONLY, read-only (SELECT + SHOW VIEW +
#                  TRIGGER — the exact privilege set mysqldump needs for
#                  --single-transaction --routines --triggers --no-tablespaces;
#                  the dump user must never hold DML/DDL write rights).
# DROP+CREATE instead of CREATE IF NOT EXISTS + GRANT: GRANT is additive and
# would silently KEEP the old DDL grants on datadirs provisioned before this
# model — dropping re-derives the exact grant set on EVERY boot (idempotent).
"$MYSQL" --no-defaults -h 127.0.0.1 -P $PORT -u root <<'SQL'
CREATE DATABASE IF NOT EXISTS tcms_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
DROP USER IF EXISTS 'tcms_app'@'127.0.0.1';
DROP USER IF EXISTS 'tcms_app'@'localhost';
DROP USER IF EXISTS 'tcms_migrate'@'127.0.0.1';
DROP USER IF EXISTS 'tcms_migrate'@'localhost';
DROP USER IF EXISTS 'tcms_backup'@'127.0.0.1';
DROP USER IF EXISTS 'tcms_backup'@'localhost';
CREATE USER 'tcms_app'@'127.0.0.1' IDENTIFIED BY 'ChangeMe_local_only';
CREATE USER 'tcms_app'@'localhost' IDENTIFIED BY 'ChangeMe_local_only';
CREATE USER 'tcms_migrate'@'127.0.0.1' IDENTIFIED BY 'ChangeMe_local_migrate';
CREATE USER 'tcms_migrate'@'localhost' IDENTIFIED BY 'ChangeMe_local_migrate';
CREATE USER 'tcms_backup'@'127.0.0.1' IDENTIFIED BY 'ChangeMe_local_backup';
CREATE USER 'tcms_backup'@'localhost' IDENTIFIED BY 'ChangeMe_local_backup';
GRANT SELECT, INSERT, UPDATE, DELETE ON tcms_test.* TO 'tcms_app'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON tcms_test.* TO 'tcms_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, INDEX, ALTER, REFERENCES, CREATE TEMPORARY TABLES, LOCK TABLES ON tcms_test.* TO 'tcms_migrate'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, INDEX, ALTER, REFERENCES, CREATE TEMPORARY TABLES, LOCK TABLES ON tcms_test.* TO 'tcms_migrate'@'localhost';
GRANT SELECT, SHOW VIEW, TRIGGER ON tcms_test.* TO 'tcms_backup'@'127.0.0.1';
GRANT SELECT, SHOW VIEW, TRIGGER ON tcms_test.* TO 'tcms_backup'@'localhost';
FLUSH PRIVILEGES;
SQL
echo "[mysql84] schema tcms_test + tcms_app (DML-only) + tcms_migrate (DDL migrations) + tcms_backup (read-only dump) ready"

# Show the facts IT would provide
"$MYSQL" --no-defaults -h 127.0.0.1 -P $PORT -u root -e \
  "SELECT VERSION() AS version, @@sql_mode AS sql_mode, @@character_set_server AS charset, @@collation_server AS collation, @@default_authentication_plugin AS auth_plugin, @@max_connections AS max_conn, @@global.time_zone AS tz;" 2>/dev/null || \
"$MYSQL" --no-defaults -h 127.0.0.1 -P $PORT -u root -e \
  "SELECT VERSION() AS version, @@sql_mode AS sql_mode, @@character_set_server AS charset, @@collation_server AS collation, @@max_connections AS max_conn, @@global.time_zone AS tz;"
