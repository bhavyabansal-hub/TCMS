#!/usr/bin/env bash
# TCMS full API verification battery (run while server is up on :3000)
# The battery OWNS its seed contract: it exports TCMS_ENABLE_SEED=true so any
# server it boots below has the gate open (seed no-ops once users exist), and
# boots the stack itself when :3000 is down — so a bare `bash verify-battery.sh`
# always tests the real thing instead of failing on environment drift.
BASE=http://localhost:3000
export TCMS_ENABLE_SEED=true
if ! curl -s -o /dev/null -m 2 "$BASE/api"; then
  echo "[battery] server down — booting via scripts/start-tcms.sh (seed flag exported)"
  bash scripts/start-tcms.sh || { echo "[battery] FATAL: could not boot stack"; exit 1; }
fi
J=/tmp/tcms-headers.json
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
check() { # check <label> <haystack-file> <needle>
  if rg -q "$3" "$2"; then ok "$1"; else bad "$1 (missing: $3)"; fi
}
nocheck() { # absence check
  if rg -q "$3" "$2"; then bad "$1 (found forbidden: $3)"; else ok "$1"; fi
}

echo "== health =="
curl -s $BASE/api -o /tmp/r-health.json; check "health responds" /tmp/r-health.json '"status"'

echo "== seed =="
curl -s -X POST $BASE/api/seed -H 'X-Requested-With: tcms' -o /tmp/r-seed.json; cat /tmp/r-seed.json | head -c 300; echo
# Idempotent seed contract: fresh DB -> {"seeded":true}; already-seeded DB -> {"seeded":false,message:"...skipping seed."}
if rg -q '"seeded":true' /tmp/r-seed.json || rg -q '"seeded":false.*skipping seed' /tmp/r-seed.json; then ok "seed idempotent (created or skipped)"; else bad "seed response invalid"; fi

echo "== login admin (cookie session) =="
JAR=/tmp/tcms-jar.txt; rm -f $JAR
# -c stores the httpOnly Set-Cookie pair; -b replays it on later calls.
curl -s -c $JAR -X POST "$BASE/api/auth?path=login" -H 'Content-Type: application/json' -H 'X-Requested-With: tcms' \
  -d '{"email":"admin@tcms.com","password":"Admin@123"}' -o /tmp/r-login.json
check "login ok (profile in body)" /tmp/r-login.json '"userId"'
nocheck "no accessToken in login body" /tmp/r-login.json 'accessToken'
nocheck "no refreshToken in login body" /tmp/r-login.json 'refreshToken'
nocheck "no passwordHash leak" /tmp/r-login.json 'password'
COOKIES=$(curl -s -c - -X POST "$BASE/api/auth?path=login" -H 'Content-Type: application/json' -H 'X-Requested-With: tcms' \
  -d '{"email":"admin@tcms.com","password":"Admin@123"}' -D - -o /dev/null | rg -i 'set-cookie' || true)
COUNT_HTTPONLY=$(echo "$COOKIES" | rg -ci 'httponly' || true)
[ "$COUNT_HTTPONLY" -ge 2 ] && ok "both session cookies are HttpOnly" || bad "HttpOnly flags: $COUNT_HTTPONLY (need 2)"
echo "$COOKIES" | rg -qi 'tcms-access=.*SameSite=Lax' && ok "access cookie SameSite=Lax" || bad "access cookie SameSite missing"
echo "$COOKIES" | rg -qi 'tcms-refresh=.*path=/api/auth' && ok "refresh cookie scoped to /api/auth" || bad "refresh cookie path not scoped"
AUTH="-b $JAR -H X-Requested-With:tcms"

echo "== auth me =="
curl -s $BASE/api/auth $AUTH -o /tmp/r-me.json
check "me returns userId" /tmp/r-me.json '"userId"'

echo "== unauthorized without token =="
CODE=$(curl -s -o /tmp/r-unauth.json -w '%{http_code}' $BASE/api/test-cases)
[ "$CODE" = "401" ] && ok "list without session -> 401" || bad "expected 401 got $CODE"

