#!/bin/bash
# Crew Desk verification driver — MOCK-ONLY, phases the app through every
# auth/mode combination and runs scripts/verify-crewdesk.mjs against each.
#
#   phase 1  manual      CREWDESK_MODE=manual, fixed token  -> zero Crew Desk traffic
#   phase 2  test-login  CREWDESK_MODE=test,  login mode    -> email check suite + 401 recovery
#   phase 3  test-token  CREWDESK_MODE=test,  fixed JWT with an INTENTIONALLY
#                        mismatched CREWDESK_USER_ID -> proves the setting wins
#                        and the startup warning fires (grepped from the log)
#   phase 4  badcreds    login mode with a WRONG mock password -> 3-strike backoff
#
# Every credential here is a FICTIONAL mock credential.
set -u
cd /home/z/my-project || exit 1

PASS=0
FAIL=0

restart_app() { # restart with optional env overrides already exported
  pkill -f next-server 2>/dev/null
  sleep 2
  bash scripts/start-tcms.sh > /tmp/tcms-phase.log 2>&1
  for i in $(seq 1 30); do
    curl -s -o /dev/null -m 2 http://localhost:3000/api && return 0
    sleep 2
  done
  echo "[driver] FATAL: app did not come up (see /tmp/tcms-phase.log)"
  tail -20 /tmp/tcms-phase.log
  exit 1
}

kill_mock() { # kill whatever listens on 3010 — the mock's argv ("bun index.ts")
              # is indistinguishable from other bun services by name
  local pid
  pid=$(ss -tlnp 2>/dev/null | grep ':3010 ' | grep -oP 'pid=\K[0-9]+' | head -1)
  if [ -n "$pid" ]; then kill "$pid" 2>/dev/null; sleep 1; fi
}

run_suite() { # <phase-name> [expected-user-id]
  local name="$1"
  echo ""
  echo "================ PHASE $name ================"
  if [ -n "${2:-}" ]; then
    EXPECTED_USER_ID="$2" node scripts/verify-crewdesk.mjs --phase="$name"
  else
    node scripts/verify-crewdesk.mjs --phase="$name"
  fi
  local rc=$?
  if [ $rc -eq 0 ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "[driver] PHASE $name FAILED"; fi
}

# ---- boot baseline (mock + app on .env config) ----
kill_mock
pkill -f next-server 2>/dev/null
sleep 2
bash scripts/start-tcms.sh > /tmp/tcms-phase.log 2>&1 || { echo "[driver] baseline boot failed"; tail -20 /tmp/tcms-phase.log; exit 1; }

# The mock's designated ticket is 1355 in EVERY phase — pin it so the suite
# is deterministic even when the deployment .env designates another ticket.
export CREWDESK_TEST_TICKET_ID=1355

# MOCK-ONLY contract: the suite always runs against the local mock, never
# against whatever backend the deployment .env currently points at (the
# owner may switch .env to the real dev Crew Desk for live testing). The
# exported URL wins over .env inside Next.js and makes start-tcms.sh boot
# the mock for every phase.
export CREWDESK_BASE_URL=http://127.0.0.1:3010

# ---- phase 1: manual ----
export CREWDESK_MODE=manual CREWDESK_AUTH=token CREWDESK_TOKEN=mock-local-token
unset CREWDESK_LOGIN_EMAIL CREWDESK_LOGIN_PASSWORD CREWDESK_USER_ID 2>/dev/null
restart_app
run_suite manual

# ---- phase 2: test + login (explicit mock credentials — the deployment
# .env may carry REAL credentials, so the mock login is pinned here) ----
unset CREWDESK_MODE CREWDESK_TOKEN 2>/dev/null
export CREWDESK_AUTH=login
export CREWDESK_LOGIN_EMAIL=tcms.service@crewdesk.test
export CREWDESK_LOGIN_PASSWORD=mock-login-secret
# Shared-account resolution is CONFIG-FIRST by contract: CREWDESK_USER_ID in
# the deployment .env wins over the mock JWT's user_id claim (7001). The
# suite therefore expects whichever the app will actually resolve — the .env
# value when present, otherwise the claim.
ENV_USER_ID=$(grep -E '^CREWDESK_USER_ID=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '[:space:]')
EXPECTED_P2="${ENV_USER_ID:-7001}"
restart_app
run_suite test-login "$EXPECTED_P2"

# ---- phase 3: test + fixed JWT whose user_id claim MISMATCHES CREWDESK_USER_ID ----
JWT=$(curl -s -X POST http://127.0.0.1:3010/api/login -H 'Content-Type: application/json' \
  -d '{"email":"tcms.service@crewdesk.test","password":"mock-login-secret"}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).data.token))")
if [ -z "$JWT" ]; then echo "[driver] could not obtain mock JWT"; FAIL=$((FAIL+1)); else
  export CREWDESK_MODE=test CREWDESK_AUTH=token CREWDESK_TOKEN="$JWT" CREWDESK_USER_ID=9999
  restart_app
  run_suite test-token 9999
  if grep -q 'does not match the user_id claim' /tmp/next-prod.log 2>/dev/null; then
    PASS=$((PASS+1)); echo "  ok  startup warning fired for mismatched CREWDESK_USER_ID (found in log)"
  else
    FAIL=$((FAIL+1)); echo "FAIL  startup warning for mismatched CREWDESK_USER_ID missing from /tmp/next-prod.log"
  fi
fi

# ---- phase 4: test + login with a WRONG password ----
unset CREWDESK_TOKEN CREWDESK_USER_ID 2>/dev/null
export CREWDESK_MODE=test CREWDESK_AUTH=login
export CREWDESK_LOGIN_EMAIL=tcms.service@crewdesk.test
export CREWDESK_LOGIN_PASSWORD=totally-wrong-mock-password
restart_app
run_suite badcreds

# ---- restore: clean restart on plain .env (back to the OWNER-CHOSEN
# backend — the mock URL pin above must not leak past the suite) ----
unset CREWDESK_MODE CREWDESK_AUTH CREWDESK_TOKEN CREWDESK_USER_ID 2>/dev/null
unset CREWDESK_LOGIN_EMAIL CREWDESK_LOGIN_PASSWORD 2>/dev/null
unset CREWDESK_TEST_TICKET_ID CREWDESK_BASE_URL 2>/dev/null
restart_app

echo ""
echo "======================================"
echo "DRIVER RESULT: $PASS phase(s) passed, $FAIL failed"
echo "======================================"
[ $FAIL -eq 0 ] || exit 1
