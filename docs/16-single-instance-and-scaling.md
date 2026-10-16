# 16 · Single-Instance Limitation & the Scaling Path

> **Status:** verified against the codebase 2026-10-02 (pre-launch checklist item 3).
> **The one-line rule:** TCMS is **single-instance only** in its current form. Run exactly ONE
> **2026-10-14 MySQL migration note:** TCMS now runs on **MySQL 8.4** (utf8mb4, strict mode). Sections written for the former Vercel + Neon/Supabase PostgreSQL hosting are kept for history; DB-specific facts below have been updated where they matter operationally. See `docs/migration/` for the migration and cutover plan.
> Node server process (plus its one WebSocket relay and one MySQL 8.4 database). Running two
> or more app servers today produces wrong-ish behavior — stale screens, missed notifications,
> duplicated work — not an error page. This document explains exactly why, what keeps working,
> what breaks, and the concrete Redis migration checklist required before horizontal scaling.

---

## 1. The supported topology (and why it is a design decision, not an accident)

```
   Browsers ──► ONE Next.js server (:3000)
                   │  in-process TTL cache (stats, aggregates)
                   │  in-process permission-override cache
                   │  Prisma pool (connection_limit per process)
                   ▼
             ONE MySQL 8.4
                   ▲
   Browsers ──► ONE WS relay (:3003) ◄── loopback HTTP POST /notify from the app
```