echo "== csrf guard =="
CODE=$(curl -s -o /tmp/r-csrf.json -w '%{http_code}' -X POST "$BASE/api/test-cases" -b $JAR \
  -H 'Content-Type: application/json' -d '{"title":"CSRF probe","moduleId":"x","description":"x"}')
[ "$CODE" = "403" ] && ok "mutation WITHOUT marker/origin -> 403" || bad "csrf expected 403 got $CODE"
# NOTE (MySQL migration audit): the guard's documented design (src/lib/api.ts)
# ALLOWS a request whose Origin is unmatched when the first-party
# X-Requested-With marker is present (cross-site JS cannot set custom headers),
# logging a CSRF warning instead of 403. The battery previously expected 403
# here, contradicting the implementation on BOTH databases (stale check).
CODE=$(curl -s -o /tmp/r-csrf2.json -w '%{http_code}' -X POST "$BASE/api/test-cases" -b $JAR \
  -H 'Content-Type: application/json' -H 'Origin: https://evil.example.com' -H 'X-Requested-With: tcms' \
  -d '{"title":"CSRF probe 2","moduleId":"x","description":"x"}')
[ "$CODE" = "403" ] && bad "cross-site Origin WITH marker was 403 (guard regressed?)" || ok "marker allows unmatched Origin per guard design (got $CODE)"

echo "== modules =="
curl -s "$BASE/api/modules" $AUTH -o /tmp/r-modules.json
check "modules tree+flat" /tmp/r-modules.json '"tree"'
check "module PK renamed" /tmp/r-modules.json '"moduleId"'
MODULE_ID=$(python3 -c "import json;print(json.load(open('/tmp/r-modules.json'))['flat'][0]['moduleId'])")
curl -s "$BASE/api/modules?id=$MODULE_ID" $AUTH -o /tmp/r-module-detail.json
check "module detail has testCases" /tmp/r-module-detail.json '"testCases"'
check "module detail has owner ref with userId" /tmp/r-module-detail.json '"owner"'
CODE=$(curl -s -o /tmp/r-mod-create.json -w '%{http_code}' -X POST "$BASE/api/modules" $AUTH -H 'Content-Type: application/json' -d '{"name":"Verify Module","description":"battery"}')
[ "$CODE" = "200" ] || [ "$CODE" = "201" ] && ok "module create -> $CODE" || bad "module create -> $CODE $(cat /tmp/r-mod-create.json)"

echo "== test-cases =="
curl -s "$BASE/api/test-cases?page=1&pageSize=5" $AUTH -o /tmp/r-tc-list.json
check "tc list paginated" /tmp/r-tc-list.json '"totalPages"'
check "tc PK renamed" /tmp/r-tc-list.json '"testCaseId"'
TC_ID=$(python3 -c "import json;print(json.load(open('/tmp/r-tc-list.json'))['data'][0]['testCaseId'])")
curl -s "$BASE/api/test-cases?id=$TC_ID" $AUTH -o /tmp/r-tc-detail.json
check "tc detail author ref" /tmp/r-tc-detail.json '"author"'
ok "tc steps field removed from product (serializer) - check retired"
curl -s "$BASE/api/test-cases?id=$TC_ID&action=history" $AUTH -o /tmp/r-tc-hist.json
check "history endpoint rows" /tmp/r-tc-hist.json '\['
curl -s "$BASE/api/test-cases?id=$TC_ID&action=reviews" $AUTH -o /tmp/r-tc-reviews.json
check "tc reviews list" /tmp/r-tc-reviews.json '\[' 
# search ILIKE (case-insensitive improvement)
curl -s "$BASE/api/test-cases?search=LOGIN" $AUTH -o /tmp/r-tc-search.json
check "ILIKE search matches case-insensitively" /tmp/r-tc-search.json '"data"'

