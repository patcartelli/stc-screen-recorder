#!/bin/bash
# Builds STCSigningProbe.app and signs it with the same stable identity as the
# helper. Fresh bundle id on purpose: a clean TCC identity with no history from
# the phase-0 spike app, so the grant we observe is unambiguously ours.
set -euo pipefail
cd "$(dirname "$0")"
APP="STCSigningProbe.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>STCSigningProbe</string>
  <key>CFBundleDisplayName</key><string>STC Signing Probe</string>
  <key>CFBundleIdentifier</key><string>com.studiocartelli.stcsigningprobe</string>
  <key>CFBundleExecutable</key><string>STCSigningProbe</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PLIST
swiftc -O -sdk "$(xcrun --show-sdk-path)" -target arm64-apple-macos13.0 \
  -o "$APP/Contents/MacOS/STCSigningProbe" main.swift

# Same identity resolution as helper/build.sh: `find-identity -v` filters on
# TRUST, and a self-signed root is untrusted by default yet signs perfectly well.
SIGN_ID="${SIGN_ID:-$(security find-identity -p codesigning 2>/dev/null | grep -oE '"[^"]+"' | tr -d '"' | head -1)}"
if [ -z "${SIGN_ID:-}" ]; then
  echo "ERROR: no code-signing identity found — an ad-hoc probe cannot test identity stability." >&2
  exit 1
fi
codesign --force --timestamp=none --sign "$SIGN_ID" "$APP"
echo "built $APP  [signed: $SIGN_ID]"
codesign -d -r- "$APP" 2>&1 | tail -1
