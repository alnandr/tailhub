#!/usr/bin/env bash
# Remove the start-at-login service installed by install-hub-startup.sh.
set -euo pipefail

case "$(uname -s)" in
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/com.tailhub.hub.plist"
    if [[ -f "$PLIST" ]]; then
      launchctl unload "$PLIST" 2>/dev/null || true
      rm "$PLIST"
      echo "Removed launchd agent: $PLIST"
    else
      echo "No launchd agent installed."
    fi
    ;;
  Linux)
    if systemctl --user list-unit-files tailhub.service --no-legend 2>/dev/null | grep -q tailhub; then
      systemctl --user disable --now tailhub.service || true
      rm -f "$HOME/.config/systemd/user/tailhub.service"
      systemctl --user daemon-reload
      echo "Removed systemd user unit."
    else
      echo "No systemd user unit installed."
    fi
    ;;
  *)
    echo "Unsupported OS: $(uname -s). On Windows use scripts/uninstall-hub-startup.ps1."
    exit 1
    ;;
esac