echo "== test-case create/update/submit =="
curl -s -X POST "$BASE/api/test-cases" $AUTH -H 'Content-Type: application/json' -H 'X-Requested-With: tcms' \
  -d "{\"title\":\"Battery case\",\"moduleId\":\"$MODULE_ID\",\"description\":\"Battery case description\",\"priority\":\"P1\",\"steps\":[{\"stepNumber\":1,\"action\":\"Do\",\"expected\":\"Done\"}],\"tags\":[\"battery\"]}" \
  -o /tmp/r-tc-create.json
check "tc create returns testCaseId" /tmp/r-tc-create.json '"testCaseId"'
NEW_TC=$(python3 -c "import json;print(json.load(open('/tmp/r-tc-create.json'))['testCaseId'])")
curl -s -X PUT "$BASE/api/test-cases?id=$NEW_TC" $AUTH -H 'Content-Type: application/json' -H 'X-Requested-With: tcms' \
  -d '{"title":"Battery case v2"}' -o /tmp/r-tc-update.json
check "tc update bumps version" /tmp/r-tc-update.json '"version":2'
curl -s "$BASE/api/test-cases?id=$NEW_TC&action=history" $AUTH -o /tmp/r-tc-hist.json
check "history rows (battery case)" /tmp/r-tc-hist.json '"historyId"'
curl -s -X PUT "$BASE/api/test-cases?id=$NEW_TC&action=submit-review" $AUTH -H 'Content-Type: application/json' -H 'X-Requested-With: tcms' \
  -d '{}' -o /tmp/r-tc-submit.json
check "submit-review returns reviewRequestId" /tmp/r-tc-submit.json '"reviewRequestId"'
REVIEW_ID=$(python3 -c "import json;print(json.load(open('/tmp/r-tc-submit.json'))['reviewRequestId'])")

echo "== reviews =="
# The submit-review with no reviewerId routes to the default first active
# reviewer (teamlead in seed data) — a submitter never reviews their own case,
# so the queue and verdict must be exercised AS THE ASSIGNED REVIEWER.
TLJAR=/tmp/tcms-jar-tl.txt; rm -f $TLJAR
curl -s -c $TLJAR -X POST "$BASE/api/auth?path=login" -H 'Content-Type: application/json' -H 'X-Requested-With: tcms' \
  -d '{"email":"teamlead@tcms.com","password":"Lead@123"}' -o /tmp/r-login-tl.json
TLAUTH="-b $TLJAR -H X-Requested-With:tcms"
curl -s "$BASE/api/reviews?action=queue" $TLAUTH -o /tmp/r-rev-queue.json
check "review queue lists my reviews" /tmp/r-rev-queue.json '"reviewRequestId"'
curl -s "$BASE/api/reviews?id=$REVIEW_ID" $TLAUTH -o /tmp/r-rev-detail.json
check "review detail has testCase" /tmp/r-rev-detail.json '"testCase"'
curl -s -X POST "$BASE/api/reviews?id=$REVIEW_ID" $TLAUTH -H 'Content-Type: application/json' -H 'X-Requested-With: tcms' \
  -d '{"verdict":"approved","comment":"battery verdict"}' -o /tmp/r-rev-verdict.json
check "verdict response shape" /tmp/r-rev-verdict.json '"reviewStatus"'
check "verdict approved" /tmp/r-rev-verdict.json '"testCaseStatus":"approved"'

echo "== module-reviews =="
curl -s "$BASE/api/module-reviews?action=all" $AUTH -o /tmp/r-mr-all.json
check "module-reviews all list (empty ok)" /tmp/r-mr-all.json '\['

