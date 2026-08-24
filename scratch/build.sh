#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
APP="STCSpikeCapture.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>STCSpikeCapture</string>
  <key>CFBundleDisplayName</key><string>STC Spike Capture</string>
  <key>CFBundleIdentifier</key><string>com.studiocartelli.stcspikecapture</string>
  <key>CFBundleExecutable</key><string>STCSpikeCapture</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSCameraUsageDescription</key><string>Phase 0 spike: measure camera/screen timestamp alignment.</string>
  <key>NSMicrophoneUsageDescription</key><string>Phase 0 spike: measure mic/screen timestamp alignment.</string>
</dict></plist>
PLIST
swiftc -O -sdk "$(xcrun --show-sdk-path)" -target arm64-apple-macos13.0 \
  -o "$APP/Contents/MacOS/STCSpikeCapture" main.swift
SIGN_ID="${SIGN_ID:-$(security find-identity -p codesigning 2>/dev/null | grep -oE '"[^"]+"' | tr -d '"' | head -1)}"
if [ -n "$SIGN_ID" ]; then
  codesign --force --timestamp=none --sign "$SIGN_ID" "$APP"
  echo "signed with: $SIGN_ID"
else
  codesign --force --sign - --timestamp=none "$APP"
  echo "AD-HOC signed (no identity found)"
fi
echo "built $APP"
codesign -dv "$APP" 2>&1 | grep -E "Identifier|CDHash" || true
