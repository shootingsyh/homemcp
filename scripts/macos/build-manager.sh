#!/bin/sh
set -eu
if [ "$(uname -s)" != Darwin ]; then echo "SwiftUI Manager requires macOS" >&2; exit 1; fi
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
DEST="$ROOT/build/macos-manager/HomeMCP Manager.app/Contents"
rm -rf "$DEST/Library/LoginItems" "$DEST/Library/LaunchAgents" "$DEST/MacOS/HomeMCP.Desktop"
mkdir -p "$DEST/MacOS" "$DEST/Resources"
swiftc -parse-as-library "$ROOT/native/macos/Manager/HomeMCPManagerApp.swift" "$ROOT/native/macos/Manager/DesktopIPC.swift" \
  -o "$DEST/MacOS/HomeMCP.Manager" -framework SwiftUI -framework AppKit -framework ServiceManagement -framework ScreenCaptureKit -framework ApplicationServices -framework CoreGraphics
mkdir -p "$ROOT/build/macos-keychain"
swiftc "$ROOT/native/macos/keychain-helper.swift" -o "$ROOT/build/macos-keychain/home-mcp-keychain" -framework Security
cat > "$DEST/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>si.homemcp.manager</string>
<key>CFBundleExecutable</key><string>HomeMCP.Manager</string>
<key>CFBundleShortVersionString</key><string>0.1.31</string>
<key>CFBundleVersion</key><string>31</string>
<key>CFBundleName</key><string>HomeMCP Manager</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
# Developer build locates project resources without requiring a packaged copy.
ln -sfn "$ROOT" "$DEST/Resources/HomeMCP"
echo "Built unsigned macOS Manager: $DEST"
