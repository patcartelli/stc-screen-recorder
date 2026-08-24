#!/bin/bash
# Run the capture by exec'ing the binary DIRECTLY, so it inherits THIS terminal's TCC identity.
# (run.sh uses `open -a`, which gives the app its own identity — a different grant entirely.)
cd "$(dirname "$0")"
OUT="$PWD/out"; mkdir -p "$OUT"; rm -f "$OUT/run.log"
cat <<'TXT'
Follow the SPOKEN cues:
   1.5s  'click'  -> click a Finder toolbar button, deliberately (pause first)
   4.2s  'clap'   -> CLAP ON CAMERA and CLICK at the same instant
   7.0s  'drag'   -> drag a window briefly
   9.8s  'click'  -> click a button again, deliberately
TXT
echo "starting in 3s..."; sleep 3
./STCSpikeCapture.app/Contents/MacOS/STCSpikeCapture --outdir "$OUT" "$@"
echo; echo "===== run.log ====="; cat "$OUT/run.log"
echo "===== files ====="; ls -la "$OUT"
