#!/bin/sh
set -eu
if [ "$(uname -s)" != Darwin ]; then echo "Package builds require macOS" >&2; exit 1; fi
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
VERSION=$(node -p "require('$ROOT/package.json').version")
DEST="$ROOT/build/macos-dist"
PAYLOAD="$DEST/payload"
"$ROOT/scripts/macos/build-manager.sh"
MANAGER="$PAYLOAD/Applications/HomeMCP Manager.app"
rm -rf "$MANAGER"
mkdir -p "$PAYLOAD/Applications" "$DEST"
cp -R "$ROOT/build/macos-manager/HomeMCP Manager.app" "$MANAGER"
RESOURCES="$MANAGER/Contents/Resources/HomeMCP"
rm -rf "$RESOURCES"
mkdir -p "$RESOURCES"
# Developer package bundles source and locally installed dependencies only.
# An independently signed production distribution must bundle a pinned Node runtime.
cp -R "$ROOT/src" "$ROOT/scripts" "$ROOT/web" "$ROOT/native/macos" "$RESOURCES/"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$RESOURCES/"
if [ -d "$ROOT/node_modules" ]; then cp -R "$ROOT/node_modules" "$RESOURCES/"; fi
if [ -d "$ROOT/build/macos-worker" ]; then
  mkdir -p "$RESOURCES/build"
  cp -R "$ROOT/build/macos-worker" "$RESOURCES/build/"
fi
pkgbuild --root "$PAYLOAD" --identifier "si.homemcp.client" --version "$VERSION" "$DEST/HomeMCP-unsigned.pkg"
echo "Unsigned development package: $DEST/HomeMCP-unsigned.pkg (NOT release ready)"
