# Camera PiP (STC-232) — design

**Status:** approved 2026-08-26. Phase 3.
**Ticket:** STC-232. Deferred from phase 1 and phase 2 unchanged.

## Goal

Record the camera alongside the display and composite it as a fixed-corner
picture-in-picture, visible identically in preview and export.

Fixed geometry is the whole of this phase. User-adjustable position and size is
a follow-on: the geometry lives in the project document from day one, so that
phase adds UI rather than a schema migration.

### Non-goals

Microphone, system audio, multiple cameras, camera-only recording, crop/zoom,
background replacement, and any adjustable PiP geometry UI. Phase 1's other
deferrals (display hot-swap rebuild, segmentation) stay deferred.

## Settled inputs from phase 0

These were measured, not assumed. They are the reason several decisions below
are cheap, and getting any of them wrong desyncs the PiP silently.

| fact | value | consequence |
|---|---|---|
| camera PTS clock | mach host time, already latency-compensated (91.5 ms in the past; 115.8 ms on a second run) | session-relative ns is `pts_ns - t0Ns`. **No timebase conversion**, same as `CGEvent.timestamp` |
| camera warm-up | first camera frame lands **+1035.5 ms** after the first screen frame | every take has a window with no camera frame at all |
| camera rate | ~58.8 fps against a 60 Hz export grid | the two tracks are continuously out of phase; frame selection must be per-track |
| CoreAudio wedge (§2a) | caused by force-killing a process holding a **Bluetooth audio device** | camera-only avoids it; it was never a camera problem |
| optional subsystems | camera/mic setup previously blocked startup | camera must not sit on the critical path |

## Decisions

| decision | rationale |
|---|---|
| Fixed-corner PiP, end to end | A vertical slice that can be watched and judged, matching how phases 1 and 2 were run. Adjustable geometry is the follow-on |
| Camera captured at **1280x720** | A corner PiP on a 4K canvas is ~480x270, so 720p is ~2.7x oversampled — enough to enlarge or reframe later without re-recording, while adding ~10-15% to preview RAM rather than doubling it (STC-251) |
| No PiP until the first camera frame | Falls straight out of the settled "greatest PTS <= t, hold, never interpolate" rule; needs no special case. Cost is a visible pop-in ~1 s into every take, accepted |
| Camera is opt-in: toggle, default off, sticky | The camera LED is physical and the TCC prompt should appear at a moment the user caused. The device opens on start and closes on stop — never held while idle |
| Second writer inside the existing helper | The shared mach clock is free this way. A separate process would buy isolation not yet shown to be needed, and would duplicate the writer-teardown race fixed in STC-254 |
| `getUserMedia` in the renderer rejected | Renderer media clocks are not the mach host clock, so alignment becomes a fitted correction. That breaks the single-time-origin property the transform rests on |

## Architecture

### Capture — `helper/src/CameraCapture.swift`

`AVCaptureSession` with an `AVCaptureVideoDataOutput` on its own queue
(`stc.capture.camera`), feeding a second `AVAssetWriter` -> `camera.mp4`.
Writer settings mirror the display writer: H.264, hardware encode,
`movieTimeScale` 90 kHz, `mediaTimeScale` 1 ns, no frame reordering.

- `start` gains `camera: bool`. When false, no device is opened.
- Device open and session setup run off the start path. A slow or missing
  camera delays nothing.
- The camera writer gets **its own `WriterGate`**. The gate is already
  per-writer, so this is instantiation, not new concurrency design — without
  it, a second writer is a second copy of the STC-254 race.

### Session artifacts

`camera.mp4` beside `display.mp4`. `anchors.json` gains a `camera` block:

- `present` — false when no camera was requested or none was available
- `device` — human-readable device name
- `width`, `height`
- `firstFramePtsNs`, `lastFramePtsNs` — session-relative

**The empty-edit trap applies per track**, and is worse here: the camera's
start gap is ~1035 ms against the display's measured 231.7 ms. `demux.ts`
already adds the empty-edit duration; this phase applies it per track and adds
a camera sibling to `fixtures/offset/` so it is pinned rather than assumed.

### Schema — `project-2`

`project-1` gains an optional `pip` object and becomes `project-2`. Absent
means no PiP, so every existing v1 project stays readable.

```
pip: {
  enabled: boolean,
  corner:  "bottom-right",        // only value in this phase
  widthPct: number,               // fraction of canvas width; 0.25
  marginPx: integer
}
```

Geometry is data from day one even though nothing edits it yet.

### Transform

One rule, and it is the rule that already exists: for the camera track, take
the frame with greatest PTS <= `t`, hold, never interpolate — applied
**independently per track**, since the tracks run at different rates.