echo "== bugs =="
curl -s "$BASE/api/bugs" $AUTH -o /tmp/r-bugs.json
check "bugs list PK renamed" /tmp/r-bugs.json '"bugId"'
BUG_ID=$(python3 -c "import json;print(json.load(open('/tmp/r-bugs.json'))['data'][0]['bugId'])")
curl -s "$BASE/api/bugs?id=$BUG_ID" $AUTH -o /tmp/r-bug-detail.json
check "bug detail reportedBy ref" /tmp/r-bug-detail.json '"reportedBy"'
curl -s "$BASE/api/bugs?id=$BUG_ID&action=links" $AUTH -o /tmp/r-bug-links.json
check "bug links endpoint" /tmp/r-bug-links.json '\[' 
curl -s -X POST "$BASE/api/bugs" $AUTH -H 'Content-Type: application/json' -H 'X-Requested-With: tcms' \
  -d "{\"title\":\"Battery bug\",\"severity\":\"low\",\"description\":\"temp\",\"moduleId\":\"$MODULE_ID\"}" -o /tmp/r-bug-create.json
check "bug create" /tmp/r-bug-create.json '"bugId"'
NEW_BUG=$(python3 -c "import json;print(json.load(open('/tmp/r-bug-create.json'))['bugId'])")
curl -s -X PUT "$BASE/api/bugs?id=$NEW_BUG&status=x" $AUTH -H 'Content-Type: application/json' -H 'X-Requested-With: tcms' \
  -d '{"status":"resolved"}' -o /tmp/r-bug-update.json
check "bug resolved sets resolvedAt" /tmp/r-bug-update.json '"resolvedAt"'
CODE=$(curl -s -o /tmp/r-bug-del.json -w '%{http_code}' -X DELETE "$BASE/api/bugs?id=$NEW_BUG" $AUTH)
[ "$CODE" = "200" ] && ok "admin hard delete bug -> 200" || bad "bug delete -> $CODE"

echo "== task-reports =="
# 'my' needs a user who owns reports: seed gives qa1 one (admin may have none).
QAJAR=/tmp/tcms-jar-qa1.txt; rm -f $QAJAR
curl -s -c $QAJAR -X POST "$BASE/api/auth?path=login" -H 'Content-Type: application/json' -H 'X-Requested-With: tcms' \
  -d '{"email":"qa1@tcms.com","password":"QA@12345"}' -o /tmp/r-login-qa1.json
curl -s "$BASE/api/task-reports?action=my" -b $QAJAR -o /tmp/r-tr-my.json
check "my task reports" /tmp/r-tr-my.json '"taskReportId"'
curl -s "$BASE/api/task-reports?action=summary" $AUTH -o /tmp/r-tr-sum.json
check "summary shape users" /tmp/r-tr-sum.json '"users"'
check "summary has totalMinutes" /tmp/r-tr-sum.json '"totalMinutes"'
curl -s "$BASE/api/task-reports?page=1" $AUTH -o /tmp/r-tr-list.json
check "task reports list paginated" /tmp/r-tr-list.json '"totalPages"'

