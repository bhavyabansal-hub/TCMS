#!/usr/bin/env bash
# B10 audit probe: one forbidden access per role (live server calls, mock only).
BASE=http://localhost:3000
M='X-Requested-With: tcms'
login() { # login <email> <password> <jar>
  curl -s -c "$3" -X POST "$BASE/api/auth?path=login" -H 'Content-Type: application/json' -H "$M" \
    -d "{\"email\":\"$1\",\"password\":\"$2\"}" -o /dev/null
}
probe() { # probe <label> <jar> <method> <path> [body]
  local label=$1 jar=$2 method=$3 path=$4 body=$5
  if [ -n "$body" ]; then
    CODE=$(curl -s -o /tmp/probe-body.json -w '%{http_code}' -X "$method" "$BASE$path" -b "$jar" -H 'Content-Type: application/json' -H "$M" -d "$body")
  else
    CODE=$(curl -s -o /tmp/probe-body.json -w '%{http_code}' -X "$method" "$BASE$path" -b "$jar" -H "$M")
  fi
  echo "  [$CODE] $label  body: $(head -c 110 /tmp/probe-body.json)"
}

J=/tmp/rb-vp.txt;    login admin@tcms.com    Admin@123   $J
J2=/tmp/rb-mgr.txt;  login teamlead@tcms.com Lead@123    $J2
J3=/tmp/rb-prod.txt; login product@tcms.com  Product@123 $J3
J4=/tmp/rb-dev.txt;  login developer@tcms.com Dev@12345  $J4
J5=/tmp/rb-qa.txt;   login qa1@tcms.com      QA@12345    $J5
J6=/tmp/rb-view.txt; login viewer@tcms.com   View@12345  $J6

echo "== positive control (vp should pass) =="
probe "vp GET /api/permissions (manage_permissions)" $J GET "/api/permissions"
echo "== one forbidden access per role =="
probe "viewer GET /api/activity-logs (view_activity_logs)" $J6 GET "/api/activity-logs"
probe "qa_engineer GET /api/permissions (manage_permissions)" $J5 GET "/api/permissions"
probe "developer GET /api/users (manage_users list)" $J4 GET "/api/users?page=1&pageSize=5"
probe "product POST /api/permissions (manage_permissions)" $J3 POST "/api/permissions" '{"role":"viewer","action":"create_bug","enabled":true}'
probe "manager PUT /api/permissions (manage_permissions)" $J2 PUT "/api/permissions" '{"role":"viewer","action":"create_bug","enabled":true}'
echo "== options endpoint (dropdown data — expected open to authed) =="
probe "developer GET /api/users?action=options" $J4 GET "/api/users?action=options"
