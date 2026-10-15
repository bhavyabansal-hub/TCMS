# Deploy · Reverse proxy & WebSocket for realtime notifications

> How to put nginx / Apache / IIS in front of TCMS so browsers reach the
> notification socket service in production. Sandbox-only gateway mechanics
> (`?XTransformPort=` query-param proxying) are NOT used in production and are
> not covered here beyond the migration note at the end.

---

## 1. Topology

```
browser ── HTTPS :443 ──▶ reverse proxy (nginx / Apache / IIS)
                            ├── /              ──▶ Next.js  :3000   (app + /api/**)
                            ├── /socket.io/    ──▶ WS service :3003  (realtime notifications)
                            └── (nothing)      ──▶ :3004             (loopback /notify — NEVER proxied)
```

- The browser socket connection is **same-origin** (`NEXT_PUBLIC_WS_URL` empty,
  `NEXT_PUBLIC_WS_PATH=/socket.io/` — the code defaults) — no second hostname,
  no second TLS certificate, no cookie changes.
- The socket handshake itself carries **no credentials**: the client fetches
  `GET /api/auth?path=ws-ticket` like any other API call (the httpOnly
  `tcms-access` cookie authenticates it), then presents the 60-second signed
  ticket inside the socket `auth` event. Only the ticket-fetch needs cookies,
  and it is same-origin, so proxying the app normally is enough.
- Port **3003** must stay server-private (firewall). Port **3004** is the
  server-to-server broadcast endpoint — it binds `127.0.0.1` and must never be
  reachable from any network.

## 2. Environment variables involved

| Variable | Side | Default | Meaning |
|---|---|---|---|
| `NEXT_PUBLIC_WS_URL` | client, **build-time** | `''` (same origin) | Socket server URL. Leave empty behind a single reverse proxy. |
| `NEXT_PUBLIC_WS_PATH` | client, **build-time** | `/socket.io/` | socket.io path. Must equal `WS_SOCKET_PATH`. |
| `WS_PORT` | service, runtime | `3003` | Public socket listener (keep private). |
| `WS_SOCKET_PATH` | service, runtime | `/socket.io/` when `TCMS_DEPLOY_ENV=production`, `/` otherwise | socket.io path — must equal `NEXT_PUBLIC_WS_PATH`. |
| `WS_CORS_ORIGIN` | service, runtime | `'*'` in dev | Comma-separated browser origins. **Production refuses to start when unset or `*`.** |
| `WS_NOTIFY_SECRET` | app + service | — | Shared HMAC secret for WS tickets + `/notify`. Fresh value per deployment (`openssl rand -hex 24`). |
| `WS_NOTIFY_URL` | app, runtime | `http://127.0.0.1:3004/notify` | Where the app posts broadcasts. Loopback only. |

`NEXT_PUBLIC_*` values are inlined into the client bundle at **build time** —
after changing them, rebuild (`npm run build`) and restart.

## 3. nginx (recommended)

**Step 1 — connection-upgrade map, exactly once, in the `http {}` block** (it
is a plain variable map; it cannot live inside `server {}`):

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

**Step 2 — the proxy location, in the `server {}` block that terminates TLS
for the app host:**

```nginx
location /socket.io/ {
    proxy_pass http://127.0.0.1:3003;
    proxy_http_version 1.1;

    # WebSocket upgrade
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection $connection_upgrade;

    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;

    # REQUIRED: TCMS sets the `Secure` cookie flag based on this header
    # (src/lib/server/auth-cookies.ts isSecureRequest). Without it, session
    # cookies fall back to non-Secure over what is actually HTTPS.
    proxy_set_header X-Forwarded-Proto $scheme;

    # Keep quiet sockets alive: service pings every 25 s with a 60 s timeout.
    # The nginx default (60 s) would drop idle sockets mid-ping-cycle.
    proxy_read_timeout 90s;
    proxy_send_timeout 90s;
}
```

Notes:
- `proxy_read_timeout >= 90s` is mandatory (25 s ping interval + 60 s ping
  timeout + margin).
- The same `location` transparently carries socket.io's HTTP long-polling
  fallback transport (normal request/response — no upgrade headers needed;
  the `$connection_upgrade` map resolves to `close` there, which is correct).
- Do **not** add a `location` for `/notify` or port 3004 — nothing browser-facing
  exists there.

## 4. Apache (httpd 2.4)

Requires `mod_proxy`, `mod_proxy_http`, `mod_proxy_wstunnel`, `mod_headers`:

```apache
# WebSocket transport (upgrade)
ProxyPass        "/socket.io/" "ws://127.0.0.1:3003/socket.io/"
ProxyPassReverse "/socket.io/" "ws://127.0.0.1:3003/socket.io/"

# HTTP long-polling transport (same path, plain HTTP)
ProxyPass        "/socket.io/" "http://127.0.0.1:3003/socket.io/"
ProxyPassReverse "/socket.io/" "http://127.0.0.1:3003/socket.io/"

# Apache's ws:// ProxyPass forwards Upgrade/Connection itself.
# When terminating TLS, make sure the app sees HTTPS:
RequestHeader set X-Forwarded-Proto "https"
ProxyPreserveHost On
```