**Track end is not a gap.** "Hold" is correct for gaps within a track and wrong
at the end of one: if the camera dies 30 s into a 60 s take, holding freezes the
PiP on the last frame for 30 s — a frozen human, which reads as a rendering bug
and is worse than nothing. The PiP is therefore drawn only while
`firstFramePtsNs <= t <= trackEnd`, where `trackEnd` derives from
`lastFramePtsNs` plus one nominal frame interval. Both bounds come from the
data, not from code.

Composite order is **display -> PiP -> cursor**, so the pointer stays visible
where it crosses the PiP.

### Sinks

Both sinks gain a second demux+decode using the existing `demux.ts` /
`decode.ts`, one instance per track.

**One in-flight decode request per decoder.** PHASE-0 §4b's rule is per
decoder, not per app, and two decoders is exactly where it gets violated by
accident. `VideoFrame`s continue to be closed in the output callback, never
buffered.

## Failure handling

| case | behaviour |
|---|---|
| No camera / permission denied / device busy | Recording proceeds display-only. Helper emits a `warning`; `anchors.camera.present` is false. `start` still succeeds |
| Camera unplugged mid-recording | `Watchers.swift` already observes AV device notifications: close the camera writer cleanly, finalise `camera.mp4`, keep recording the display. The PiP ends at `trackEnd` |
| Camera-side crash | Takes the helper, and therefore the display take, with it. This is the accepted cost of the shared-process design; mitigated by keeping camera code off the fatal path, and by the STC-254 crash handler naming what happened |

## The Camera TCC grant

Camera is a **separate grant** from Screen Recording with the same load-bearing
property: it is keyed to the bundle identifier, and the helper — a bare CLI
binary — inherits the grant of whichever bundle launched it.

- Both the Electron app and `tools/test-host` need `NSCameraUsageDescription`
  in `Info.plist`. Without it the prompt never appears and access fails
  silently, which reads exactly like a broken device.
- `tools/test-host --probe` extends to report camera TCC state alongside screen.
- Camera capture is tested in `helper/test/camera.grant.test.ts`, excluded from
  `npm test` — a separate file, not a skip, per the repo rule that skips read as
  covered and rot.

## Testing

- **Pure, no capture:** camera frame-selection and track-end rules against a
  hand-authored fixture, the way `CaptureDecisions` is tested.
- **Concurrency:** covered by the existing `WriterGate` harness.
- **Grant-gated:** `camera.grant.test.ts` — a real recording producing a
  schema-valid `camera.mp4` and `anchors.camera`.
- **Determinism gate:** extended to a PiP session — 200 sampled `t`,
  both sinks byte-identical, camera track present.

Two things automation cannot establish, both learned the hard way here:

1. **Hashes prove the sinks agree, not that they are right.** A uniformly
   mispositioned or time-shifted PiP passes every automated check in this repo —
   the identical trap as the cursor. An explicit watch-and-confirm step via
   `scripts/export-one.mjs` is part of the phase, not optional polish.
2. **Sync should be measured, not eyeballed.** Phase 0 already built `cammotion`
   and `avsync.cjs` for this and they sit in `scratch/`. Reuse them to produce a
   camera-to-display alignment *number*.

## Increments

Ordered to respect the critical ordering rule — the transform defines the
schemas; the helper is a producer to spec.

1. **Camera grant proven** through `test-host --probe`. No capture code. Tiny
   and deliberately first: if the grant cannot be made to work through the
   bundle, everything after it is wasted work, and that should surface on day
   one rather than at increment 5.
2. **`project-2` schema + transform PiP and track-end rules**, against a
   hand-authored fixture. No capture, no camera.
3. **Helper camera capture** -> `camera.mp4` + `anchors.camera`, emitting to the
   schema increment 2 defined.
4. **Both sinks + determinism gate** extended for PiP.
5. **App toggle (sticky) + watch-and-confirm** on a real take, with a measured
   sync number.

## Open risks

- **Preview memory.** A 720p camera track adds ~10-15% to renderer RSS on top of
  the display track, moving STC-251's ~15-minute 4K ceiling down somewhat. Not
  measured yet; increment 4 should measure rather than estimate.
- **Hardware encode contention.** Two simultaneous H.264 hardware encodes have
  not been measured on this machine. Phase 0 measured the display encoder alone
  falling off a cliff above 4K. 720p is small, but "small" is an assumption
  until increment 3 measures it under a real 4K60 display capture.
- **Camera rate variation.** Latency was measured at 91.5 ms and 115.8 ms on two
  runs of the same hardware. Alignment must be driven by per-frame PTS, never by
  an assumed constant offset.
