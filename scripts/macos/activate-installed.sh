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
"$NODE" "$ROOT/scripts/macos/upgrade-tools.mjs"
PLIST="$AGENTS/$LABEL.plist"
HOMEMCP_APP_ROOT="$ROOT" HOMEMCP_NODE_PATH="$NODE" HOMEMCP_PLIST_PATH="$PLIST" HOMEMCP_BASE_PATH="$BASE" "$NODE" "$ROOT/scripts/macos/write-launch-agent.mjs"
chmod 600 "$PLIST"
/bin/launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
/bin/launchctl bootstrap "gui/$(id -u)" "$PLIST"
/bin/launchctl kickstart -k "gui/$(id -u)/$LABEL"
# Native Desktop Service is independently supervised so Manager may quit.
DESKTOP="$APP/Contents/MacOS/HomeMCP.Desktop"
DESKTOP_PLIST="$AGENTS/si.homemcp.desktop.plist"
if [ -x "$DESKTOP" ]; then
  cat > "$DESKTOP_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>si.homemcp.desktop</string>
<key>ProgramArguments</key><array><string>$DESKTOP</string><string>--serve</string><string>$BASE/desktop.sock</string></array>
<key>AssociatedBundleIdentifiers</key><array><string>si.homemcp.manager</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardErrorPath</key><string>$LOGS/desktop-stderr.log</string>
</dict></plist>
EOF
  chmod 600 "$DESKTOP_PLIST"
  /bin/launchctl bootout "gui/$(id -u)" "$DESKTOP_PLIST" 2>/dev/null || true
  /bin/launchctl bootstrap "gui/$(id -u)" "$DESKTOP_PLIST"
fi
echo "HomeMCP Host LaunchAgent activated; opening Manager."
