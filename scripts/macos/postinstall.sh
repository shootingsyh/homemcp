#!/bin/sh
# pkgbuild postinstall runs as root. Activate HomeMCP only in the currently
# logged-in console user's session; never provision data in root's HOME.
set -u
LOG="/var/log/homemcp-postinstall.log"
APP="/Applications/HomeMCP Manager.app"
ROOT="$APP/Contents/Resources/HomeMCP"
USER_NAME=$(/usr/bin/stat -f '%Su' /dev/console 2>/dev/null || echo "")
case "$USER_NAME" in ""|root|loginwindow|_mbsetupuser)
  echo "No interactive console user; open HomeMCP Manager after login." >> "$LOG"
  exit 0;;
esac
USER_ID=$(/usr/bin/id -u "$USER_NAME") || exit 0
USER_HOME=$(/usr/bin/dscl . -read "/Users/$USER_NAME" NFSHomeDirectory 2>/dev/null | /usr/bin/awk '{print $2}')
[ -n "$USER_HOME" ] || exit 0
if [ -f "$ROOT/scripts/macos/activate-installed.sh" ]; then
  /bin/launchctl asuser "$USER_ID" /usr/bin/sudo -u "$USER_NAME" /usr/bin/env HOME="$USER_HOME" /bin/sh "$ROOT/scripts/macos/activate-installed.sh" >> "$LOG" 2>&1 || echo "HomeMCP activation failed; see $LOG" >> "$LOG"
fi
/bin/launchctl asuser "$USER_ID" /usr/bin/sudo -u "$USER_NAME" /usr/bin/open "$APP" >> "$LOG" 2>&1 || true
exit 0