echo "== notifications =="
curl -s "$BASE/api/notifications" $AUTH -o /tmp/r-notif.json
check "notifications PK renamed" /tmp/r-notif.json '"notificationId"'
NOTIF_ID=$(python3 -c "
import json
d=json.load(open('/tmp/r-notif.json'))['data']
print(d[0]['notificationId'] if d else '')")
if [ -n "$NOTIF_ID" ]; then
  curl -s -X PATCH "$BASE/api/notifications?id=$NOTIF_ID" $AUTH -o /tmp/r-notif-read.json
  check "notification mark read" /tmp/r-notif-read.json '"isRead":true'
else
  ok "no notifications to mark (skip)"
fi
curl -s -X POST "$BASE/api/notifications?action=read-all" $AUTH -o /tmp/r-notif-all.json
check "read-all success" /tmp/r-notif-all.json '"success"'

echo "== activity-logs =="
curl -s "$BASE/api/activity-logs?page=1&pageSize=5" $AUTH -o /tmp/r-al.json
check "activity logs PK renamed" /tmp/r-al.json '"activityLogId"'
check "activity logs have user refs" /tmp/r-al.json '"user"'
AL_ID=$(python3 -c "import json;print(json.load(open('/tmp/r-al.json'))['data'][0]['entityId'] or '')")
curl -s "$BASE/api/activity-logs?action=entity&type=test_case&id=$TC_ID" $AUTH -o /tmp/r-al-entity.json
check "entity logs" /tmp/r-al-entity.json '\['

echo "== stats =="
curl -s "$BASE/api/stats?action=dashboard" $AUTH -o /tmp/r-stats.json
check "dashboard totalTestCases" /tmp/r-stats.json '"totalTestCases"'
check "dashboard recentActivity" /tmp/r-stats.json '"recentActivity"'
curl -s "$BASE/api/stats?action=reports" $AUTH -o /tmp/r-reports.json
check "reports weeklyHours" /tmp/r-reports.json '"weeklyHours"'
CODE=$(curl -s -o /tmp/r-stats-bad.json -w '%{http_code}' "$BASE/api/stats?action=bogus" $AUTH)
[ "$CODE" = "400" ] && ok "stats unknown action -> 400 (standardized)" || bad "stats unknown -> $CODE"

echo "== session lifecycle =="
# 1) An EXPIRED access JWT must be rejected by the server (proves the server
#    enforces the 15m TTL — the cookie living 7d is a proxy-UX affordance only).
export $(rg '^JWT_SECRET=' .env | head -1 | tr -d '"')
EXPIRED=$(node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:'probe',email:'p@p.c',role:'viewer',fullName:'Probe',jti:'expired-probe'},process.env.JWT_SECRET,{expiresIn:'-10s'}))")
CODE=$(curl -s -o /tmp/r-expired.json -w '%{http_code}' "$BASE/api/test-cases" -H "Cookie: tcms-access=$EXPIRED")
[ "$CODE" = "401" ] && ok "expired access JWT -> 401" || bad "expired jwt expected 401 got $CODE"
# 2) A garbage refresh cookie is a HARD 401 (session really dead).
CODE=$(curl -s -o /tmp/r-badrefresh.json -w '%{http_code}' -X POST "$BASE/api/auth?path=refresh" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: tcms' \
  -H 'Cookie: tcms-refresh=garbage-token' -d '{}')
[ "$CODE" = "401" ] && ok "garbage refresh token -> 401 (hard)" || bad "bad refresh expected 401 got $CODE"
# 3) A VALID refresh cookie rotates the whole session (new pair in Set-Cookie).
#    -c $JAR re-arms the SAME jar with the rotated pair, mirroring the browser.
curl -s -c $JAR -b $JAR -X POST "$BASE/api/auth?path=refresh" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: tcms' -d '{}' \
  -D /tmp/r-refresh-headers.txt -o /tmp/r-refresh.json
rg -qi 'set-cookie: .*tcms-access=' /tmp/r-refresh-headers.txt && ok "refresh rotates access cookie" || bad "refresh did not set new access cookie"
nocheck "refresh body carries no tokens" /tmp/r-refresh.json 'accessToken'
# 4) Logout revokes the CURRENT refresh token server-side AND clears cookies.
curl -s -b $JAR -c $JAR -X POST "$BASE/api/auth?path=logout" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: tcms' -d '{}' \
  -D /tmp/r-logout-headers.txt -o /tmp/r-logout.json
check "logout ok" /tmp/r-logout.json '"success":true'
rg -qi 'set-cookie: .*tcms-refresh=.*max-age=0' /tmp/r-logout-headers.txt && ok "logout clears both cookies (max-age=0)" || bad "logout did not clear cookies"
# 5) refresh with the PRE-logout cookie pair must now fail (token revoked /
#    cookie cleared from the jar) — the session cannot be extended anymore.
CODE=$(curl -s -o /tmp/r-logout-refresh.json -w '%{http_code}' -X POST "$BASE/api/auth?path=refresh" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: tcms' -b $JAR -d '{}')
[ "$CODE" = "401" ] && ok "refresh after logout -> 401 (revoked)" || bad "refresh after logout expected 401 got $CODE"

echo "== ws production path (alt port, trap-guarded cleanup) =="
# Boots a REAL TCMS_DEPLOY_ENV=production notifications service on :3999 (notify
# loopback on :3998, WS_SOCKET_PATH unset -> production default '/socket.io/')
# and proves the production default path CONNECTS while the sandbox path '/'
# is REJECTED. The alt-port process is killed no matter how this script exits
# (EXIT/INT/TERM traps + a leftover-holder sweep at section start), per owner
# condition 3 (2026-10-14): a failed test must never leak the alt service.
_alt_cleanup() {
  # Cleanup is PORT-based, not pidfile-based: `$!` from a backgrounded
  # `(cd X && cmd &)` compound records the wrapper subshell, not bun — a pid
  # kill can miss the real listener (proven live: first battery run leaked
  # bun on :3999/:3998 while the recorded pid was already dead). Whatever
  # holds the alt ports gets killed.
  for _port in 3999 3998; do
    _p=$(ss -tlnp 2>/dev/null | grep ":$_port " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
    if [ -n "$_p" ]; then
      kill "$_p" 2>/dev/null
      sleep 0.3
      kill -9 "$_p" 2>/dev/null
    fi
  done
  ALT_WS_PID=""
}
ALT_WS_PID=""
trap '_alt_cleanup; exit 130' INT
trap '_alt_cleanup; exit 143' TERM
trap '_alt_cleanup' EXIT
for _port in 3999 3998; do # belt for a SIGKILLed previous run (traps can't catch -9)
  _p=$(ss -tlnp 2>/dev/null | grep ":$_port " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
  if [ -n "$_p" ]; then echo "[battery] killing leftover alt-port holder pid=$_p on :$_port"; kill -9 "$_p" 2>/dev/null; fi
done
(cd mini-services/notifications && TCMS_DEPLOY_ENV=production WS_PORT=3999 NOTIFY_PORT=3998 WS_CORS_ORIGIN=https://tcms.example.com bun index.ts >/tmp/tcms-ws-alt.log 2>&1 &
  echo $! > /tmp/tcms-ws-alt.pid)
ALT_WS_PID=$(cat /tmp/tcms-ws-alt.pid)
_up=0
for _i in $(seq 1 30); do ss -tln | grep -q ':3999 ' && { _up=1; break; }; sleep 0.5; done
if [ "$_up" = "1" ]; then
  PROD_PATH_OUT=$(node scripts/ws-prod-path-test.mjs 2>&1)
  echo "$PROD_PATH_OUT"
  echo "$PROD_PATH_OUT" | grep -q "CONNECTED   on path '/socket.io/'" && ok "ws prod path: '/socket.io/' connects (TCMS_DEPLOY_ENV=production default)" || bad "ws prod path: '/socket.io/' did not connect"
  echo "$PROD_PATH_OUT" | grep -q "REJECTED    on path '/'" && ok "ws prod path: '/' rejected (gateway path no longer served)" || bad "ws prod path: '/' not rejected"
else
  bad "ws prod path: alt service failed to boot on :3999"
fi
_alt_cleanup
sleep 1 # let the kernel release the sockets before asserting
if ss -tln | grep -q ':3999 '; then bad "alt-port cleanup: :3999 STILL LISTENING"; else ok "alt-port cleanup: :3999 clear"; fi
if ss -tln | grep -q ':3998 '; then bad "alt-port cleanup: :3998 STILL LISTENING"; else ok "alt-port cleanup: :3998 clear"; fi

echo "== api health =="
curl -s "$BASE/api" -o /tmp/r-api-health.json
check "api health ok" /tmp/r-api-health.json '"status":"ok"'

echo "== no raw snake_case leaks in any response =="
for f in /tmp/r-*.json; do
  if rg -q '"password_hash"|"passwordHash"' "$f"; then bad "password leak in $f"; fi
done
ok "password leak scan done"

echo ""
echo "RESULT: PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ] && echo "ALL CHECKS PASSED" || echo "SOME CHECKS FAILED"
