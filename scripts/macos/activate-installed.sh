#!/bin/sh
set -eu
APP="/Applications/HomeMCP Manager.app"
ROOT="$APP/Contents/Resources/HomeMCP"
NODE="$ROOT/runtime/node"
[ -x "$NODE" ] || { echo "Bundled Node runtime missing" >&2; exit 1; }
BASE="$HOME/Library/Application Support/HomeMCP"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/HomeMCP"
LABEL="xyz.shootingsyh.homemcp"
mkdir -p "$AGENTS" "$LOGS"
chmod 700 "$LOGS"
# Provision only when absent; preserve existing config, Passkeys and credentials.
"$NODE" "$ROOT/scripts/macos/provision.mjs"
PLIST="$AGENTS/$LABEL.plist"
HOMEMCP_APP_ROOT="$ROOT" HOMEMCP_NODE_PATH="$NODE" HOMEMCP_PLIST_PATH="$PLIST" HOMEMCP_BASE_PATH="$BASE" "$NODE" "$ROOT/scripts/macos/write-launch-agent.mjs"
chmod 600 "$PLIST"
/bin/launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
/bin/launchctl bootstrap "gui/$(id -u)" "$PLIST"
/bin/launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "HomeMCP Host LaunchAgent activated; opening Manager."
