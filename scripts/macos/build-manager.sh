#!/bin/sh
set -eu
if [ "$(uname -s)" != Darwin ]; then echo "SwiftUI Manager requires macOS" >&2; exit 1; fi
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
DEST="$ROOT/build/macos-manager/HomeMCP Manager.app/Contents"
mkdir -p "$DEST/MacOS" "$DEST/Resources" "$DEST/Library/LaunchAgents"
swiftc -parse-as-library "$ROOT/native/macos/Manager/HomeMCPManagerApp.swift" \
  -o "$DEST/MacOS/HomeMCP.Manager" -framework SwiftUI -framework AppKit -framework ServiceManagement
mkdir -p "$ROOT/build/macos-keychain"
swiftc "$ROOT/native/macos/keychain-helper.swift" -o "$ROOT/build/macos-keychain/home-mcp-keychain" -framework Security
swiftc "$ROOT/native/macos/desktop-helper.swift" -o "$DEST/MacOS/HomeMCP.Desktop" -framework AppKit -framework ApplicationServices -framework CoreGraphics
cat > "$DEST/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>si.homemcp.manager</string>
<key>CFBundleExecutable</key><string>HomeMCP.Manager</string>
<key>CFBundleShortVersionString</key><string>0.1.28</string>
<key>CFBundleVersion</key><string>28</string>
<key>CFBundleName</key><string>HomeMCP Manager</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
cat > "$DEST/Library/LaunchAgents/si.homemcp.desktop.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>si.homemcp.desktop.sm</string>
<key>BundleProgram</key><string>Contents/MacOS/HomeMCP.Desktop</string>
<key>ProgramArguments</key><array><string>HomeMCP.Desktop</string><string>--serve-default</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
</dict></plist>
PLIST
# Developer build locates project resources without requiring a packaged copy.
ln -sfn "$ROOT" "$DEST/Resources/HomeMCP"
echo "Built unsigned macOS Manager: $DEST"
