#!/usr/bin/env bash
# Fresh mock API + static server, then the Playwright walk-through.
set -e
cd "$(dirname "$0")"
pkill -f "node server.js" 2>/dev/null || true
node server.js > /tmp/agentmart-mock.log 2>&1 &
MOCK=$!
PORT=8788 LIVE=1 node server.js > /tmp/agentmart-mock-live.log 2>&1 &
MOCK2=$!
( cd ../web && python3 -m http.server 8080 > /tmp/agentmart-static.log 2>&1 & echo $! > /tmp/agentmart-static.pid )
sleep 1
PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers} python3 e2e.py; RC=$?
kill $MOCK $MOCK2 $(cat /tmp/agentmart-static.pid) 2>/dev/null || true
exit $RC
