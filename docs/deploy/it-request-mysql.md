# IT request — MySQL 8.4 database and app server for TCMS

> To: company IT · From: TCMS owner · Date: 2026-10-16
> Purpose: everything IT has to provide or confirm so TCMS (Test Case Management System)
> can run in production. Please answer each numbered item; values marked `<…>` are
> yours to fill in. Install steps on our side: [`PRODUCTION-CHECKLIST.md`](./PRODUCTION-CHECKLIST.md).

TCMS is one Next.js app (Node 20+) plus one small WebSocket service (bun), behind nginx,
on **one** Linux server, using **one** MySQL 8.4 schema. It must run as a **single
instance** (in-memory caches and socket registry; see `docs/16-single-instance-and-scaling.md`).

---

## 1. MySQL server

| # | Item | Requested | IT answer |
|---|---|---|---|
| 1.1 | Version | MySQL **8.4 LTS** (8.4.x) | `<version>` |
| 1.2 | Host / port | reachable from the app server only (private network) | `<db-host>:<port>` |
| 1.3 | Schemas | `tcms` (production) and `tcms_test` (certification copy, same settings) | |
| 1.4 | `max_connections` | ≥ 100 (TCMS uses at most ~45: app pool 40 + backup + tools) | `<value>` |
| 1.5 | Storage | InnoDB only; start with 5 GB for the schema (wiki attachments are LONGBLOB, ≤ 10 MB each) + room for backups | |
| 1.6 | Who restarts / patches MySQL, and how we are notified | | |

## 2. Server settings (the app checks these at every start and refuses to run otherwise)

Persist them in `my.cnf` (not only `SET GLOBAL`) so they survive a restart:

```ini
[mysqld]
sql_mode                 = ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION
default_time_zone        = '+00:00'
character_set_server     = utf8mb4
collation_server         = utf8mb4_unicode_ci
transaction_isolation    = REPEATABLE-READ
require_secure_transport = ON
```

Schemas created with the same charset:

```sql
CREATE DATABASE tcms      CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE tcms_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Confirm with: `SELECT @@version, @@sql_mode, @@time_zone, @@character_set_server, @@transaction_isolation;`

## 3. Three database users and their exact grants

All three connect **only from the app server** (`'<app-server-ip>'`), with strong
passwords sent to the owner through a secure channel (not email/ticket text).
TLS required (`REQUIRE SSL`). No user gets global privileges or `GRANT OPTION`.

```sql
-- 1) Application runtime user: data only (no DDL). Used by the running app.
CREATE USER 'tcms_app'@'<app-server-ip>' IDENTIFIED BY '<strong password>' REQUIRE SSL;
GRANT SELECT, INSERT, UPDATE, DELETE ON tcms.* TO 'tcms_app'@'<app-server-ip>';

-- 2) Migration user: schema changes only during a deploy (`npx prisma migrate deploy`).
CREATE USER 'tcms_migrate'@'<app-server-ip>' IDENTIFIED BY '<strong password>' REQUIRE SSL;
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, INDEX, ALTER, REFERENCES,
      CREATE TEMPORARY TABLES, LOCK TABLES ON tcms.* TO 'tcms_migrate'@'<app-server-ip>';

-- 3) Backup user: read-only, for mysqldump.
CREATE USER 'tcms_backup'@'<app-server-ip>' IDENTIFIED BY '<strong password>' REQUIRE SSL;
GRANT SELECT, SHOW VIEW, TRIGGER ON tcms.* TO 'tcms_backup'@'<app-server-ip>';
-- Only if mysqldump --routines reports a privilege error (8.0.20+ privilege):
-- GRANT SHOW_ROUTINE ON *.* TO 'tcms_backup'@'<app-server-ip>';
```

Repeat the same three users/grants for `tcms_test.*` (certification run before go-live).
`mysqldump` runs with `--single-transaction --no-tablespaces`, so it needs neither
`RELOAD`, `PROCESS` nor `LOCK TABLES` for the backup user.

## 4. TLS to MySQL

| # | Item | IT answer |
|---|---|---|
| 4.1 | Server certificate issued by which CA (company CA / public CA)? | |
| 4.2 | CA bundle file for the app server (we validate the certificate: `sslaccept=strict`) | path / file |
| 4.3 | Minimum TLS version (we expect TLS 1.2+) | |

## 5. App server (Linux)

| # | Item | Requested | IT answer |
|---|---|---|---|
| 5.1 | OS | Ubuntu 22.04/24.04 LTS or RHEL 9 | |
| 5.2 | Size | 2 vCPU, 4 GB RAM, 20 GB disk + backup space | |
| 5.3 | Software | Node.js 20 LTS (or 22), npm, bun ≥ 1.1, git, nginx, `mysql` + `mysqldump` **8.4 client**, cron, systemd | |
| 5.4 | Service user | `tcms` (no login shell needed), app in `/opt/tcms`, env file `/etc/tcms/tcms.env` (chmod 600) | |
| 5.5 | DNS name + TLS certificate for `https://tcms.<company-domain>` | | |
| 5.6 | Outbound access (only if used): SMTP relay host:port, `api.telegram.org:443`, Crew Desk API | | |

