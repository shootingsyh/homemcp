#!/bin/sh
# Sign nested Mach-O executables first, then seal the outer .app.
set -eu
APP=${1:?usage: sign-app.sh path-to-app}
IDENTITY=${HOMEMCP_CODESIGN_IDENTITY:?Set HOMEMCP_CODESIGN_IDENTITY to a Developer ID Application or Apple Development certificate}
[ -d "$APP/Contents" ] || { echo "Missing app bundle" >&2; exit 1; }
RES="$APP/Contents/Resources/HomeMCP"
sign_one() {
  [ -f "$1" ] || { echo "Missing executable $1" >&2; exit 1; }
  /usr/bin/codesign --force --sign "$IDENTITY" --options runtime "$1"
  /usr/bin/codesign --verify --strict --verbose=2 "$1"
}
# Sign embedded libraries and executable Mach-O binaries, including Playwright dependencies.
# Avoid following symlinks and do not accidentally sign scripts or data.
find "$RES" -type f | while IFS= read -r item; do
  case "$(/usr/bin/file -b "$item")" in
    *Mach-O*) sign_one "$item" ;;
  esac
done
sign_one "$APP/Contents/MacOS/HomeMCP.Desktop"
# Main executable is sealed as part of the bundle signature.
 /usr/bin/codesign --force --sign "$IDENTITY" --options runtime "$APP"
 /usr/bin/codesign --verify --deep --strict --verbose=2 "$APP"
 /usr/bin/codesign -dv --verbose=4 "$APP/Contents/MacOS/HomeMCP.Desktop" 2>&1 | grep -E 'Authority=|TeamIdentifier=|Runtime Version'
echo "Signed HomeMCP Manager and nested desktop helper with $IDENTITY"
