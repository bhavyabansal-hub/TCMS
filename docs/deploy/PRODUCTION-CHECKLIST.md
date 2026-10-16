# TCMS — Production checklist (Linux + nginx, single instance)

> Written 2026-10-16. One page for the person who installs TCMS on the company server.
> What IT must provide first: [`it-request-mysql.md`](./it-request-mysql.md).
> Background: `.env.example` (every key, annotated), `docs/deploy/reverse-proxy-websocket.md`
> (nginx/WS details), `docs/deploy/operations-runbook.md` (backup, restore, first admin),
> `docs/architecture/HLD.md` (why one instance). Production is a fresh start
> (decision D2): empty MySQL + first VP (§4).

Topology: **nginx (TLS, :443)** → **Next.js app** (`127.0.0.1:3000`) + **notifications WS
service** (`127.0.0.1:3003`, loopback broadcast `127.0.0.1:3004`) → **MySQL 8.4** (IT).
Exactly **one** app instance and **one** WS service (in-memory caches, login limiter and
socket registry are per process — `docs/architecture/HLD.md`).

---

## 1. Environment (`/etc/tcms/tcms.env`, owner `tcms`, `chmod 600`)

Generate every secret fresh on the server: `openssl rand -hex 32` (≥ 32 characters; the
startup guard refuses shorter, placeholder or sandbox values and names the variable).

### 1.1 Required

| Key | Production value | Notes |
|---|---|---|
| `TCMS_DEPLOY_ENV` | `production` | Arms the startup guard + DB-settings guard in BOTH processes. Never set it anywhere else. |
| `DATABASE_URL` | `mysql://tcms_app:<pw>@<db-host>:<port>/tcms?sslaccept=strict&connection_limit=40&pool_timeout=10` | App user, **DML only**. Non-root, real password, not the sandbox `127.0.0.1:5500`. Percent-encode special characters in `<pw>`. |
| `DIRECT_URL` | `mysql://tcms_migrate:<pw>@<db-host>:<port>/tcms?sslaccept=strict` | Migration user (DDL). Used only by `npx prisma migrate deploy`. |
| `BACKUP_DATABASE_URL` | `mysql://tcms_backup:<pw>@<db-host>:<port>/tcms` | Read-only dump user for `scripts/backup-db-mysql.sh`. |
| `JWT_SECRET` | `openssl rand -hex 32` | Signs sessions. Changing it signs everyone out. |
| `WS_NOTIFY_SECRET` | `openssl rand -hex 24` (≥ 32 chars) | Shared by app + WS service (tickets and `/notify`). Same value in both processes. |
| `WS_CORS_ORIGIN` | `https://tcms.<company-domain>` | WS service refuses to start when unset or `*`. |
| `TCMS_PUBLIC_ORIGIN` | `https://tcms.<company-domain>` | Public URL used in links (Crew Desk comments). |

### 1.2 Must stay OFF / unset in production

| Key | Value | Why |
|---|---|---|
| `TCMS_ENABLE_SEED` | unset | Demo seed is refused by the guard; the first admin comes from `scripts/create-first-vp.mjs` (§4). |
| `TCMS_ALLOW_SIGNUP` | `false` (or unset) | Self-signup off — accounts are created by a VP in Settings → Users. |
| `NEXT_PUBLIC_ALLOW_SIGNUP` | `false` (or unset) | Build-time twin: hides the Register tab. **Set before `npm run build`.** |
| `TCMS_READ_ONLY` | unset / `false` | Set `true` only during maintenance (all writes → 503, sign-in still works). |
| `TCMS_LOG_SQL` | unset / `false` | `true` prints every SQL statement (`prisma:query`) — debugging only. |

### 1.3 Realtime (WebSocket)

| Key | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_WS_URL` | empty | Same origin through nginx. **Build-time** — set before `npm run build`. |
| `NEXT_PUBLIC_WS_PATH` | `/socket.io/` | Build-time; must equal `WS_SOCKET_PATH`. |
| `WS_SOCKET_PATH` | `/socket.io/` (default in production) | |
| `WS_PORT` | `3003` (default) | Private; firewall blocks it. |
| `NOTIFY_PORT` | `3004` (default) | Loopback only. |
| `WS_NOTIFY_URL` | `http://127.0.0.1:3004/notify` (default) | App → WS broadcast. |

