#!/bin/bash
# Orchestrates a 90-second WS outage for scripts/ws-outage-diag.mjs --phase outage.
# Start diag client -> kill :3003 -> wait 90s -> restart with the EXACT
# start-tcms.sh recipe -> collect client + server logs.
cd /home/z/my-project || exit 1

(setsid nohup node scripts/ws-outage-diag.mjs --phase outage --hold-ms 150000 >/tmp/ws-outage-diag.log 2>&1 &)
echo "diag client started (log /tmp/ws-outage-diag.log) at $(date +%H:%M:%S.%3N)"
sleep 6

WS_LINES_BEFORE=$(wc -l < /tmp/tcms-ws.log)
WSPID=$(ss -tlnp 2>/dev/null | grep ':3003 ' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
echo "WS service pid=$WSPID cmd=[$(tr '\0' ' ' < /proc/$WSPID/cmdline 2>/dev/null)] cwd=[$(readlink /proc/$WSPID/cwd 2>/dev/null)]"
echo "=== KILLING WS service (kill -9 $WSPID) at $(date +%H:%M:%S.%3N) ==="
kill -9 "$WSPID"
sleep 1
if ss -tln | grep -q ':3003 '; then echo "ERROR: :3003 still listening"; else echo "confirmed :3003 DOWN at $(date +%H:%M:%S.%3N) (outage begins)"; fi
echo "--- last 3 WS service log lines before kill ---"
tail -3 /tmp/tcms-ws.log

sleep 90
echo "=== RESTARTING WS service at $(date +%H:%M:%S.%3N) (outage was ~91s) ==="
(cd mini-services/notifications && nohup setsid bun index.ts >>/tmp/tcms-ws.log 2>&1 &)
for i in $(seq 1 30); do ss -tln | grep -q ':3003 ' && break; sleep 0.5; done
if ss -tln | grep -q ':3003 '; then echo "=== :3003 LISTENING again at $(date +%H:%M:%S.%3N) ==="; else echo "ERROR: restart failed"; fi

# wait for the diag to finish its hold + final room probe
for i in $(seq 1 90); do pgrep -f "ws-outage-diag.mjs" >/dev/null || break; sleep 1; done
echo "=== diag client log (raw) ==="
cat /tmp/ws-outage-diag.log
echo "=== WS service log lines written since the restart (line $((WS_LINES_BEFORE + 1)) onward) ==="
tail -n +$((WS_LINES_BEFORE + 1)) /tmp/tcms-ws.log
