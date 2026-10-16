# 12 · Realtime Service & Deployment Architecture

> How the optional WebSocket mini-service works, and how the whole system maps onto
> TCMS runs on **MySQL 8.4** (utf8mb4, strict mode), one app instance behind nginx.
> Production steps: [`deploy/PRODUCTION-CHECKLIST.md`](./deploy/PRODUCTION-CHECKLIST.md);
> local Windows setup: [`LOCAL-SETUP-WINDOWS.md`](./LOCAL-SETUP-WINDOWS.md).

---

## 1. The realtime problem & the graceful-degradation answer

TCMS wants "bell badge increments the instant someone assigns you a review". The
WebSocket push is a separate, optional service, so the project splits delivery into
independent channels:

```
                     createNotification()                [lib/notifications.ts]
                            │
        ┌───────────────────┼────────────────────────┐
        ▼                   ▼                        ▼
  ① Database row      ② WS push (best-effort)   ③ Email / Telegram
  Notification        POST http://127.0.0.1:3004/notify   [lib/server/delivery.ts]
  INSERT → visible    → socket.io room user:{id}   per-user prefs (notify_email /
  on the client's       = INSTANT (when available) notify_telegram) + env config
  next list fetch —                                = sent | skipped | failed (never throws)
  page load / socket
  reconnect / tab
  re-visible. There
  are NO polling
  timers in the app.
  = GUARANTEED
```

All channels are try/catch-isolated; ② and ③ failing merely logs. **The system is
fully functional with the WS service switched off** — realtime then degrades to
"refresh-visible" (the row shows on the next list fetch).

## 2. mini-services/notifications — the WS relay

A deliberately tiny, **database-free** Bun/Node service (`socket.io ^4.8.1`, one file).

| Aspect | Detail |
|---|---|
| Listen | `WS_PORT` (default 3003), `socket.io` server on `WS_SOCKET_PATH` (default `/` outside production, `/socket.io/` when `NODE_ENV=production`), CORS from `WS_CORS_ORIGIN` (`*` in dev; production refuses to start when unset or `*`), ping 25 s / timeout 60 s |
| HTTP ingress | `POST /notify` on the loopback-only `NOTIFY_PORT` (default **3004**) — body `{ userId, …payload }` → `io.to('user:'+userId).emit('notification', payload)` → `{"ok":true}`; invalid JSON → 400; anything else 404. The broadcast endpoint needs its own listener because the `path: '/'` attachment makes engine.io intercept **every** request on 3003. The Next server targets it via `WS_NOTIFY_URL` (default `http://127.0.0.1:3004/notify`). |
| Client connect | browser hook `use-notification-socket.ts` connects same-origin on `NEXT_PUBLIC_WS_PATH` (default `/socket.io/`; the sandbox platform gateway overrides to `/?XTransformPort=3003` + path `/` via build-time env) with `transports: ['websocket','polling']` — reverse-proxy recipes in `docs/deploy/reverse-proxy-websocket.md` |
| Room join | client emits `auth { userId, token }` where token is a 60-second HMAC ticket minted by `GET /api/auth?path=ws-ticket` (httpOnly-cookie session); the server verifies signature/exp/audience AND `claimed === sub` before joining room `user:<sub>`; anything else → `auth-error` + disconnect |
| Push path | Next.js server (the only broadcaster) → per-user rooms → `notification` event → client store `addNotification` (cap 50, unread badge recompute) |
| Resilience | client: transport drops → socket.io manager retry (1 s → 10 s backoff); server disconnects (`io server disconnect`, e.g. expired ticket) → hook-managed reconnect with backoff (1 s → 30 s cap); a fresh 60 s ticket is minted per connection attempt via socket.io's `auth` callback and is single-use (stale-guarded memo — never reused across attempts); client teardown (`io client disconnect`) never reconnects; a definitive session death (ticket endpoint 401) stops the machinery (logout flow owns it); plus offline catch-up list refetch on reconnect and on tab re-visible (**no polling timers**); server: SIGTERM/SIGINT graceful close |
| Deploy | its own systemd service (`tcms-ws`) next to the app, behind nginx at `/socket.io/` (`docs/deploy/PRODUCTION-CHECKLIST.md` §3) |

Security note (updated 2026-10-14): the historical hole above is CLOSED. The `auth`
handler requires a valid 60-second HMAC ticket (shared `WS_NOTIFY_SECRET`, audience
`tcms-ws`; signature/exp/audience verified, `claimed === sub` enforced) and rejects +
disconnects everything else; `/notify` requires the `x-notify-secret` header and is
loopback-only; with no secret configured the service is fail-closed. Permanent
verifier: `node scripts/ws-auth-probe.mjs` (PASS=10 FAIL=0). Production CORS is
fail-closed as well — the service refuses to start when `WS_CORS_ORIGIN` is unset or
`*`. Reverse-proxy deployment recipes: `docs/deploy/reverse-proxy-websocket.md`.

## 3. Production topology (Linux + nginx + MySQL 8.4)

