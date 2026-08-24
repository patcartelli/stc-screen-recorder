#!/bin/bash
# Gate 5: revoke every grant for this bundle id, so the re-grant path can be exercised.
B=com.studiocartelli.stcspikecapture
for s in ScreenCapture ListenEvent Camera Microphone; do
  echo -n "$s: "; tccutil reset $s $B 2>&1
done
