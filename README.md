# stc-screen-recorder

A macOS screen recorder built on one rule: **the recording is data, and every decision about how it
looks is made afterwards by a pure function.** The helper captures pixels, cursor events and camera
frames on one clock. The cursor is never in the pixels. Preview and export are two callers of the same
`render(project, session, t)`, and a gate proves they agree byte for byte before the encoder.

> Demo: *[the phase-3 recording goes here — see STC-302]*

## The route

```
Swift helper (ScreenCaptureKit + CGEventTap + AVFoundation)
    display.mp4 (VFR, cursor excluded)   events.json (cursor, ns)   camera.mp4   anchors.json (clock, geometry)
        │
        ▼   one mach clock; every time is session-relative integer nanoseconds
Electron main (owns paths, preferences, the helper process)
        │   bytes over IPC, never a path
        ▼
Renderer: render(project, session, t) → FrameState → composite()
        ├── preview sink: seeking decoder, wall clock chooses the next t
        └── export sink:  forward decoder, 60 fps grid, WebCodecs → CFR MP4
```

`project.json` is the edit document: output size, cursor style, PiP geometry, trim. Change it and
re-render; the source media is never touched.

## Why the cursor is excluded at capture

Capturing the pointer into the pixels fixes its size, style and timing forever, and makes it
impossible to smooth, enlarge, hide, or later drive an auto-zoom from clicks. So the display is
captured with `showsCursor = false` and the cursor is recorded as an event stream on the same clock
(`CGEvent.timestamp` is already nanoseconds; `displayTime` is mach ticks and is converted). The
transform draws the pointer from those events at render time — as real macOS pointer artwork, with
a critically damped spring stepped at 120 Hz so that the state at any tick is the same whether you
stepped to it or sought to it.

## Why render-time transforms

Because two implementations of "what does this frame look like" will disagree, and the user finds
out after exporting. There is one `render()`, one `composite()`, and preview and export are sinks
that differ only in where decoded frames come from. `npm run gate:identity` samples the take in
shuffled order through the preview path and in ascending order through the export path and requires
0 mismatches in the pre-encode RGBA. The encoded bytes are never compared; muxer timestamps and
encoder state are not contractually deterministic and the gate lives before them.

## Locked decisions

The full table, each with its status against the code, is `docs/BRIEF.md`. The ones most likely to
matter when reading the source:

- **Frame selection:** at time `t`, the source frame with the greatest PTS ≤ `t`; hold, never
  interpolate; per track.
- **Simulation step:** 120 Hz, integer nanoseconds and integer ticks inside the transform; 60 fps
  export samples every other tick.
- **Capture:** ≤ 3840×2160 H.264, hardware encode only (above 4K the encoder falls off a cliff,
  measured), VFR at capture and CFR at export.
- **Two IPC channels:** fd3 reliable with sequence numbers for requests; stdout lossy, drop-oldest,
  for telemetry, on its own writer thread — stats can never back-pressure the capture graph, and
  that is measured, not assumed.
- **Every wait has a bound and a reason.** Every media API in this project signals trouble by never
  calling back.
- **Reported, never silently skipped.** Broken takes are listed with a reason; a dropped stat is
  counted; a gate that could not run says so in the CI log rather than passing.

## Build and run

Needs macOS, the Xcode Command Line Tools (`swiftc`), Node 24, and a Screen Recording grant for the
app. No Xcode.app is required; `helper/build.sh` drives `swiftc` directly and signs with whatever
identity the keychain offers (a self-signed cert keeps TCC grants across rebuilds; ad-hoc revokes
them on every build).

```
npm ci
helper/build.sh          # -> helper/build/stc-helper
npm run typecheck        # three tsc passes; a bare `tsc` runs one
npm test                 # everything that runs without a grant or Chrome
npm run app:start        # build the shell and launch it
npm run gate             # determinism gate, needs real Chrome (H.264)
```

Recordings go to `~/Desktop/stc/<timestamp>/`. `STC_RECORDINGS_DIR` overrides it.

## Status

Phases 0–3 are complete: record, preview, trim, export, camera picture-in-picture, real cursor
artwork, all verified on hardware. `CLAUDE.md` is the running handoff log and the index of every trap
found so far; `PHASE-1.md` and `PHASE-2.md` are the phase plans as shipped;
`docs/review-2026-09-02.md` is the most recent whole-codebase review, with what is next in order.

## Licence

*[not yet chosen — STC-302]*
