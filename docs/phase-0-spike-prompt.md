# Phase 0 spike — STC Screen Recorder

**Paste this whole document into Claude Code as the task.**

## What this is

A throwaway spike for a macOS screen recorder (working name: STC Screen Recorder). Nothing built here ships — the code will be deleted. The spike exists to answer five questions about timing, performance, and permissions on THIS machine before any architecture is committed. Optimize for answering the questions, not for code quality.

Work in `~/dev/stc-screen-recorder/scratch/` (it exists — this is the project's future home; `scratch/` is the gitignored-tier part). Do not create a git repo, do not add tests, do not build abstractions. Two programs and a findings file.

**Machine context:** Apple Silicon MacBook running current macOS (26.x), possibly with an external 4K display. Xcode command line tools assumed; verify `swiftc --version` first and stop with instructions if missing.

## The questions

1. **Cursor↔screen time alignment.** ScreenCaptureKit frames carry `SCStreamFrameInfo.displayTime` (mach absolute time units — convert via `mach_timebase_info`). `CGEvent.timestamp` is documented as nanoseconds since boot. Do NOT assume the relationship — measure it. The spike's job is to produce the exact conversion formula and its residual error in ms.
2. **Camera/mic↔screen alignment.** Camera and mic recorded via AVFoundation in the same process: do their sample-buffer presentation timestamps live on the same host clock as the screen frames, and what anchor offsets make the tracks line up?
3. **Can Chromium decode + draw 4K60 at speed?** (WebCodecs `VideoDecoder` → canvas, not a `<video>` element.)
4. **Can Chromium encode 4K in reasonable time?** (WebCodecs `VideoEncoder`, `hardwareAcceleration: "prefer-hardware"`.)
5. **Do the permission flows survive grant → revoke → re-grant without wedging?**

## Program 1 — `spike-capture` (Swift, one SwiftPM executable or a single `main.swift` + `swiftc`)

Records ~12 seconds, writing into an output directory:

- **`display.mp4`** — ScreenCaptureKit capture of the main display at native pixel dimensions (`SCDisplay.width/height × backing scale`, `SCCaptureResolutionType.best`), 60 fps target (`minimumFrameInterval = 1/60`), **`showsCursor = false`**, `queueDepth ≥ 6`. Encode via `AVAssetWriter` (H.264, `AVVideoAverageBitRateKey` ~50 Mbps, keyframe interval ~45 frames). SCK is change-driven: on `.idle`/`.blank` frame status, repeat the last frame to keep CFR. Record per-frame: `displayTime` attachment → write a JSON sidecar `display-frames.json` of `{frameIndex, displayTimeRaw, displayTimeNs}`.
- **`camera.mp4` + `mic.m4a`** — `AVCaptureSession` (default camera 1080p, default mic) in the SAME process, written with `AVAssetWriter`s. Log the presentation timestamp (`CMSampleBufferGetPresentationTimeStamp`) of the FIRST sample of each into `anchors.json`, alongside the first display frame's `displayTime` and a `mach_absolute_time()` + `Date()` pair taken at start.
- **`events.json`** — a `CGEventTap` (`.cgSessionEventTap`, `.listenOnly`) capturing `mouseMoved`, `leftMouseDown/Up/Dragged` at full rate: `{tNs: event.timestamp, x, y, type}`. Coordinates from `event.location` (global display coords — also record the display's frame so they can be normalized). Handle `tapDisabledByTimeout` by re-enabling. Do no work in the callback beyond appending to a preallocated buffer.
- Timebase: record `mach_timebase_info` numer/denom in `anchors.json`.

Practical notes, all known issues — don't rediscover them the hard way:
- Screen Recording TCC will attribute the grant to the **terminal** running the process (responsible-process rule). Expect to grant Screen Recording and Input Monitoring to Terminal/iTerm/whatever runs `swift run`. This is normal in dev; note which apps got granted in the findings.
- `CGPreflightScreenCaptureAccess()` can lie. Validate by calling `SCShareableContent` (async, with a ~4 s timeout) and checking displays come back. If it hangs, note it — that's a finding, not a failure.
- After a TCC grant, macOS may require relaunching the process before capture works. Expect one odd run.
- Wrap SCK/AVFoundation calls made off the main thread in autorelease pools; don't block the main run loop waiting on `SCShareableContent`'s completion.

**Recording procedure** (print instructions to the operator at launch): during the 12 seconds — (a) click a few visibly-reacting UI targets (e.g. Finder toolbar buttons) near the START and near the END of the window, deliberately, with pauses; (b) clap once ON CAMERA while simultaneously clicking; (c) drag a window briefly.

## Program 2 — `harness.html` (single self-contained HTML file, open in Chrome)

Loads the output directory's files (`<input type="file" multiple>` is fine). Three panels:

1. **Alignment viewer.** Demux `display.mp4` (mp4box.js or mediabunny from CDN — the harness is throwaway, CDN is fine here), decode with **`VideoDecoder`** (never a `<video>` element — that's the pipeline being proven), draw frames to a canvas with a crosshair dot at the interpolated cursor position for that frame's timestamp, using a candidate conversion between `CGEvent.timestamp` ns and `displayTime` ns. Provide a **slider for a global offset in ms** (±200 ms range, 1 ms steps) and frame-step keys (←/→). The operator visually finds the offset where the dot sits exactly on the clicked buttons at both the start and end clicks. **Report: the offset value, and whether start-click and end-click need different offsets (drift).**
2. **A/V alignment.** Decode `camera.mp4` alongside; a click-to-audio scrubber over `mic.m4a` (decode via `AudioContext.decodeAudioData`, render the waveform, mark the clap transient). Using `anchors.json`, compute where the clap lands on the display timeline vs. the click event's timestamp. **Report: clap-to-click delta in ms and in frames at 60 fps.**
3. **Performance.** (a) Play the decoded display track at speed to canvas for its full duration; count delivered frames vs. wall clock → effective fps. (b) Re-encode 10 s: canvas → `new VideoFrame(canvas)` → `VideoEncoder` (avc, `prefer-hardware`, bitrate ~40 Mbps, backpressure on `encodeQueueSize`) → mux to MP4 (mediabunny) → download. Never call `getImageData`/`readPixels`. **Report: decode fps, encode wall-clock for 10 s, output file plays in QuickTime.**

## The gates (all measured, written to `FINDINGS.md`)

| # | Gate | Pass |
|---|---|---|
| 1 | Cursor dot sits on clicked targets at start AND end of clip with one constant offset | offset stable within ±1 frame (16.7 ms), no drift |
| 2 | Camera clap ↔ click event | within ±1 frame at 60 fps |
| 3 | 4K decode→canvas playback | ≥ 60 fps sustained |
| 4 | 10 s 4K export | < 30 s wall clock, file plays in QuickTime + Chrome |
| 5 | Permissions: grant → revoke (System Settings) → re-grant, relaunching as needed | reaches recording state each time; failures are clear, not hangs; no zombie state requiring reboot |

`FINDINGS.md` must contain: the conversion formula (with `mach_timebase_info` values), the measured offset and drift, clap delta, decode fps, encode time, display pixel dimensions captured, which apps hold the TCC grants, and anything surprising. Numbers, not adjectives.

## If a gate fails

Do not fix-and-hide. Record the failure with numbers and stop for discussion:
- Gate 1–2 failure (misalignment/drift) → the clock model is wrong; that's a design conversation, not a patch.
- Gate 3–4 failure → try the other `hardwareAcceleration` setting once, record both numbers, stop.
- Gate 5 failure → document the exact wedge state and how you escaped it.

The spike passing = the Electron + Swift-helper route is confirmed and phase 1 starts. The spike failing = we saved months. Both outcomes are wins; only ambiguity is a loss.