(Both `ProxyPass` lines are intentional: the `ws://` variant claims the upgrade
requests, the `http://` variant serves socket.io's HTTP long-polling transport. Apache matches
them in order.) With `mod_ssl` enabled, `X-Forwarded-Proto` may already be set
by `SSLProxyEngine`-adjacent recipes — verify with a request dump rather than
assuming.

## 5. IIS

IIS has no native reverse proxy. Required Windows features/components:

1. **WebSocket Protocol** server feature (`Install-WindowsFeature Web-WebSocket` /
   "WebSocket Protocol" under IIS → Application Development) — without it IIS
   rejects `Upgrade: websocket` requests outright.
2. **Application Request Routing (ARR)** with "Enable proxy" checked in ARR →
   Server Proxy Settings.
3. **URL Rewrite** rule for the socket path:
   - Match URL: pattern `^socket\.io/(.*)`, ignore case.
   - Action: Rewrite to `http://127.0.0.1:3003/socket.io/{R:1}`.
   - ARR forwards the WebSocket upgrade automatically when the WebSocket
     feature is installed.

Then set the forwarded protocol so cookies get the `Secure` flag — in the
site's `web.config` (ARR section) or via URL Rewrite server variables:

```xml
<rewrite>
  <rules>
    <rule name="tcms-socket" stopProcessing="true">
      <match url="^socket\.io/(.*)" ignoreCase="true" />
      <action type="Rewrite" url="http://127.0.0.1:3003/socket.io/{R:1}" />
      <serverVariables>
        <set name="HTTP_X_FORWARDED_PROTO" value="https" />
      </serverVariables>
    </rule>
  </rules>
</rewrite>
```

(`HTTP_X_FORWARDED_PROTO` must be in the allowed server-variable list; the
site's idle timeout — default 120 s — comfortably exceeds our 85 s quiet
period, but raise `proxy` timeout if you tune it lower.)

## 6. Firewall posture

| Port | Bind | Exposure |
|---|---|---|
| 80 / 443 | reverse proxy | **public** |
| 3000 | Next.js | private (loopback / LAN) |
| 3003 | WS service (`WS_PORT`) | **private — never public** (it has ticket auth, but private + proxied path is the defense-in-depth posture) |
| 3004 | `/notify` broadcast | **loopback only** — hard-bound to `127.0.0.1`; never route a proxy to it |

Example (ufw): `ufw allow 80,443/tcp` and nothing else; on iptables, deny
inbound to 3000/3003/3004 on the public interface.

## 7. Service startup contract (fail-closed)

- `TCMS_DEPLOY_ENV=production` + `WS_CORS_ORIGIN` unset or `*` → the service
  **prints a FATAL line and exits 1** before binding anything. This is
  deliberate. (Keyed on the explicit `TCMS_DEPLOY_ENV` switch, NOT on
  `NODE_ENV` — a plain `bun index.ts` sets no NODE_ENV, so a NODE_ENV key
  would silently never fire on a real server.)
- The SAME switch arms the production secret guard on BOTH processes: any
  missing / too-short / placeholder secret (JWT_SECRET, WS_NOTIFY_SECRET,
  DATABASE_URL rules, TCMS_ENABLE_SEED, sandbox defaults) → named-variable
  FATAL lines (never values) and **exit 1 before any port is opened**.
  Contract: `src/lib/server/startup-guard.ts` + `.env.example`.
- `WS_NOTIFY_SECRET` missing → in the SANDBOX the service still starts
  (fail-closed, joins no rooms — banner prints `FAIL-CLOSED`); under
  `TCMS_DEPLOY_ENV=production` it now refuses to start outright. In-app rows
  still deliver via the client's list fetches (page load / socket reconnect /
  tab re-visible; there are no polling timers).
- Boot order is not sensitive, but health-check both: `GET /api` (app) and the
  banner in the service log (`path '/socket.io/', cors …, ticket auth ENABLED`).

## 8. Post-deploy verification

```bash
# 0. GO-LIVE SMOKE TEST — the production guard state line, in BOTH logs
#    (app log AND WS service log). Each process prints exactly one line:
#    [TCMS] production guard ACTIVE              <- REQUIRED on the real server
#    [TCMS] production guard OFF (sandbox mode)  <- TCMS_DEPLOY_ENV was
#         forgotten — DO NOT go live until both logs read ACTIVE.

# 1. Service is up and on the right path (banner):
#    [TCMS] Notifications WebSocket service running on port 3003
#           (path '/socket.io/', cors https://tcms.yourcompany.com, ticket auth ENABLED)

# 2. From a browser session on https://tcms.yourcompany.com, the bell updates
#    the moment someone assigns you a review (WS path) — DevTools → Network →
#    WS filter shows one websocket to /socket.io/ with status 101.

# 3. Sandbox-only regression probe (needs the sandbox gateway; NOT applicable
#    behind nginx — the sandbox uses path '/'):
node scripts/ws-auth-probe.mjs   # expect PASS=10 FAIL=0
```

## 9. Migrating away from the sandbox gateway

The sandbox reaches the service through a platform gateway that proxies by
`?XTransformPort=` query param; the sandbox `.env` therefore sets
`NEXT_PUBLIC_WS_URL=/?XTransformPort=3003` and `NEXT_PUBLIC_WS_PATH=/`. For a
normal server deployment **remove/leave empty both** (code defaults are
already production-correct), rebuild the client, and add the proxy location
from §3–§5. No application code changes are needed.
