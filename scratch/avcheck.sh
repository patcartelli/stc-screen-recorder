#!/bin/bash
# Camera <-> mic alignment from a clap. Run after a take with 3-4 deliberate claps on camera.
cd "$(dirname "$0")"
OUT="${1:-$PWD/out}"
./cammotion "$OUT" || exit 1
echo
node avsync.cjs "$OUT"
