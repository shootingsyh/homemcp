#!/bin/sh
set -eu
if [ "$(uname -s)" != Darwin ]; then echo "SwiftUI Manager requires macOS" >&2; exit 1; fi
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
DEST="$ROOT/build/macos-manager/HomeMCP Manager.app/Contents"
mkdir -p "$DEST/MacOS" "$DEST/Resources"
swiftc -parse-as-library "$ROOT/native/macos/Manager/HomeMCPManagerApp.swift" \
  -o "$DEST/MacOS/HomeMCP.Manager" -framework SwiftUI -framework AppKit
cat > "$DEST/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>si.homemcp.manager</string>
<key>CFBundleExecutable</key><string>HomeMCP.Manager</string>
<key>CFBundleName</key><string>HomeMCP Manager</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
# Developer build locates project resources without requiring a packaged copy.
ln -sfn "$ROOT" "$DEST/Resources/HomeMCP"
echo "Built unsigned macOS Manager: $DEST"
