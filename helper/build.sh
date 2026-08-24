#!/bin/bash
# Canonical build. SwiftPM needs a full Xcode (cannot resolve --show-sdk-platform-path from
# Command Line Tools alone), so we drive swiftc directly. Package.swift is kept for when Xcode lands.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build

swiftc -O -sdk "$(xcrun --show-sdk-path)" -target arm64-apple-macos13.0 \
  -o build/stc-helper src/*.swift

# Signing identity. A STABLE identity is what keeps TCC grants alive across rebuilds; ad-hoc
# signatures are cdhash-keyed, so every recompile silently revokes them (PHASE-0 §6).
# Override with:  SIGN_ID="Developer ID Application: ..." ./build.sh
# NB: `find-identity -v` filters on TRUST, and a self-signed root is untrusted by default — yet it
# signs perfectly well. So fall back to the unfiltered list rather than dropping to ad-hoc.
if [ -z "${SIGN_ID:-}" ]; then
  SIGN_ID=$(security find-identity -v -p codesigning 2>/dev/null \
            | grep -oE '"[^"]+"' | tr -d '"' | head -1 || true)
fi
if [ -z "${SIGN_ID:-}" ]; then
  SIGN_ID=$(security find-identity -p codesigning 2>/dev/null \
            | grep -oE '"[^"]+"' | tr -d '"' | head -1 || true)
  [ -n "${SIGN_ID:-}" ] && echo "  (using untrusted-but-usable identity: $SIGN_ID)"
fi

if [ -n "${SIGN_ID:-}" ]; then
  codesign --force --options runtime --timestamp=none --sign "$SIGN_ID" build/stc-helper
  echo "built helper/build/stc-helper  [signed: $SIGN_ID]"
else
  codesign --force --sign - build/stc-helper
  echo "built helper/build/stc-helper  [AD-HOC]"
  echo
  echo "  WARNING: no code-signing identity found, so this binary is ad-hoc signed."
  echo "  Its TCC identity is its cdhash, which changes on every rebuild — permission"
  echo "  grants will silently vanish each time you recompile. See PHASE-1.md > Signing."
fi
codesign -dvv build/stc-helper 2>&1 | grep -E "Identifier|Signature|TeamIdentifier" | sed 's/^/  /'
