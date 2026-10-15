#!/bin/bash
# Idempotent TCMS stack starter for the sandbox.
# Boots MySQL TEST schema wiring + notifications WS mini-service (3003)
# + Next.js (3000, production build by default — TCMS_DEV=1 for dev mode)
# + the PostgreSQL sandbox on 5499 (READ-ONLY migration/drill source only).
# Safe to call repeatedly: every step is a no-op when the port is already listening.
cd /home/z/my-project || exit 1
export LD_LIBRARY_PATH="/home/z/my-project/scripts/pg-sandbox/icu60/extracted/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
# DB wiring has ONE source of truth (shared with boot-tcms-autostart.sh):
# tolerates quoted .env values and never lets a stale non-mysql shell
# DATABASE_URL win. PG_SOURCE_URL is the read-only drill source ONLY.
. scripts/mysql-env.sh

# ---- 0b. Sandbox TWO-USER schema model (task mysql-baseline-1): migrations
#         (prisma migrate deploy via DIRECT_URL) run as the DDL-only
#         tcms_migrate user; the app runtime uses the DML-only tcms_app via
#         DATABASE_URL. Applies ONLY when the DB is the sandbox MySQL — any
#         other host (production) keeps whatever DIRECT_URL the caller set.
#         Fires when DIRECT_URL is still just a copy of DATABASE_URL (fresh
#         template / pre-two-user .env); an explicit non-default DIRECT_URL
#         always wins.
case "${DATABASE_URL:-}" in
  *@127.0.0.1:5500/*|*@localhost:5500/*)
    if [ -z "${DIRECT_URL:-}" ] || [ "$DIRECT_URL" = "$DATABASE_URL" ]; then
      DIRECT_URL="mysql://tcms_migrate:ChangeMe_local_migrate@127.0.0.1:5500/tcms_test?connection_limit=40&pool_timeout=10"
      export DIRECT_URL
      echo "[start-tcms] DIRECT_URL wired to the sandbox migrate user (two-user model)"
    fi
    ;;
esac

# ---- 0. Self-heal .env — REPAIR-ONLY: never drops or rewrites settings it
#         does not own. Sandbox recycles have repeatedly WIPED this file.
#   - .env missing  -> create the canonical file (fresh random secrets).
#   - .env exists   -> fix ONLY lines this script owns (DATABASE_URL /
#                      DIRECT_URL / TCMS_EXTRA_ALLOWED_HOSTS). Secrets,
#                      CREWDESK_*, TCMS_ENABLE_SEED, comments: VERBATIM.
TCMS_PREVIEW_HOST="preview-chat-c07ec613-ee53-4223-b848-dc9b3387e259.space-z.ai"
if [ ! -f .env ]; then
  echo "[start-tcms] .env missing -> creating canonical .env (fresh random secrets)"
  _jwt="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  _ws="$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  {
    # Values stay UNQUOTED: several parsers (node fixtures, mysqldump URL
    # splitting) read .env naively; quoting breaks them. Shell sourcing of
    # URLs is handled ONLY by scripts/mysql-env.sh, which greps the full line.
    echo "DATABASE_URL=${DATABASE_URL}"
    echo "DIRECT_URL=${DIRECT_URL}"
    echo "PG_SOURCE_URL=${PG_SOURCE_URL}"
    echo "TCMS_EXTRA_ALLOWED_HOSTS=${TCMS_PREVIEW_HOST}"
    echo "JWT_SECRET=${_jwt}"
    echo "WS_NOTIFY_SECRET=${_ws}"
    echo "# Sandbox-only: POST /api/seed no-ops once any user exists. NOT shipped."
    echo "TCMS_ENABLE_SEED=true"
    # Self-signup switch (sandbox: ON — the /login Create-account tab is part of
    # the sandbox demo). Server flag is runtime, NEXT_PUBLIC_* is baked at BUILD
    # time: change both together and rebuild. Full contract: .env.example.
    echo "# Self-signup switch (sandbox: enabled; full contract in .env.example)"
    echo "TCMS_ALLOW_SIGNUP=true"
    echo "NEXT_PUBLIC_ALLOW_SIGNUP=true"
    # Realtime WS client wiring — the sandbox platform gateway proxies by
    # ?XTransformPort= query param (baked into the client bundle at BUILD time;
    # a real server leaves both unset and rebuilds — docs/deploy/).
    echo "# Realtime WS client wiring (sandbox gateway; baked at build time)"
    echo "NEXT_PUBLIC_WS_URL=/?XTransformPort=3003"
    echo "NEXT_PUBLIC_WS_PATH=/"
    echo "# Crew Desk: MOCK default (127.0.0.1:3010). Real creds set deliberately."
    echo "# CREWDESK_BASE_URL=http://127.0.0.1:3010"
    echo "# CREWDESK_TEST_TICKET_ID=1355"
  } > .env
else
  need_fix=0
  grep -qE '^DATABASE_URL="?mysql://' .env 2>/dev/null || need_fix=1
  grep -q '^TCMS_EXTRA_ALLOWED_HOSTS=' .env 2>/dev/null || need_fix=1
  if [ "$need_fix" = "1" ]; then
    echo "[start-tcms] .env repair: fixing ONLY the DB/allowlist lines (all other settings preserved verbatim)"
    # NOTE: no sed for URL lines — the URL contains '&' which sed would expand
    # to the matched text. grep-out + append keeps every other line untouched.
    if ! grep -qE '^DATABASE_URL="?mysql://' .env 2>/dev/null; then
      grep -vE '^DATABASE_URL=' .env > .env.tmp && echo "DATABASE_URL=${DATABASE_URL}" >> .env.tmp && mv .env.tmp .env
    fi
    if ! grep -qE '^DIRECT_URL="?mysql://' .env 2>/dev/null; then
      grep -vE '^DIRECT_URL=' .env > .env.tmp && echo "DIRECT_URL=${DIRECT_URL}" >> .env.tmp && mv .env.tmp .env
    fi
    grep -q '^TCMS_EXTRA_ALLOWED_HOSTS=' .env 2>/dev/null || \
      echo "TCMS_EXTRA_ALLOWED_HOSTS=${TCMS_PREVIEW_HOST}" >> .env
  fi
fi

port_up() { ss -tln 2>/dev/null | grep -q ":$1 "; }

# ---- 1. PostgreSQL sandbox — READ-ONLY SOURCE ONLY (data migration +
#         backup/restore drills). The app NEVER connects to it after the
#         MySQL migration; it stays bootable so drills keep working. ----
if port_up 5499; then
  echo "[start-tcms] PostgreSQL source already up on 5499 (read-only source)"
else
  echo "[start-tcms] booting sandbox PostgreSQL on 5499..."
  nohup setsid node scripts/pg-sandbox/start-pg.mjs >/tmp/pg-sandbox.log 2>&1 &
  for i in $(seq 1 40); do port_up 5499 && break; sleep 1; done
  port_up 5499 && echo "[start-tcms] PostgreSQL source ready on 5499" || { echo "[start-tcms] WARN: PostgreSQL source failed to boot (migration/drills unavailable; app unaffected)"; }
fi

# ---- 2. Notifications WS mini-service (optional realtime; without it the app degrades to refresh-visible delivery — next list fetch, no polling) ----
# ZOMBIE GUARD (owner-approved 2026-10-14): a busy :3003 is acceptable ONLY
# when the holder is the CURRENT notifications service running from THIS
# project directory. History: a pre-fix `bun --hot` process whose directory
# was DELETED in a baseline swap survived and kept serving the old
# accept-anything auth, while the port check skipped every boot for days.
TCMS_ROOT="$(pwd)"
ws_port_pid() { # first pid listening on $1
  ss -tlnp 2>/dev/null | grep ":$1 " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2
}
ws_holder_current() { # true when pid runs the notifications index.ts from THIS project dir
  local pid=$1 cmd cwd
  [ -n "$pid" ] || return 1
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null) || return 1
  case "$cmd" in *index.ts*) ;; *) return 1 ;; esac
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null)
  [ "$cwd" = "$TCMS_ROOT/mini-services/notifications" ] || return 1
  return 0
}
if port_up 3003; then
  _ws_pid=$(ws_port_pid 3003)
  if ws_holder_current "$_ws_pid"; then
    echo "[start-tcms] notifications WS service already up on 3003 (current code, pid $_ws_pid)"
  else
    echo "[start-tcms] :3003 STALE HOLDER pid=$_ws_pid cmd=[$(tr '\0' ' ' < /proc/$_ws_pid/cmdline 2>/dev/null)] cwd=[$(readlink /proc/$_ws_pid/cwd 2>/dev/null)]"
    echo "[start-tcms] killing stale holder (not this project's current service) and rebooting fresh"
    kill "$_ws_pid" 2>/dev/null; sleep 1
    kill -9 "$_ws_pid" 2>/dev/null
  fi
fi
if ! port_up 3003; then
  echo "[start-tcms] booting notifications WS mini-service on 3003..."
  (cd mini-services/notifications && nohup setsid bun index.ts >/tmp/tcms-ws.log 2>&1 &)
  sleep 1
fi

# ---- 2b. Crew Desk MOCK (port 3010) — test double for the real Crew Desk API.
# Booted whenever the configured CREWDESK_BASE_URL IS the mock (127.0.0.1:3010)
# or missing entirely; real remote URLs are never second-guessed. Exported vars
# beat .env inside Next.js.
MOCK_URL="http://127.0.0.1:3010"
want_mock=0
if [ -z "${CREWDESK_BASE_URL:-}" ] && ! grep -q '^CREWDESK_BASE_URL=' .env 2>/dev/null; then
  want_mock=1 # nothing configured at all
fi
cfg_url="${CREWDESK_BASE_URL:-}"
if [ -z "$cfg_url" ]; then
  # tr -d '"' / \r: tolerate quoted or CRLF values in .env
  cfg_url=$(grep -E '^CREWDESK_BASE_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d $'\r')
fi
case "$cfg_url" in
  ""|http://127.0.0.1:3010|http://localhost:3010) want_mock=1 ;;
esac
if [ "$want_mock" = "1" ]; then
  if ! port_up 3010; then
    echo "[start-tcms] booting Crew Desk mock on 3010..."
    (cd mini-services/crewdesk-mock && nohup setsid bun index.ts >/tmp/crewdesk-mock.log 2>&1 &)
    sleep 1
  fi
  # Point the app at the mock so the Integrations page works out of the box.
  # Real CREWDESK_* config in the environment overrides this.
  export CREWDESK_BASE_URL="${CREWDESK_BASE_URL:-$MOCK_URL}"
  # Self-contained mock credentials: when the deployment has configured NO
  # Crew Desk credential at all (env or .env), inject the mock's FICTIONAL
  # login so the test mode can actually exercise the integration. Any real
  # credential set by the owner (env or .env) always wins — this is a no-op.
  has_cd_credential=0
  [ -n "${CREWDESK_TOKEN:-}" ]      && has_cd_credential=1
  [ -n "${CREWDESK_AUTH:-}" ]       && has_cd_credential=1
  grep -qE '^CREWDESK_(TOKEN|AUTH)=' .env 2>/dev/null && has_cd_credential=1
  if [ "$has_cd_credential" = "0" ]; then
    export CREWDESK_AUTH=login
    export CREWDESK_LOGIN_EMAIL="tcms.service@crewdesk.test"
    export CREWDESK_LOGIN_PASSWORD="mock-login-secret"
    echo "[start-tcms] no Crew Desk credential configured -> using mock login (test-safe)"
  fi
  echo "[start-tcms] app uses local Crew Desk mock on 3010"
fi

# ---- 2c. Schema — `prisma migrate deploy` is THE ONLY schema path (same
#         command production runs; sandbox tests what production will run).
#         Runs as the DDL-only tcms_migrate user (DIRECT_URL); idempotent —
#         "No pending migrations" on every boot after the first. The old
#         db-push + mysql-json-defaults.sh + collation-fixups dance is GONE:
#         utf8mb4_bin and the JSON expression defaults live in the baseline
#         migration (20261015034822_init_mysql) itself.
if port_up 5500; then
  echo "[start-tcms] applying schema (prisma migrate deploy, migrate user)..."
  npx prisma migrate deploy || { echo "[start-tcms] FATAL: migrate deploy failed"; exit 1; }
else
  echo "[start-tcms] WARN: MySQL :5500 is down — schema step skipped (health gate will fail below)"
fi

# ---- 3. Next.js — production build by default (instant page loads, no
#         dev-mode compile lag); opt back into dev with TCMS_DEV=1 ----
if port_up 3000; then
  echo "[start-tcms] Next.js already up on 3000"
else
  if [ "${TCMS_DEV:-0}" = "1" ]; then
    echo "[start-tcms] booting Next.js in DEV mode on 3000..."
    nohup setsid npm run dev >/tmp/next-dev.log 2>&1 &
  else
    if [ ! -f .next/BUILD_ID ]; then
      echo "[start-tcms] no production build found — building once..."
      npm run build || { echo "[start-tcms] FATAL: build failed"; exit 1; }
    fi
    echo "[start-tcms] booting Next.js in PRODUCTION mode on 3000..."
    nohup setsid npm start >/tmp/next-prod.log 2>&1 &
  fi
  for i in $(seq 1 60); do
    curl -s -o /dev/null -m 2 http://localhost:3000/api && break
    sleep 2
  done
fi

# ---- 4. Health gate ----
for i in $(seq 1 30); do
  BODY=$(curl -s -m 3 http://localhost:3000/api 2>/dev/null)
  echo "$BODY" | grep -q '"status":"ok"' && { echo "[start-tcms] TCMS healthy: $BODY"; exit 0; }
  sleep 2
done
echo "[start-tcms] FATAL: Next.js did not become healthy"
tail -30 /tmp/next-dev.log
exit 1
