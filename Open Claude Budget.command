#!/bin/sh
# Double-click this file to start the dashboard and open it in your browser.
# Close the Terminal window that appears to stop it.
#
# For always-on instead, run scripts/install-launchagent.sh once.
set -eu

cd "$(dirname "$0")"
PORT="${BUDGET_PORT:-4478}"

# Already running? Just open it.
if curl -s -o /dev/null "http://localhost:$PORT/api/state" 2>/dev/null; then
  echo "claude-budget already running."
  open "http://localhost:$PORT"
  exit 0
fi

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  for c in /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$c" ] && NODE="$c" && break
  done
fi
if [ -z "$NODE" ]; then
  echo "node not found. Install Node 20+ and try again."
  read -r _ || true
  exit 1
fi

echo "Starting claude-budget on http://localhost:$PORT"
"$NODE" src/server.mjs &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT INT TERM

# Wait for it to answer before opening the browser.
i=0
while [ $i -lt 40 ]; do
  curl -s -o /dev/null "http://localhost:$PORT/api/state" 2>/dev/null && break
  i=$((i + 1))
  sleep 0.25
done

open "http://localhost:$PORT"
echo
echo "Running. Close this window to stop."
wait $SERVER_PID