### 1.4 Backups

| Key | Value | Notes |
|---|---|---|
| `TCMS_BACKUP_DIR` | `/opt/tcms/backups` | **Required** for the app's daily stale-backup check: the scheduler always writes to `<repo>/backups`, but the app runs from `.next/standalone`, so without this it looks in the wrong folder and stays silent. Put `/opt/tcms/backups` on a disk with room for 14 dumps. |
| `BACKUP_AT` | `02:30` | Only for the optional scheduler daemon; with cron (§5) the cron line decides. |
| `BACKUP_KEEP` | `14` | Newest N dumps kept. |
| `BACKUP_SHIP_CMD` | e.g. `rsync -a {file} backup-host:/srv/tcms/` | Off-server copy after each dump (recommended). |

### 1.5 Optional channels and tuning

| Key | Default | Notes |
|---|---|---|
| `SMTP_HOST` `SMTP_PORT` `SMTP_SECURE` `SMTP_USER` `SMTP_PASS` `SMTP_FROM` | unset | Email channel. Test: `node scripts/send-test-notification.mjs --email=<you>` |
| `TELEGRAM_BOT_TOKEN` | unset | Telegram channel. Test: `node scripts/send-test-notification.mjs --chat=<id>` |
| `TELEGRAM_LOG_BOT_TOKEN` `TELEGRAM_LOG_CHAT_ID` `TELEGRAM_LOG_LEVEL` `TELEGRAM_LOG_MIN_INTERVAL_MS` | unset / `error` / `2000` | Ops log mirror to a Telegram chat. |
| `LOG_DIR` `LOG_RETENTION_DAYS` | `logs` / `14` | Rotating `app-*.log` / `error-*.log`. Use `/var/log/tcms`. |
| `TCMS_LOGIN_IP_MAX_FAILURES` `TCMS_LOGIN_IP_WINDOW_SECONDS` | `30` / `900` | Per-IP failed sign-in limit → 429. |
| `TCMS_EXTRA_ALLOWED_HOSTS` | unset | Only if a gateway rewrites the Host header. |
| `CREWDESK_*` | unset | Crew Desk integration; leave `CREWDESK_MODE=test` (one ticket) until the owner approves `live`. |
| `NODE_ENV` | set by `next start` | Do not use it as the production switch (that is `TCMS_DEPLOY_ENV`). |

---

## 2. MySQL server settings IT must confirm (the app refuses to start otherwise)

`sql_mode` contains `STRICT_TRANS_TABLES` and `ONLY_FULL_GROUP_BY` (8.4 default) ·
`time_zone = '+00:00'` · `character_set_server = utf8mb4`, schema default `utf8mb4` /
`utf8mb4_unicode_ci` · persisted in `my.cnf`. TLS on. Details and grants:
[`it-request-mysql.md`](./it-request-mysql.md).

---

## 3. Build and start both processes (systemd)

```bash
# as user tcms, in /opt/tcms (git checkout of the release tag)
set -a; . /etc/tcms/tcms.env; set +a      # NEXT_PUBLIC_* must be in place BEFORE the build
npm ci
npx prisma migrate deploy                 # uses DIRECT_URL; second run prints "No pending migrations"
npm run build                             # output: standalone (.next/standalone/server.js)
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public
(cd mini-services/notifications && bun install --frozen-lockfile)
```

`/etc/systemd/system/tcms-app.service`

```ini
[Unit]
Description=TCMS app (Next.js)
After=network-online.target

[Service]
User=tcms
WorkingDirectory=/opt/tcms/.next/standalone
EnvironmentFile=/etc/tcms/tcms.env
Environment=HOSTNAME=127.0.0.1 PORT=3000
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/tcms-ws.service`