## 6. nginx reverse proxy

One `server` block; the app listens on `127.0.0.1:3000`, the WebSocket service on
`127.0.0.1:3003`. Nothing else is proxied (never port 3004).

```nginx
# http {} block — once
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name tcms.<company-domain>;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name tcms.<company-domain>;

    ssl_certificate     /etc/ssl/tcms/fullchain.pem;
    ssl_certificate_key /etc/ssl/tcms/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    # HSTS at the TLS terminator (the app also sends it; browsers honour it over HTTPS only)
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    client_max_body_size 12m;          # wiki uploads are capped at 10 MB by the app

    # WebSocket service (socket.io) — realtime notifications
    location /socket.io/ {
        proxy_pass http://127.0.0.1:3003;
        proxy_http_version 1.1;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        $connection_upgrade;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;    # REQUIRED: Secure session cookies
        proxy_read_timeout 90s;                         # REQUIRED: 25 s ping + 60 s timeout
        proxy_send_timeout 90s;
    }

    # The app (pages + /api)
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;  # per-IP login limit uses the last entry
        proxy_set_header X-Forwarded-Host  $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 90s;
    }
}
```

Details and Apache/IIS variants: `docs/deploy/reverse-proxy-websocket.md`.

## 7. Firewall

| Port | Where | Rule |
|---|---|---|
| 443 (+ 80 → redirect) | app server, from users' network | **allow** |
| 22 | app server, from IT admin network | allow (IT policy) |
| 3000, 3003 | app server | **deny** from outside (loopback only) |
| 3004 | app server | loopback only (the service binds `127.0.0.1`) |
| MySQL `<port>` | DB server | allow **only** from the app server IP |

## 8. Single app instance

Please run exactly **one** copy of the app and one copy of the WebSocket service (no
load-balancer pool, no autoscaling). Running two needs a Redis-backed redesign first
(docs/16 §5). Planned restarts (patching) are fine; the app reconnects to MySQL.

## 9. Backups

| # | Item | Plan | IT answer |
|---|---|---|---|
| 9.1 | Who owns database backups? | TCMS runs a nightly logical dump as `tcms_backup`; IT keeps its own server-level backups too (please confirm) | |
| 9.2 | Nightly dump (cron, user `tcms`) | `30 2 * * *  … node scripts/backup-scheduler.mjs --run-now` (02:30, server time) | |
| 9.3 | Staleness check (cron) | `15 * * * *  … node scripts/backup-scheduler.mjs --check-stale` (hourly; alerts admins in-app when the newest dump is > 26 h old) | |
| 9.4 | Retention | newest 14 dumps on the server (`BACKUP_KEEP=14`) | |
| 9.5 | Off-server copy | where to ship each dump (`BACKUP_SHIP_CMD`, e.g. rsync/S3) | `<target>` |
| 9.6 | Restore drill | one restore into `tcms_test` before go-live (`scripts/restore-mysql.sh`) — may we? | |

Exact cron lines: [`PRODUCTION-CHECKLIST.md` §5](./PRODUCTION-CHECKLIST.md#5-backups-cron-as-user-tcms).

## 10. Access for the TCMS team

| # | Item | IT answer |
|---|---|---|
| 10.1 | SSH (or sudo for `systemctl restart tcms-app tcms-ws`) for the app owner | |
| 10.2 | Read-only MySQL Workbench access for the manager (separate user, `SELECT` only) | |
| 10.3 | Contact + escalation path for DB / server incidents | |
