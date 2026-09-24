#!/usr/bin/env bash
# Stop the background hub started by start-hub.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT/scripts/.hub-pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "No hub pid file - nothing to stop."
  exit 0
fi
PID="$(tr -d '[:space:]' < "$PID_FILE")"
rm -f "$PID_FILE"
if [[ ! "$PID" =~ ^[0-9]+$ ]]; then
  echo "Ignoring invalid pid file contents: $PID"
  exit 0
fi

# The pid may have been reused by an unrelated process since the hub exited,
# so only signal it if it is still running the hub's CLI.
ARGS="$(ps -p "$PID" -o args= 2>/dev/null || true)"
if [[ -z "$ARGS" ]]; then
  echo "Hub pid $PID was already gone."
elif [[ "$ARGS" != *"packages/hub/dist/cli.js"* ]]; then
  echo "Pid $PID is no longer the hub ($ARGS) - leaving it alone."
elif kill "$PID" 2>/dev/null; then
  echo "Stopped hub (pid $PID)."
else
  echo "Hub pid $PID was already gone."
fi
