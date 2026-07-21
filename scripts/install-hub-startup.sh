#!/usr/bin/env bash
# Install Tailhub as a start-at-login service (macOS launchd / Linux systemd
# user unit) — the POSIX counterpart of install-hub-startup.ps1.
# Usage: ./scripts/install-hub-startup.sh [--skip-build]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CLI="$ROOT/packages/hub/dist/cli.js"
if [[ "${1:-}" != "--skip-build" && ! -f "$CLI" ]]; then
  echo "Building Tailhub (client SDK + hub)..."
  npm run build
fi
[[ -f "$CLI" ]] || { echo "Hub is not built ($CLI missing)"; exit 1; }

NODE_BIN="$(command -v node)" || { echo "node not found on PATH"; exit 1; }

case "$(uname -s)" in
  Darwin)
    PLIST_DIR="$HOME/Library/LaunchAgents"
    PLIST="$PLIST_DIR/com.tailhub.hub.plist"
    mkdir -p "$PLIST_DIR"
    sed -e "s|@NODE@|$NODE_BIN|" -e "s|@CLI@|$CLI|" \
      "$ROOT/deploy/launchd/com.tailhub.hub.plist" > "$PLIST"
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo "Installed launchd agent: $PLIST"
    echo "The hub now starts at login. Remove with ./scripts/uninstall-hub-startup.sh"
    ;;
  Linux)
    command -v systemctl >/dev/null || { echo "systemd not available; use scripts/start-hub.sh instead"; exit 1; }
    UNIT_DIR="$HOME/.config/systemd/user"
    UNIT="$UNIT_DIR/tailhub.service"
    mkdir -p "$UNIT_DIR"
    sed -e "s|@EXEC_START@|$NODE_BIN $CLI start|" \
      "$ROOT/deploy/systemd/tailhub.service" > "$UNIT"
    systemctl --user daemon-reload
    systemctl --user enable --now tailhub.service
    echo "Installed systemd user unit: $UNIT"
    echo "Status: systemctl --user status tailhub"
    echo "To keep the hub running while logged out: loginctl enable-linger $USER"
    ;;
  *)
    echo "Unsupported OS: $(uname -s). On Windows use scripts/install-hub-startup.ps1."
    exit 1
    ;;
esac

echo ""
echo "Expose over your tailnet (run once):"
echo "  tailscale serve --bg --https=443 http://127.0.0.1:${TAILHUB_PORT:-4747}"
