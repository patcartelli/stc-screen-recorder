#!/bin/bash
# Run one 12s capture. Follow the spoken cues.
cd "$(dirname "$0")"
OUT="$PWD/out"; mkdir -p "$OUT"; rm -f "$OUT/run.log"
echo "Launching. Cues will be SPOKEN:"
echo "   1.5s  'click'  → click a Finder toolbar button, deliberately"
echo "   4.2s  'clap'   → clap ON CAMERA while clicking at the same instant"
echo "   7.0s  'drag'   → drag a window briefly"
echo "   9.8s  'click'  → click a button again, deliberately"
echo
open -a "$PWD/STCSpikeCapture.app" --args --outdir "$OUT"
for i in $(seq 1 40); do pgrep -q -f STCSpikeCapture && break; sleep 0.5; done
while pgrep -q -f STCSpikeCapture; do sleep 0.5; done
sleep 1
echo "===== run.log ====="; cat "$OUT/run.log"
echo "===== files ====="; ls -la "$OUT"
