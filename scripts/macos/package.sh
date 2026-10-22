#!/bin/sh
set -eu
if [ "$(uname -s)" != Darwin ]; then echo "Package builds require macOS" >&2; exit 1; fi
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
VERSION=$(node -p "require('$ROOT/package.json').version")
DEST="$ROOT/build/macos-dist"
PAYLOAD="$DEST/payload"
sh "$ROOT/scripts/macos/build-manager.sh"
MANAGER="$PAYLOAD/Applications/HomeMCP Manager.app"
rm -rf "$MANAGER"
mkdir -p "$PAYLOAD/Applications" "$DEST"
cp -R "$ROOT/build/macos-manager/HomeMCP Manager.app" "$MANAGER"
RESOURCES="$MANAGER/Contents/Resources/HomeMCP"
rm -rf "$RESOURCES"
mkdir -p "$RESOURCES"
# Developer package bundles source and locally installed dependencies only.
# An independently signed production distribution must bundle a pinned Node runtime.
cp -R "$ROOT/src" "$ROOT/scripts" "$ROOT/web" "$RESOURCES/"
mkdir -p "$RESOURCES/native"
cp -R "$ROOT/native/macos" "$RESOURCES/native/"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$RESOURCES/"
# Pin the runtime used by CI so the GUI cannot select an obsolete system Node.
NODE_BIN=$(command -v node)
node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)'
mkdir -p "$RESOURCES/runtime"
cp -L "$NODE_BIN" "$RESOURCES/runtime/node"
chmod 755 "$RESOURCES/runtime/node"
# Fail the build if the packaged runtime cannot parse the exact scripts shipped.
"$RESOURCES/runtime/node" --check "$RESOURCES/scripts/macos/setup.mjs"
"$RESOURCES/runtime/node" --check "$RESOURCES/scripts/macos/provision.mjs"
"$RESOURCES/runtime/node" --check "$RESOURCES/scripts/macos/passkey-link.mjs"
"$RESOURCES/runtime/node" --version
if [ -d "$ROOT/node_modules" ]; then cp -R "$ROOT/node_modules" "$RESOURCES/"; fi
if [ -d "$ROOT/build/macos-worker" ]; then
  mkdir -p "$RESOURCES/build"
  cp -R "$ROOT/build/macos-worker" "$RESOURCES/build/"
fi
mkdir -p "$DEST/pkg-scripts"
cp "$ROOT/scripts/macos/postinstall.sh" "$DEST/pkg-scripts/postinstall"
chmod 755 "$DEST/pkg-scripts/postinstall"
pkgbuild --scripts "$DEST/pkg-scripts" --root "$PAYLOAD" --identifier "si.homemcp.client" --version "$VERSION" "$DEST/HomeMCP-unsigned.pkg"
echo "Unsigned development package: $DEST/HomeMCP-unsigned.pkg (NOT release ready)"