```ini
[Unit]
Description=TCMS notifications WebSocket service
After=network-online.target

[Service]
User=tcms
WorkingDirectory=/opt/tcms/mini-services/notifications
EnvironmentFile=/etc/tcms/tcms.env
ExecStart=/usr/local/bin/bun index.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tcms-app tcms-ws
journalctl -u tcms-app -n 20    # must show: [TCMS] production guard ACTIVE  +  [TCMS] db-settings OK: ...
journalctl -u tcms-ws  -n 20    # must show: production guard ACTIVE + "running on port 3003 (path '/socket.io/', cors https://..., ticket auth ENABLED)"
```

nginx: the server block in [`it-request-mysql.md` §6](./it-request-mysql.md#6-nginx-reverse-proxy)
(TLS, HSTS, `/socket.io/` WebSocket location with `Upgrade`/`Connection`,
`X-Forwarded-Proto`, `proxy_read_timeout 90s`).

---

## 4. First admin

```bash
cd /opt/tcms && set -a; . /etc/tcms/tcms.env; set +a
node scripts/create-first-vp.mjs --email=<it.admin@company> --name="<Full Name>"   # hidden password prompt
```

Refuses when an active VP already exists. Everyone else is added by that VP in
Settings → Users (`docs/deploy/operations-runbook.md` §6).

---

## 5. Backups (cron, as user `tcms`)

```cron
# m  h  dom mon dow  command
30   2  *   *   *    cd /opt/tcms && set -a && . /etc/tcms/tcms.env && set +a && node scripts/backup-scheduler.mjs --run-now     >> /var/log/tcms/backup.log 2>&1
15   *  *   *   *    cd /opt/tcms && set -a && . /etc/tcms/tcms.env && set +a && node scripts/backup-scheduler.mjs --check-stale >> /var/log/tcms/backup.log 2>&1
```

- `--run-now`: one `mysqldump` as `tcms_backup`, verified (`Dump completed` footer), pruned
  to `BACKUP_KEEP`, shipped with `BACKUP_SHIP_CMD`; exit ≠ 0 on failure.
- `--check-stale`: exit 1 + in-app alert to every `manage_users` holder when the newest
  valid dump is older than 26 h. The app runs the same check daily as a second net.
- Restore drill before go-live: `bash scripts/restore-mysql.sh --file <dump>` into a
  scratch schema (`docs/deploy/operations-runbook.md` §2.1). Requires the `mysql` / `mysqldump` 8.4 client binaries.

---

## 6. Go-live steps (in order)

1. [ ] IT request answered; DB users, grants, TLS and server settings in place (§2).
2. [ ] `/etc/tcms/tcms.env` filled per §1; secrets fresh; seed + signup off.
3. [ ] Build + `prisma migrate deploy` + both services started (§3); both logs show
       `production guard ACTIVE`, app log shows `db-settings OK`.
4. [ ] nginx reloaded (`nginx -t` first); firewall allows only 80/443 inbound (3000/3003/3004 closed).
5. [ ] `curl -s https://tcms.<domain>/api` → `{"status":"ok"...}` and `/api/ready` →
       `{"status":"ready","database":"ok","readOnly":false}`.
6. [ ] `curl -sI https://tcms.<domain>/login` shows `Strict-Transport-Security`,
       `Content-Security-Policy … frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`.
7. [ ] First VP created (§4); sign in; create one test user per role you need.
8. [ ] Smoke flow: create a module + test case, submit for review, record a verdict, open
       a bug and assign it → the assignee's bell updates live (WS) .
9. [ ] Optional channels: `node scripts/send-test-notification.mjs --email=… --chat=…` → OK.
10. [ ] One `--run-now` backup completed and one restore drill done (§5); cron installed.
11. [ ] Maintenance switch known: set `TCMS_READ_ONLY=true` + `systemctl restart tcms-app`
        before risky operations; unset + restart afterwards.
12. [ ] Rollback plan agreed: previous release tag noted for an application rollback
        (`docs/deploy/operations-runbook.md` §2.2); last verified mysqldump for a data rollback (`docs/deploy/operations-runbook.md` §2.1).
