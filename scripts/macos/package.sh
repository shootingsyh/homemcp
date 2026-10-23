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
# Always bundle the official precompiled FRP client. The end user must not
# install Homebrew, Go, or frpc. Pin release and verify SHA-256 before extraction.
FRP_VERSION=0.71.1
case "$(uname -m)" in
  arm64)
    FRP_ARCH=arm64
    FRP_SHA256=d15d0324b99e14619c9aa46e37f6db588c06a09be4bc6f7948890b6b61077842
    ;;
  x86_64)
    FRP_ARCH=amd64
    FRP_SHA256=8acb59b6fb998cc8d209d1373d90bf70fa5ec3efeb4dfbc7bda6ce3abd78cb45
    ;;
  *) echo "Unsupported macOS architecture for frpc: $(uname -m)" >&2; exit 1 ;;
esac
FRP_NAME="frp_${FRP_VERSION}_darwin_${FRP_ARCH}"
FRP_TAR="$DEST/$FRP_NAME.tar.gz"
FRP_URL="https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${FRP_NAME}.tar.gz"
if [ ! -f "$FRP_TAR" ] || ! printf '%s  %s\n' "$FRP_SHA256" "$FRP_TAR" | shasum -a 256 -c >/dev/null 2>&1; then
  curl --fail --location --retry 3 --silent --show-error "$FRP_URL" -o "$FRP_TAR"
fi
printf '%s  %s\n' "$FRP_SHA256" "$FRP_TAR" | shasum -a 256 -c
tar -xOzf "$FRP_TAR" "$FRP_NAME/frpc" > "$RESOURCES/runtime/frpc"
chmod 755 "$RESOURCES/runtime/frpc"
"$RESOURCES/runtime/frpc" --version
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