The app deliberately keeps two kinds of state **inside the server process** for speed and
simplicity: a generic read-through TTL cache and the realtime fan-out registry. Both were
reasonable choices for the deployment reality (one internal server, an internal QA team, or
Vercel's serverless model where each function instance is ephemeral). They are the reason the
system is not yet horizontally scalable. Nothing about the four-layer API architecture,
raw-SQL repositories, or the database schema prevents scaling — the boundary is process-local
state, and it is confined to the four components listed in §2.

---

## 2. Inventory of in-process state (the exact files involved)

| # | Component | File | Mechanism | Multi-instance symptom |
|---|-----------|------|-----------|------------------------|
| 1 | Generic TTL cache | `src/lib/server/cache.ts` | `Map` on `globalThis`; 500-entry cap; read-through `withCache()` coalesces concurrent misses; write paths call `invalidateCache(prefix)` | Instance A handles a write and invalidates **its own** keys; instance B keeps serving its stale copy until the entry's TTL passes (≤5 s today) |
| 2 | Stats aggregate cache | `src/app/api/stats/stats.service.ts` (`STATS_CACHE_TTL_MS = 5_000`) | entry #1, keyed `stats:aggregates` | Dashboard counters differ between instances for up to 5 s after a mutation |
| 3 | Permission-override cache | `src/lib/permissions.ts` (`PERMISSION_CACHE_TTL_MS = 3_000`) | in-proc `Map`, DB-backed, refreshed (TTL-gated) on every `requireUser()` | A VP toggles a permission; instances other than the one that served the toggle keep enforcing the old matrix for ≤3 s. **Bounded and small — this one degrades gracefully** (see §4) |
| 4 | WebSocket relay registry | `mini-services/notifications/index.ts` (`socketsByUser` Map + loopback `POST /notify` broadcast) | the app POSTs notifications to `127.0.0.1:<NOTIFY_PORT>`; the relay pushes to sockets **in its own process** | Users whose socket is connected to relay #2 never receive events broadcast through relay #1 — **silent message loss, the hard breaker** |
| 6 | Per-IP login limit | `src/lib/server/login-rate-limit.ts` (failed sign-ins per IP, 30 / 15 min by default) | in-proc `Map`, 10 000-IP cap | Each instance counts separately: an attacker spread over N instances gets N × the limit. The per-email lockout (`login_attempts` table) still holds across instances |
| 5 | Prisma connection pool | `src/lib/db.ts` (`connection_limit=40&pool_timeout=10`) | per-process pool | Not a correctness break, a capacity break: N instances × 40 connections must stay under MySQL `max_connections` (sandbox 200; confirm the company server's limit with IT) |

---

## 3. What already survives multi-instance (important — do not "fix" these)

The session/auth layer was deliberately built **stateless + database-backed**, so it is safe
to run behind a load balancer *today*:

- **Access token** — a signed JWT (`src/lib/auth.ts`). Any instance verifies it with the same
  `JWT_SECRET`; no server-side session store exists to share.
- **Refresh tokens** — rows in the `refresh_tokens` table with rotation + a grace window
  (`grantRotationGrace`, `REFRESH_ROTATION_GRACE_SECONDS`). Two instances can serve the same
  browser safely; the grace window absorbs rotation races instead of logging the user out.
- **Brute-force lockout** — the `login_attempts` table (5 failures → 60 s lock) is read and
  written through SQL, so the counter is global, not per-instance.
- **CSRF** — `assertSameOrigin()` (`src/lib/api.ts`) is stateless (Origin/Host match +
  `X-Requested-With` header). SameSite=Lax cookies need no shared state either.
- **All CRUD flows** — the repositories are pure SQL against one MySQL 8.4; any instance
  sees the same data.
- **keep-alive cron** — REMOVED with the MySQL migration (no free-tier pause to fight); whichever
  instance receives it does the work.

---

## 4. Concrete failure modes if you run 2+ servers today

1. **Missed realtime notifications (guaranteed).** The relay registry is process-local. With
   two app servers pointing at two relays (or one relay behind a non-sticky LB), a user's
   socket receives only the events published through the process it happens to be connected
   to. There is no error anywhere — messages just silently do not arrive. Realtime degrades
   to refresh-visible delivery (there is NO polling fallback), and that fallback's
   correctness assumes events were persisted (they
   are — the `notifications` table is shared), so the worst case is *late* delivery rather
   than permanent loss. Still: do not run two relays without §5.3.
2. **Bounded stale reads (annoying, not corrupting).** After instance A processes a mutation,
   instance B may serve cached dashboard aggregates for up to 5 s. With short TTLs the blast
   radius is small — but it violates the "write then immediately see it" expectation a QA
   team legitimately has.
3. **Permission-toggle propagation lag (≤3 s).** Because `requireUser()` refreshes the
   override cache TTL-gated, a toggle performed on instance A is enforced by instance B
   within 3 s. For *authorization* this is a real (if brief) window where a revoked role can
   still act on instance B. Acceptable for an internal tool only if documented — this doc is
   that record.
4. **Connection-pool exhaustion at the database.** Two instances at `connection_limit=40`
   will happily open 80 MySQL connections. On the shared company MySQL server this is the
   first resource to blow up under load, typically as
   `pool_timeout` errors on instance B while instance A looks healthy.

---

## 5. What must change BEFORE running more than one server (Redis checklist)

Work through this list top-down; item 1 unblocks items 2–3.

### 5.1 Move the generic TTL cache to Redis
- Replace `cacheGet/cacheSet/invalidateCache` internals with Redis `GET/SET PX`/deletion.
- Prefix invalidation: keep the `invalidateCache(prefix)` call-sites unchanged, implement
  with `SCAN MATCH prefix*` + `DEL` in a pipeline (or maintain a Redis SET per prefix to make
  invalidation O(members) instead of a SCAN).
- Keep the in-proc inflight coalescing (`__tcmsCacheInflight`) as-is — collapsing concurrent
  misses per process is still desirable even with a shared backend.
- **Acceptance test:** two local servers on :3000/:3001; mutate through :3000 and verify the
  next read through :3001 reflects it immediately.

### 5.2 Make permission toggles propagate instantly (or prove 3 s is acceptable)
- Option A (recommended): publish an invalidation event on a Redis pub/sub channel
  (`tcms:permissions:changed`) from the toggle endpoint; every instance subscribes and calls
  `ensurePermissionsLoaded(force=true)`. Sub-second, removes the authorization caveat in §4.3.
- Option B: keep the 3 s TTL and document the window (it already behaves this way on Vercel).

### 5.3 Fan the WebSocket relay out through Redis pub/sub
- The relay currently receives events via loopback HTTP and pushes to its own sockets.
  Change the ingestion to: app → `PUBLISH tcms:notify <payload>`; **every** relay instance
  subscribes and pushes to **its** sockets. Then N relays behind a load balancer deliver every
  event to every connected user.
- Interim alternative without Redis: sticky sessions at the load balancer (all sockets of a
  user land on one relay) + keep exactly ONE relay process while scaling only the HTTP tier.

### 5.4 Size the connection budget per instance count
- Formula: `instances × connection_limit (+ relay/admin overhead) ≤ database max_connections`.
- Lower `connection_limit` per instance as you add instances (e.g. 4 instances → 10 each), or
  put PgBouncer in front and point `DATABASE_URL` at it.

### 5.5 Operational gates for the first multi-instance deploy
- Health check per instance (`/api` returns `{"status":"ok"}`) wired into the LB.
- Prefer a rolling deploy (new instance up, health-checked, then old one drained) — the
  refresh-grace window already tolerates a restart mid-session.
- Do NOT shard the WS relay without 5.3 in place.
- Rate limiting, if you ever add it in-memory, must live in Redis instead (the DB-backed
  login lockout needs no change).

### 5.6 What explicitly does NOT need to change
- Sessions/JWT/refresh rotation, CSRF, the login lockout, activity logs, all repositories,
  the schema, and the four-layer API architecture. The `login_attempts` and `refresh_tokens`
  tables are already the "shared state" for those flows.

---

## 6. Scaling headroom BEFORE Redis (what the load test says)

Measured on the sandbox (production build; re-verified on real MySQL 8.4 2026-10-14 — 200 VU: ~33k req, 0 errors on read paths; script:
`scripts/loadtest.mjs`):

| Scenario | rps | p50 | p99 | errors |
|---|---|---|---|---|
| Mixed reads @ 25 VU (1× expected peak) | 708 | 34 ms | 75 ms | 0 |
| Mixed reads @ 50 VU (2×) | 693 | 71 ms | 151 ms | 0 |
| Stretch @ 100 VU | 703 | 143 ms | 251 ms | 0 |
| Login storm @ 25 VU | 12.3 | 1.83 s | 4.26 s | 0 |
| Write (create test case) @ 5 VU | 437 | 10 ms | 27 ms | 0 |

Throughput plateaus near ~700 rps because a single Node process saturates (the 100-VU stretch
only raises latency, it does not buy rps). That ceiling is roughly 25–50× what an internal
QA team's interactive clicking produces — vertical headroom (pool size, MySQL tuning,
indexes) covers growth long before horizontal scaling is warranted. The known per-endpoint
slow points are login (bcrypt cost 10 — a deliberate security tradeoff, ~12 logins/s sustained)
and the two JOIN-heavy lists `GET /api/test-cases` and `GET /api/activity-logs` (p50 ≈ 50 ms,
p99 ≈ 117 ms — comfortably within budget).

---

## 7. Verification checklist after any scaling change

1. `npx tsc --noEmit` and `npm run build` clean.
2. `bash scripts/verify-battery.sh` — 65/65 (cookie session, CSRF, review-integrity, expiry).
3. `node scripts/e2e-verify-routes-reviews-delete.mjs` — 34/34 browser flows.
4. Two-instance acceptance from §5.1: mutate on :3000, read on :3001, no staleness.
5. Load test at 1× and 2× expected users (`node scripts/loadtest.mjs`); compare rps/p99 with §6.
6. Confirm notifications arrive on sockets served by BOTH instances (§5.3 acceptance).
