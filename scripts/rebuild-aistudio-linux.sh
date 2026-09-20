#!/bin/bash
# Rebuilds the Linux runtime for BME AI-Studio 3.1.0 from the Windows release.
#
# Bosch ships BME AI-Studio only as a Windows build, but it is an Electron app:
# the application code in resources/app.asar is portable JavaScript. Only three
# native modules are platform specific, and Linux builds of all three exist.
# This script unpacks the Windows release, swaps those three, and installs the
# result next to a Linux Electron 19.1.9 runtime.
#
# Usage: rebuild-aistudio-linux.sh /path/to/bme_ai_studio_desktop_v3-1-0_win2
set -euo pipefail

WIN_DIR="${1:?usage: $0 /path/to/bme_ai_studio_desktop_v3-1-0_win2}"
WORK="$(mktemp -d)"
PREFIX=/opt/bme-ai-studio
ELECTRON_VERSION=19.1.9          # the version the Windows build ships (Chrome/102)

echo "==> unpacking app.asar"
cd "$WORK"
npx --yes @electron/asar extract "$WIN_DIR/resources/app.asar" app
cp -rn "$WIN_DIR/resources/app.asar.unpacked/src/config/demo.bmeproject" app/src/config/ || true

echo "==> installing Linux Electron $ELECTRON_VERSION"
echo '{"name":"bme-ai-studio-linux","version":"1.0.0","private":true}' > package.json
npm i --no-audit --no-fund "electron@$ELECTRON_VERSION"

echo "==> fetching Linux builds of the native modules"
mkdir staging && cd staging
echo '{"name":"staging","version":"1.0.0","private":true}' > package.json
npm i --no-audit --no-fund sqlite3@5.1.6 @tensorflow/tfjs-node@3.20.0
npm i --no-audit --no-fund --ignore-scripts better-sqlite3@7.6.2
# better-sqlite3 7.x is a V8-ABI addon, so it needs the Electron 19 (ABI 106) prebuild.
(cd node_modules/better-sqlite3 && npx --yes prebuild-install@7 \
    --runtime=electron --target="$ELECTRON_VERSION" --arch=x64 --platform=linux)
cd ..

echo "==> swapping Windows binaries for Linux ones"
A="$WORK/app/node_modules"; S="$WORK/staging/node_modules"
cp -f  "$S/better-sqlite3/build/Release/better_sqlite3.node" \
       "$A/better-sqlite3/build/Release/better_sqlite3.node"
rm -rf "$A/sqlite3/lib/binding"/*
cp -r  "$S/sqlite3/lib/binding/napi-v6-linux-glibc-x64" "$A/sqlite3/lib/binding/"
rm -f  "$A/@tensorflow/tfjs-node/lib/napi-v8"/* "$A/@tensorflow/tfjs-node/deps/lib"/*
cp -f  "$S/@tensorflow/tfjs-node/lib/napi-v8"/* "$A/@tensorflow/tfjs-node/lib/napi-v8/"
cp -f  "$S/@tensorflow/tfjs-node/deps/lib"/*    "$A/@tensorflow/tfjs-node/deps/lib/"

echo "==> installing to $PREFIX"
sudo rm -rf "$PREFIX"
sudo mkdir -p "$PREFIX"
sudo cp -a app node_modules package.json "$PREFIX/"
sudo chown root:root "$PREFIX/node_modules/electron/dist/chrome-sandbox"
sudo chmod 4755 "$PREFIX/node_modules/electron/dist/chrome-sandbox"
sudo install -Dm644 app/src/renderer/assets/app-icon.png \
    /usr/share/icons/hicolor/512x512/apps/bme-ai-studio.png

rm -rf "$WORK"
echo "==> done; launch with /usr/local/bin/bme-ai-studio"
