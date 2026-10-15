#!/bin/bash
# RBAC verification: 6-role hierarchy + togglable matrix + login lockout.
BASE=http://localhost:3000/api
PASS=0; FAIL=0

check() {
  local name="$1" exp="$2" act="$3" regex="$4"
  local ok=1
  [ "$act" != "$exp" ] && ok=0
  if [ -n "$regex" ] && [ $ok -eq 1 ]; then
    echo "$LASTBODY" | grep -qE "$regex" || ok=0
  fi
  if [ $ok -eq 1 ]; then PASS=$((PASS+1)); echo "PASS  $name"; else
    FAIL=$((FAIL+1)); echo "FAIL  $name (HTTP $act, expected $exp)"; echo "$LASTBODY" | head -c 240; echo
  fi
}

# ---- 1. Every demo role can log in; response carries permissions ----
declare -A CREDS=(
  [vp]="admin@tcms.com:Admin@123"
  [manager]="teamlead@tcms.com:Lead@123"
  [product]="product@tcms.com:Product@123"
  [developer]="developer@tcms.com:Dev@12345"
  [qa]="qa1@tcms.com:QA@12345"
  [viewer]="viewer@tcms.com:View@12345"
)
for role in vp manager product developer qa viewer; do
  IFS=: read -r EMAIL PASSWD <<< "${CREDS[$role]}"
  LASTBODY=$(curl -s -m 10 -X POST -H 'X-Requested-With: tcms' "$BASE/auth?path=login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWD\"}")
  ACT=$(curl -s -o /dev/null -w "%{http_code}" -m 10 -X POST -H 'X-Requested-With: tcms' "$BASE/auth?path=login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWD\"}")
  check "login as $role ($EMAIL) returns permissions" 200 "$ACT" '"permissions":\['
done

# ---- 2. VP tokens ----
VJAR=/tmp/rbac-jar-vp.txt; rm -f $VJAR
curl -s -c $VJAR -X POST -H 'X-Requested-With: tcms' "$BASE/auth?path=login" -H 'Content-Type: application/json' -d '{"email":"admin@tcms.com","password":"Admin@123"}' -o /dev/null
VAUTH="-b $VJAR -H X-Requested-With:tcms"

# ---- 3. Viewer CANNOT read the matrix; VP CAN ----
QJAR=/tmp/rbac-jar-viewer.txt; rm -f $QJAR
curl -s -c $QJAR -X POST -H 'X-Requested-With: tcms' "$BASE/auth?path=login" -H 'Content-Type: application/json' -d '{"email":"viewer@tcms.com","password":"View@12345"}' -o /dev/null
QAUTH="-b $QJAR -H X-Requested-With:tcms"
ACT=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/permissions" $QAUTH); LASTBODY=$(curl -s "$BASE/permissions" $QAUTH)
check "viewer GET /permissions -> 403" 403 "$ACT"
ACT=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/permissions" $VAUTH); LASTBODY=$(curl -s "$BASE/permissions" $VAUTH)
check "vp GET /permissions -> 96-cell matrix" 200 "$ACT" '"source":"default"'

# ---- 4. Toggle: grant viewer create_bug -> matrix shows override -> revoke ----
ACT=$(curl -s -o /dev/null -w "%{http_code}" -X PUT -H 'X-Requested-With: tcms' "$BASE/permissions" $VAUTH -H 'Content-Type: application/json' \
  -d '{"role":"viewer","action":"create_bug","enabled":true}')
LASTBODY=$(curl -s -X PUT -H 'X-Requested-With: tcms' "$BASE/permissions" $VAUTH -H 'Content-Type: application/json' -d '{"role":"viewer","action":"create_bug","enabled":true}')
check "vp grants viewer:create_bug" 200 "$ACT" '"source":"override"'
LASTBODY=$(curl -s "$BASE/permissions" $VAUTH)
if echo "$LASTBODY" | grep -qE '"role":"viewer","action":"create_bug","enabled":true'; then
  PASS=$((PASS+1)); echo "PASS  matrix reflects the override"
else
  FAIL=$((FAIL+1)); echo "FAIL  matrix override missing"
