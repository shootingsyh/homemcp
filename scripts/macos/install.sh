#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
if [ "$(uname -s)" != Darwin ]; then
  echo "macOS is required" >&2
  exit 1
fi
NODE=$(command -v node || true)
if [ -z "$NODE" ]; then
  echo "Node.js 22+ is required" >&2
  exit 1
fi
"$NODE" -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)' || {
  echo "Node.js 22+ is required" >&2
  exit 1
}
npm ci --ignore-scripts
mkdir -p build/macos-worker
npm install --prefix build/macos-worker --no-audit --no-fund --ignore-scripts --save=false @playwright/mcp@0.0.48
mkdir -p native/macos
swiftc native/macos/keychain-helper.swift -framework Security -o native/macos/home-mcp-keychain
chmod 700 native/macos/home-mcp-keychain
"$NODE" scripts/macos/provision.mjs
BASE="${HOMEMCP_HOME:-$HOME/Library/Application Support/HomeMCP}"
AGENTS="$HOME/Library/LaunchAgents"
LABEL="xyz.shootingsyh.homemcp"
mkdir -p "$AGENTS" "$HOME/Library/Logs/HomeMCP"
chmod 700 "$HOME/Library/Logs/HomeMCP"
PLIST="$AGENTS/$LABEL.plist"
# Plist XML is written by Node, which escapes all dynamic path values.
HOMEMCP_APP_ROOT="$ROOT" HOMEMCP_NODE_PATH="$NODE" HOMEMCP_PLIST_PATH="$PLIST" HOMEMCP_BASE_PATH="$BASE" "$NODE" scripts/macos/write-launch-agent.mjs
chmod 600 "$PLIST"
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "HomeMCP macOS LaunchAgent installed. Configuration and browser sessions are kept under: $BASE"