> ### ⚠️ SINGLE-INSTANCE ONLY — read this before running more than one server
>
> TCMS is engineered as a **single-instance application**. One Node process (one
> Next.js server, one notifications mini-service) holds live state that a second
> instance would not share:
>
> | In-process state | Where | Why a second instance breaks it |
> |---|---|---|
> | TTL cache (`src/lib/server/cache.ts`) | globalThis Map | Each node caches its own copy of stats aggregates and permission matrices. Writes invalidate the cache **on the writing node only** → other nodes serve stale data until their TTL expires (up to 5 min for stats). |
> | WebSocket hub (`notifications` mini-service) | in-memory socket map | A user connected to node A will never receive events emitted by node B — the event is only broadcast to A's local sockets. |
> | In-flight refresh coalescing, single-flight permission cache | per-process | Benign (correctness holds), but cache-warming happens per node. |
> | Session auth | **safe** | httpOnly-cookie JWT sessions are stateless for access tokens; refresh tokens live in MySQL 8.4 — any instance can validate/rotate them. |
>
> **What must change before scaling horizontally (multi-server / multi-region):**
> 1. **Redis** (or equivalent) replaces the in-process TTL cache — shared read-through
>    cache + shared invalidation events (pub/sub) so a write on any node invalidates
>    everywhere. `withCache()`/`invalidateCache()` are the only two call sites to swap.
> 2. **Redis pub/sub fan-out for notifications** — the mini-service subscribes to a
>    channel instead of an in-memory queue, and every node's socket hub relays to its
>    own connected clients (`src/lib/server/delivery.ts` is the single seam).
> 3. **Sticky sessions are NOT required** (cookie sessions are stateless), but the WS
>    gateway must allow any node to serve any socket.
> 4. MySQL `max_connections` sizing × instance count (pool is `connection_limit`
>    per process; see `scripts/start-tcms.sh` / `src/lib/db.ts`).
>
> Until then: run **one** Next.js instance (+ the one notifications mini-service)
> and scale vertically (bigger box, bigger `connection_limit`).

```
  browser ── HTTPS :443 ──▶ nginx (TLS, reverse proxy)
                              ├─ /            ──▶ Next.js app   127.0.0.1:3000  (.next/standalone/server.js)
                              └─ /socket.io/  ──▶ notifications 127.0.0.1:3003  (loopback broadcast :3004)
                                                        │
  Next.js app ── pooled connection (connection_limit) ──▶ MySQL 8.4 (company IT server)
```

Two systemd services (`tcms-app`, `tcms-ws`); the firewall allows only 80/443.
Details, env file and go-live order: [`deploy/PRODUCTION-CHECKLIST.md`](./deploy/PRODUCTION-CHECKLIST.md);
nginx block: [`deploy/reverse-proxy-websocket.md`](./deploy/reverse-proxy-websocket.md).

### Connection strings
`DATABASE_URL` is the app user (DML only). `DIRECT_URL` is the migrate user used by
`prisma migrate deploy` (DDL only). Both are `mysql://` URLs; the app refuses anything else.

### Health and safety switches
| | |
|---|---|
| `GET /api` | liveness |
| `GET /api/ready` | readiness — 503 when MySQL is down |
| `TCMS_READ_ONLY=true` | every write answers 503 (sign-in and reading keep working) |
| `TCMS_DEPLOY_ENV=production` | turns on the startup guard (refuses unsafe settings) |


## 4. Local development topology (Windows)

```
npm run dev (scripts/dev-tcms.mjs → next dev :3000)  ←→  MySQL 8.4 at 127.0.0.1:5500 (tcms_test)
        │
        └─ notify fetch → localhost:3003 (mini-services/notifications, optional)
```

`npm run dev` refuses a non-MySQL `DATABASE_URL`. Schema: `npx prisma migrate deploy`.
Full steps: [`LOCAL-SETUP-WINDOWS.md`](./LOCAL-SETUP-WINDOWS.md).

## 6. External notification delivery — email & Telegram

`src/lib/server/delivery.ts` fans every `createNotification()` call out to the
recipient's configured channels. Delivery is **per-user opt-in** (Settings →
Profile → `notifyEmail` / `notifyTelegram` + `telegramChatId`) and
**environment-gated** — an unconfigured channel is *skipped* with a log line,
never an error. Each send is timeout-guarded and failure-isolated; results
(`sent | skipped | failed` + reason) are logged per notification.

| Channel | Requires (env) | Notes |
|---|---|---|
| In-app (always) | — | the DB row is the guaranteed channel, gated by `notify_inapp` |
| Email | `SMTP_HOST`, optional `SMTP_PORT` (default 587), `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE` (`true` for 465) | nodemailer (dynamic import — zero cost when unconfigured) |
| Telegram | `TELEGRAM_BOT_TOKEN` + the user's `telegramChatId` (get a chat id by messaging the bot, then `GET /bot<token>/getUpdates`) | Bot API `sendMessage`, 5 s timeout |

Events that notify: review assigned / approved / failed / needs-revision,
comments, bug assignment, test-case updates, module creation, and **password
changed** (security alert — also revokes all of the user's refresh tokens).
Verify with `TCMS_BASE_URL=http://localhost:3000 node scripts/verify-notifications.mjs`.

## 7. Operations quick reference

| Task | How |
|---|---|
| Deploy an app change | checkout the release tag → `npm ci` → `npm run build` → restart `tcms-app` (PRODUCTION-CHECKLIST §3) |
| Change a secret | edit `/etc/tcms/tcms.env` → restart the service (`NEXT_PUBLIC_*` needs a rebuild) |
| Create tables on a fresh DB | `npx prisma migrate deploy` (applies `prisma/migrations/`) |
| First admin | `scripts/create-first-vp.mjs` (doc 17 §6) |
| Pause all writes | `TCMS_READ_ONLY=true` + restart |
| Inspect data | MySQL Workbench / `mysql` client with a read-only user |
| Backups | nightly `mysqldump` via `scripts/backup-scheduler.mjs` (doc 17 §2) |
| Logs | `journalctl -u tcms-app` / `journalctl -u tcms-ws` |

