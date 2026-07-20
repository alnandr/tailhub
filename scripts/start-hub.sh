#!/usr/bin/env bash
# Start the Tailhub hub in the background (macOS / Linux).
# Usage: ./scripts/start-hub.sh [--skip-build]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${TAILHUB_PORT:-4747}"
LOG_DIR="$ROOT/scripts/hub-logs"
PID_FILE="$ROOT/scripts/.hub-pid"
mkdir -p "$LOG_DIR"

if [[ "${1:-}" != "--skip-build" ]]; then
  echo "Building Tailhub (client SDK + hub)..."
  npm run build
fi

CLI="$ROOT/packages/hub/dist/cli.js"
[[ -f "$CLI" ]] || { echo "Hub is not built ($CLI missing)"; exit 1; }

if [[ -f "$PID_FILE" ]]; then
  "$ROOT/scripts/stop-hub.sh" || true
fi

nohup node "$CLI" start >"$LOG_DIR/hub.out.log" 2>"$LOG_DIR/hub.err.log" &
HUB_PID=$!
echo "$HUB_PID" > "$PID_FILE"

for _ in $(seq 1 50); do
  sleep 0.3
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "Tailhub is running."
    echo "  Hub + console: http://127.0.0.1:$PORT  (pid $HUB_PID)"
    echo "  Logs:          $LOG_DIR"
    echo "  Stop:          ./scripts/stop-hub.sh"
    echo ""
    echo "Expose over your tailnet (run once):"
    echo "  tailscale serve --bg --https=443 http://127.0.0.1:$PORT"
    exit 0
  fi
done

echo "Hub launched but the health check failed; recent log:"
tail -n 30 "$LOG_DIR/hub.err.log" "$LOG_DIR/hub.out.log" || true
exit 1
