# 12 · Realtime Service & Deployment Architecture

> How the optional WebSocket mini-service works, and how the whole system maps onto
> **2026-10-14 MySQL migration note:** TCMS now runs on **MySQL 8.4** (utf8mb4, strict mode). Sections written for the former Vercel + Neon/Supabase PostgreSQL hosting are kept for history; DB-specific facts below have been updated where they matter operationally. See `docs/migration/` for the migration and cutover plan.
> Former target: Vercel + Neon (step-by-step in `DEPLOYMENT-GUIDE.md`). CURRENT: MySQL 8.4 — company server pending IT answers; sandbox rehearsal complete.

---

## 1. The realtime problem & the graceful-degradation answer

TCMS wants "bell badge increments the instant someone assigns you a review". Serverless
platforms (Vercel functions) cannot hold persistent WebSocket connections, so the
project splits delivery into two independent channels:

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
fully functional with the WS service switched off** — that is exactly what happens on
Vercel, and why the deployment guide calls realtime "degraded to refresh-visible".

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
| Deploy | optional: Railway/Render/Fly (needs a long-running process). On Vercel it simply isn't deployed |

Security note (updated 2026-10-14): the historical hole above is CLOSED. The `auth`
handler requires a valid 60-second HMAC ticket (shared `WS_NOTIFY_SECRET`, audience
`tcms-ws`; signature/exp/audience verified, `claimed === sub` enforced) and rejects +
disconnects everything else; `/notify` requires the `x-notify-secret` header and is
loopback-only; with no secret configured the service is fail-closed. Permanent
verifier: `node scripts/ws-auth-probe.mjs` (PASS=10 FAIL=0). Production CORS is
fail-closed as well — the service refuses to start when `WS_CORS_ORIGIN` is unset or
`*`. Reverse-proxy deployment recipes: `docs/deploy/reverse-proxy-websocket.md`.

## 3. Production topology on Vercel + Neon

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
                        ┌─────────────────────────────┐
  browser ── HTTPS ────▶│ Vercel edge network         │
                        │  └ Next.js build (static)   │
                        │  └ serverless functions      │
                        │     • page shell (/)         │
                        │     • /api/** route handlers │
                        └──────────┬──────────────────┘
                                   │ pooled connection string (-pooler, 6543)
                                   ▼
                        ┌─────────────────────────────┐
                        │ Neon PostgreSQL              │
                        │  14 tables · 10 JSONB        │
                        │  autosuspend after ~5 min    │
                        └─────────────────────────────┘
                                   ▲
                                   │ direct string (5432) — schema tools only
                        prisma db push / database-setup.sql / pgAdmin
```

### Why two connection strings (recap)
Serverless functions open many short-lived connections; Neon's **pooler** endpoint
(`-pooler`, port 6543) is built for exactly that and is what `DATABASE_URL` points to.
Operations that manage the schema (`db push`, pgAdmin) want the **direct** endpoint
(`DIRECT_URL`, port 5432). Both are set as env vars at deploy time.

### What Vercel runs
| Step | Command / source | Notes |
|---|---|---|
| install | `npm install` | `postinstall: prisma generate` builds the typed client |
| build | `next build` | verified: 16 routes, all `/api/**` dynamic, pages static — no DB at build time |
| serve | Vercel functions | `PORT` managed by the platform |

### Environment variables (the only three)
`DATABASE_URL` (pooled) · `DIRECT_URL` (direct) · `JWT_SECRET` (long random). Changing
them requires a **redeploy** to take effect.

### Behavioural differences vs local dev
| | Local (`npm run dev`) | Vercel |
|---|---|---|
| Realtime WS push | works (if mini-service runs on :3003) | refresh-visible — DB row shows on the next list fetch (page load / reconnect / tab re-visible); NO polling |
| Cold start | none | first request after ~5 min idle wakes Neon (3–8 s) |
| `localhost:3003` notify fetch | succeeds | fails silently (by design) |
| Seeding | `GET /api/seed` in browser | identical (`/api/seed`, idempotent) |
| Free-tier DB pause | n/a | Neon: sleeps after ~5 min; Supabase: 7-day pause **prevented by the daily keep-alive**; Aiven: never sleeps |

### The daily keep-alive cron — REMOVED 2026-10-14
The `/api/keep-alive` route and its Vercel Cron were deleted with the MySQL migration (MySQL has no free-tier pause; health checks use `GET /api`). The notes below are historical.
`vercel.json` schedules exactly one Vercel Cron job: a daily `GET /api/keep-alive`
(the Hobby plan's maximum frequency — which is enough). The endpoint runs
`SELECT 1` through Prisma, i.e. real database activity. Its purpose is free-tier
pause policy: Neon's ~5-minute sleep cannot be prevented by a daily ping, but
**Supabase** only pauses after 7 completely idle days — so the daily ping keeps a
free Supabase database awake forever — and **Aiven** never sleeps at all. The
endpoint is public because Vercel Cron sends unauthenticated GETs; it leaks nothing
(no data, `SELECT 1` only) and is safe to call from a browser too. Full switch-over
steps for Supabase/Aiven live in DEPLOYMENT-GUIDE.md, Appendix E.

## 4. Local development topology (for completeness)

```
npm run dev (Next.js :3000)  ←→  any PostgreSQL (DATABASE_URL = DIRECT_URL locally)
        │
        └─ notify fetch → localhost:3003 (mini-services/notifications, `bun --hot index.ts`)
```

Locally both Prisma URLs point at the same database, so `db push` and the app share one
string. A clean local DB is brought up either by Docker (`.env.example` has the exact
command) or by pointing at Neon and pasting `prisma/database-setup.sql` in the cloud
console — the deployment guide's Part 2 does the latter with zero local tools.

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
| Deploy an app change | push to GitHub → Vercel auto-deploys |
| Change a secret | Vercel → Settings → Environment Variables → **Redeploy** |
| Create tables on a fresh DB | paste `prisma/database-setup.sql` in Neon SQL Editor (or `npm run db:push`) |
| Load demo data | open `https://your-app/api/seed` once |
| Reset all data | `TRUNCATE … CASCADE` from the deployment guide FAQ Q7, then seed again |
| Inspect data | pgAdmin 4 (direct string + SSL Require) or Neon SQL Editor (`SELECT * FROM "TestCase"`) |
| Backups | Neon point-in-time (6 h free tier) / Neon branch / pgAdmin dump |
| Logs | Vercel dashboard → Deployments → Runtime Logs (`console.*` from routes appears here) |
