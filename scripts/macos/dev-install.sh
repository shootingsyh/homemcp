#!/bin/sh
# Selectively deploy/restart HomeMCP development components without root.
set -eu
COMPONENT=${1:-}
ACTION=${2:-restart}
APP="$HOME/Applications/HomeMCP Manager Dev.app"
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
AGENT="$HOME/Library/LaunchAgents/si.homemcp.desktop.dev.plist"
SOCKET="$HOME/Library/Application Support/HomeMCP/desktop-dev.sock"
LABEL=si.homemcp.desktop.dev
UID_NOW=$(id -u)
case "$COMPONENT:$ACTION" in
  desktop:install|desktop:restart|desktop:status|manager:restart|manager:status) ;;
  *) echo "Usage: sh scripts/macos/dev-install.sh desktop {install|restart|status} | manager {restart|status}" >&2; exit 2;;
esac
if [ "$COMPONENT" = manager ]; then
  if [ "$ACTION" = restart ]; then
    /usr/bin/open "$APP"
  else
    /usr/bin/pgrep -fl 'HomeMCP.Manager' || true
  fi
  exit 0
fi
if [ "$ACTION" = status ]; then
  /bin/launchctl print "gui/$UID_NOW/$LABEL" 2>&1 || true
  ls -l "$SOCKET" 2>&1 || true
  exit 0
fi
if [ "$ACTION" = install ]; then
  mkdir -p "$HOME/Applications"
  if [ -d "$APP" ]; then echo "Existing development app preserved; copy a new build explicitly before installing service"; fi
fi
HELPER="$APP/Contents/MacOS/HomeMCP.Desktop"
[ -x "$HELPER" ] || { echo "Desktop executable unavailable: $HELPER" >&2; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/HomeMCP" "$HOME/Library/Application Support/HomeMCP"
cat > "$AGENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array><string>$HELPER</string><string>--serve</string><string>$SOCKET</string></array>
<key>AssociatedBundleIdentifiers</key><array><string>si.homemcp.manager</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardErrorPath</key><string>$HOME/Library/Logs/HomeMCP/desktop-dev-stderr.log</string>
</dict></plist>
EOF
chmod 600 "$AGENT"
/usr/bin/plutil -lint "$AGENT"
/bin/launchctl bootout "gui/$UID_NOW/$LABEL" 2>/dev/null || true
/bin/launchctl bootstrap "gui/$UID_NOW" "$AGENT"
/bin/launchctl kickstart "gui/$UID_NOW/$LABEL"
echo "Desktop service registered: $LABEL"
