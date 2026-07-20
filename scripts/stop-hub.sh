#!/usr/bin/env bash
# Stop the background hub started by start-hub.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT/scripts/.hub-pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "No hub pid file - nothing to stop."
  exit 0
fi
PID="$(cat "$PID_FILE")"
if kill "$PID" 2>/dev/null; then
  echo "Stopped hub (pid $PID)."
else
  echo "Hub pid $PID was already gone."
fi
rm -f "$PID_FILE"
