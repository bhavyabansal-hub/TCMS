#!/usr/bin/env bash
# A8 audit probe: bad-input sweep across ALL routes — hunting HTTP 500s.
# Every body is INVALID on purpose; nothing should persist.
BASE=http://localhost:3000
M='X-Requested-With: tcms'
CT='Content-Type: application/json'
J=/tmp/audit-vp.txt
curl -s -c $J -X POST "$BASE/api/auth?path=login" -H "$CT" -H "$M" -d '{"email":"admin@tcms.com","password":"Admin@123"}' -o /dev/null
p() { local label=$1; shift; local CODE=$(curl -s -o /tmp/ab.json -w '%{http_code}' "$@"); echo "[$CODE] $label :: $(head -c 90 /tmp/ab.json)"; }
BAD=not-an-id

echo "== test-cases =="
p "POST create, bogus moduleId 'x'" -X POST "$BASE/api/test-cases" -b $J -H "$CT" -H "$M" -d '{"title":"audit","moduleId":"x","description":"d","priority":"P1"}'
p "POST create, title 300 chars" -X POST "$BASE/api/test-cases" -b $J -H "$CT" -H "$M" -d "{\"title\":\"$(python3 -c 'print("x"*300)')\",\"moduleId\":\"x\",\"description\":\"d\"}"
p "GET detail id=not-an-id" "$BASE/api/test-cases?id=$BAD" -b $J -H "$M"
p "PUT update id=not-an-id" -X PUT "$BASE/api/test-cases?id=$BAD" -b $J -H "$CT" -H "$M" -d '{"title":"audit"}'
p "DELETE id=not-an-id" -X DELETE "$BASE/api/test-cases?id=$BAD" -b $J -H "$M"
p "POST submit-review bogus id" -X PUT "$BASE/api/test-cases?id=$BAD&action=submit-review" -b $J -H "$CT" -H "$M" -d '{}'

echo "== bugs =="
p "POST create, bogus moduleId" -X POST "$BASE/api/bugs" -b $J -H "$CT" -H "$M" -d '{"title":"audit","moduleId":"x","description":"d","severity":"P2"}'
p "PUT update id=not-an-id" -X PUT "$BASE/api/bugs?id=$BAD" -b $J -H "$CT" -H "$M" -d '{"status":"open"}'
p "DELETE id=not-an-id" -X DELETE "$BASE/api/bugs?id=$BAD" -b $J -H "$M"

echo "== modules =="
p "POST create, bogus parentId" -X POST "$BASE/api/modules" -b $J -H "$CT" -H "$M" -d '{"name":"audit-mod","description":"d","parentId":"x"}'
p "PUT update id=not-an-id" -X PUT "$BASE/api/modules?id=$BAD" -b $J -H "$CT" -H "$M" -d '{"name":"audit-mod"}'
p "DELETE id=not-an-id" -X DELETE "$BASE/api/modules?id=$BAD" -b $J -H "$M"

echo "== wiki =="
p "PUT update id=not-an-id" -X PUT "$BASE/api/wiki?id=$BAD" -b $J -H "$CT" -H "$M" -d '{"title":"audit","content":"c"}'
p "DELETE id=not-an-id" -X DELETE "$BASE/api/wiki?id=$BAD" -b $J -H "$M"
p "GET download id=not-an-id" "$BASE/api/wiki?id=$BAD&action=download" -b $J -H "$M"

echo "== notifications =="
p "PATCH bogus notification id" -X PATCH "$BASE/api/notifications?id=$BAD" -b $J -H "$M"
p "DELETE bogus notification id" -X DELETE "$BASE/api/notifications?id=$BAD" -b $J -H "$M"

echo "== reviews / module-reviews =="
p "POST verdict, bogus requestId" -X POST "$BASE/api/reviews" -b $J -H "$CT" -H "$M" -d '{"action":"verdict","requestId":"x","verdict":"approved"}'
p "POST bulk-verdict bogus ids" -X POST "$BASE/api/module-reviews" -b $J -H "$CT" -H "$M" -d '{"action":"bulk-verdict","requestIds":["x"],"verdict":"approved"}'

echo "== task-reports / users / search =="
p "PUT task-report id=not-an-id" -X PUT "$BASE/api/task-reports?id=$BAD" -b $J -H "$CT" -H "$M" -d '{"workDone":"x"}'
p "PUT user id=not-an-id" -X PUT "$BASE/api/users?id=$BAD" -b $J -H "$CT" -H "$M" -d '{"fullName":"audit"}'
p "GET search q=3000 chars" "$BASE/api/search?q=$(python3 -c 'print("y"*3000)')&limit=5" -b $J -H "$M"
p "GET search q=<script> injection" "$BASE/api/search?q=%3Cscript%3Ealert(1)%3C/script%3E" -b $J -H "$M"
