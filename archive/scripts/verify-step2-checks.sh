#!/usr/bin/env bash
# Step-2 audit v2 — clean probes for the rewritten CSRF check + steps field.
BASE=http://localhost:3000
JAR=/tmp/step2-jar.txt
code() { local out=$1; shift; curl -s -o "$out" -w '%{http_code}' "$@"; }

echo "== A: first-party POST, bogus moduleId 'x' (marker, no Origin) =="
A=$(code /tmp/s2a.json -X POST "$BASE/api/test-cases" -b $JAR -H 'Content-Type: application/json' \
  -H 'X-Requested-With: tcms' -d '{"title":"probe A","moduleId":"x","description":"x"}')
echo "  -> HTTP $A  body: $(head -c 220 /tmp/s2a.json)"

echo "== B: first-party POST, VALID moduleId (marker, no Origin) =="
MOD=$(python3 -c "import json;print(json.load(open('/tmp/s2-mods.json'))['data'][0]['moduleId'])")
B=$(code /tmp/s2b.json -X POST "$BASE/api/test-cases" -b $JAR -H 'Content-Type: application/json' \
  -H 'X-Requested-With: tcms' -d "{\"title\":\"probe B step2-audit\",\"moduleId\":\"$MOD\",\"description\":\"probe\",\"priority\":\"medium\",\"status\":\"draft\"}")
echo "  -> HTTP $B  body: $(head -c 220 /tmp/s2b.json)"

echo "== C: cross-site evil Origin WITH marker, VALID moduleId (the rewritten check) =="
C=$(code /tmp/s2c.json -X POST "$BASE/api/test-cases" -b $JAR -H 'Content-Type: application/json' \
  -H 'Origin: https://evil.example.com' -H 'X-Requested-With: tcms' \
  -d "{\"title\":\"probe C step2-audit\",\"moduleId\":\"$MOD\",\"description\":\"probe\",\"priority\":\"medium\",\"status\":\"draft\"}")
echo "  -> HTTP $C  body: $(head -c 220 /tmp/s2c.json)"

echo "== D: tc detail — does any response emit a bare steps key? =="
python3 - <<'PY'
import json
d = json.load(open('/tmp/s2-tc-list.json'))
print('  list json top-level keys:', sorted(d.keys()))
rows = d.get('data') or d.get('testCases') or []
print('  rows:', len(rows), '| first row keys:', sorted(rows[0].keys()) if rows else None)
detail = json.load(open('/tmp/s2-tc-detail.json'))
print('  detail top-level keys:', sorted(detail.keys()))
PY