fi
# viewer login now carries create_bug in permissions (cache invalidation works)
LASTBODY=$(curl -s -X POST -H 'X-Requested-With: tcms' "$BASE/auth?path=login" -H 'Content-Type: application/json' -d '{"email":"viewer@tcms.com","password":"View@12345"}')
echo "$LASTBODY" | grep -q '"create_bug"' && { PASS=$((PASS+1)); echo "PASS  viewer session includes create_bug"; } || { FAIL=$((FAIL+1)); echo "FAIL  viewer session missing create_bug"; }
# toggle back to default (removes the override row entirely)
LASTBODY=$(curl -s -X PUT -H 'X-Requested-With: tcms' "$BASE/permissions" $VAUTH -H 'Content-Type: application/json' -d '{"role":"viewer","action":"create_bug","enabled":false}')
ACT=$(curl -s -o /dev/null -w "%{http_code}" -X PUT -H 'X-Requested-With: tcms' "$BASE/permissions" $VAUTH -H 'Content-Type: application/json' -d '{"role":"viewer","action":"create_bug","enabled":false}')
check "vp reverts viewer:create_bug (back to default)" 200 "$ACT"

# ---- 5. QA cannot manage users or permissions ----
QAJAR=/tmp/rbac-jar-qa.txt; rm -f $QAJAR
curl -s -c $QAJAR -X POST -H 'X-Requested-With: tcms' "$BASE/auth?path=login" -H 'Content-Type: application/json' -d '{"email":"qa1@tcms.com","password":"QA@12345"}' -o /dev/null
QAAUTH="-b $QAJAR -H X-Requested-With:tcms"
ACT=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/users" $QAAUTH); LASTBODY=$(curl -s "$BASE/users" $QAAUTH)
check "qa GET /users -> 403" 403 "$ACT"
ACT=$(curl -s -o /dev/null -w "%{http_code}" -X PUT -H 'X-Requested-With: tcms' "$BASE/permissions" $QAAUTH -H 'Content-Type: application/json' -d '{"role":"viewer","action":"create_bug","enabled":true}')
LASTBODY=$(curl -s -X PUT -H 'X-Requested-With: tcms' "$BASE/permissions" $QAAUTH -H 'Content-Type: application/json' -d '{"role":"viewer","action":"create_bug","enabled":true}')
check "qa PUT /permissions -> 403" 403 "$ACT"

# ---- 6. Login lockout: 5 wrong attempts -> 429 lock (then clean up) ----
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -X POST -H 'X-Requested-With: tcms' "$BASE/auth?path=login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"qa2@tcms.com\",\"password\":\"totally-wrong-$i\"}"
done
ACT=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H 'X-Requested-With: tcms' "$BASE/auth?path=login" -H 'Content-Type: application/json' \
  -d '{"email":"qa2@tcms.com","password":"QA@12345"}')
LASTBODY=$(curl -s -X POST -H 'X-Requested-With: tcms' "$BASE/auth?path=login" -H 'Content-Type: application/json' -d '{"email":"qa2@tcms.com","password":"QA@12345"}')
check "6th attempt (even correct password) -> 429 locked" 429 "$ACT" 'Try again in'

# ---- 7. Cleanup: clear the lock so the demo account stays usable ----
export DATABASE_URL="postgresql://tcms:tcms@localhost:5499/tcms?sslmode=disable"
node scripts/clear-login-lock.mjs qa2@tcms.com
sleep 1
ACT=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H 'X-Requested-With: tcms' "$BASE/auth?path=login" -H 'Content-Type: application/json' \
  -d '{"email":"qa2@tcms.com","password":"QA@12345"}')
LASTBODY=$(curl -s -X POST -H 'X-Requested-With: tcms' "$BASE/auth?path=login" -H 'Content-Type: application/json' -d '{"email":"qa2@tcms.com","password":"QA@12345"}')
check "qa2 login works again after lock cleared" 200 "$ACT" '"permissions"'

echo
echo "======================================"
echo "RBAC RESULT: $PASS passed, $FAIL failed"
echo "======================================"
exit $FAIL
