# stc-screen-recorder — Claude Code handoff

macOS screen recorder. Electron UI + Swift helper. Captures display + cursor
events → deterministic transform → CFR MP4 with cursor overlay.

## Where things are

| path | what |
|---|---|
| `PHASE-1.md` | current phase plan — read this first |
| `docs/PHASE-0-FINDINGS.md` | spike results; all settled decisions sourced here |
| `helper/src/` | Swift helper (increment 1, in progress) |
| `helper/src/Protocol.swift` | JSON-line IPC + Clock |
| `helper/src/Watchers.swift` | display/device watchers |
| `helper/src/main.swift` | App lifecycle, command dispatch |
| `helper/build.sh` | builds and signs; `SIGN_ID="..." ./build.sh` to override |
| `app/src/` | Electron app (not yet started) |
| `transform/src/` | the pure transform + shared sink modules (TS; render, time, cursor, demux, decode, compositor) |
| `schema/` | versioned session schemas (anchors-1, events-1, project-1) |
| `fixtures/` | hand-authored 5 s fixture session + deterministic display.mp4 generator |
| `harness/` | vite-served browser harness hosting both sinks |
| `scripts/gate.mjs` | increment-0 determinism gate (Playwright + real Chrome) |
| `scratch/` | phase-0 spike code and outputs (mp4box.js, harness, sample session dirs) |
| `council/` | cross-AI reviews of the phase-1 plan |

## Build & smoke

```
helper/build.sh                                    # -> helper/build/stc-helper (see Signing)
echo '{"cmd":"status"}' | helper/build/stc-helper  # expect ready -> status -> bye JSON lines
npm test                                           # transform unit tests (vitest)
npm run gate                                       # increment-0 sink-identity gate (needs Chrome)
```

## Current status

- **Increment 0 (transform contract):** DONE — schemas, fixture session (incl. generated
  display.mp4 with exact-ns sample table), pure `render()`, both sinks, and the gate all pass:
  200 sampled t byte-identical between sinks, two independent exports identical, encode works
- **Increment 1 (helper control plane):** IN PROGRESS — lifecycle, watchers, and the command set
  are done; no capture yet. **The IPC as coded is a single blocking stdout channel** (`IO.emit`:
  one lock, unbuffered blocking writes) — the lossy/reliable split, fd3, sequence numbers, and
  the bounded ring buffer described under Settled decisions are NOT built. They are prerequisites
  for increment 2, where capture callbacks would otherwise block on that pipe.

**Critical ordering rule:** the transform defines the schemas; the helper is a producer to spec.
Increment 0's `events.json` / `anchors.json` / `project` schemas must exist before increment 1
ships; the helper must emit to them before increment 2 ships. (Increment 1 has no capture and
writes none of these files — the schema gate is on it existing, not on the helper using it yet.)

## The non-negotiable

`render(project, events, t) → FrameState` is a pure function — no wall clock, no decoder
scheduling, no live helper stats, no current display state. Preview and export are two sinks
that call it with different `t` sequences. One implementation; sinks may not fork the transform.

## Settled decisions (do not relitigate)

See `PHASE-1.md` → "Settled by phase 0" for the full table. The ones most likely to matter:

- **Frame selection:** at time `t`, use the source frame with the greatest PTS ≤ `t`; hold,
  never interpolate. Same rule in both sinks — never "latest decoded frame."
- **Simulation step:** 120 Hz (`dt = 1/120 s`); 60 fps export samples every other tick. All
  times are integer nanoseconds or integer sim ticks — no float seconds inside the transform.
- **Cursor state:** function of sim tick `n = floor(t_ns × 120 / 1_000_000_000)`, not render
  call count. `stateAt(n)` must be identical whether reached by stepping or seeking.
- **Clock:** `mach_timebase_info()` at helper startup; numer/denom written into `anchors.json`.
  `displayTimeNs = displayTime × numer / denom` (41.667 ns/tick here, but read it, don't assume).
  `CGEvent.timestamp` is already nanoseconds — do not convert. `displayTime` is the *scheduled
  VBL presentation time* — SCK delivers the frame ~7 ms before it. It is when the pixels hit the
  glass, not when the frame was captured; treat it as such in frame selection.
- **Capture resolution: ≤3840×2160, H.264.** Hardware encode falls off a cliff immediately above
  4K (0.81 → 0.25 Gpx/s, software fallback) — and this machine's own display is 6016×3384.
  Chrome's H.264 *decoder* shares the ceiling, so 4K caps both sides of the pipeline.
- **Capture:** VFR at capture, CFR at export. Hardware encode only (`prefer-hardware`);
  `prefer-software` truncated at 19% of frames at 4K60 — it is not a fallback.
- **IPC:** stdout = lossy/non-blocking stats (drop-oldest, never block capture callbacks);
  stdin + fd3 = reliable request/response with sequence numbers. Never let stats back-pressure
  the capture graph.
- **Signing:** ad-hoc revokes TCC on every rebuild, and this machine currently has **zero**
  code-signing identities — every build today is ad-hoc. A self-signed cert in the login keychain
  is needed before increment 2; run both experiments in PHASE-1.md → Signing before capture work
  starts. Gotcha: `security find-identity -v` filters on *trust*, so a fresh self-signed cert
  won't appear until its trust is set to "Code Signing" — it signs fine regardless (build.sh
  already falls back to the unfiltered list).

## Increment 0 — what to build next

1. Write `events.json`, `anchors.json`, and `project` schemas (versioned; `project` holds
   PiP geometry, cursor style, output fps — the edit document, even if it's 3 fields for now).
2. Hand-author a 5-second fixture session (no capture) containing cursor motion that exercises
   easing across VFR grid boundaries.
3. Implement `render(project, events, t)` against the fixture — no WebCodecs or DOM dependencies.
4. Wire two sinks: canvas preview + WebCodecs encode (demux via mp4box.js).
5. Gate: for 200 sampled `t`, the pre-encode RGBA buffer from each sink is byte-identical.
   Two independent exports produce matching pre-encode hashes. Encoded MP4s need not be
   byte-identical (container timestamps and encoder state are not contractually deterministic).

## Phase 1 scope (sprint)

Display capture + cursor events only. No camera, mic, system audio, display hot-swap rebuild,
segmentation, or fault-injection soak. See `PHASE-1.md` → Non-goals for the explicit deferred list.

`AVAssetWriter` cannot change output dimensions mid-file — a display resolution change must stop
the recording cleanly, not rebuild mid-stream (phase 2 concern).

## Toolchain

No Xcode.app — `swiftc` 5.8 with the MacOSX13.3 SDK (Command Line Tools) on macOS 27. SwiftPM
cannot resolve without full Xcode, so **build with `helper/build.sh`, not `swift build`**
(`Package.swift` is kept for when Xcode lands). macOS 14+ SCK API (`SCContentSharingPicker`, HDR,
`SCScreenshotManager`) is out of reach; `captureResolution` is absent from the 13.3 headers but
reachable via KVC (`setValue(3, forKey: "captureResolution")`, verified in phase 0).

## Correctness traps to watch for

- **Byte-identical MP4 is not the gate** — muxer timestamps and encoder state differ between
  runs. Hash pre-encode RGBA buffers, not container output.
- **Stats on stdout can block capture** — all stats writes must go through a bounded ring buffer
  on a dedicated writer thread with non-blocking fd; no capture callback may touch the pipe.
- **`stateAt(n)` seek cost** — at 120 Hz, 30 min = 216k ticks. If seek is implemented as
  "step from tick 0," a 60 fps export of a long recording is quadratic. Plan checkpoints.
- **`AVAssetWriter` dimension rigidity** — see above; display hot-swap is a stop, not a rebuild.
- **WebCodecs demux** — WebCodecs accepts `EncodedVideoChunk`, not MP4. mp4box.js (already in
  `scratch/`) is the demuxer. `VideoDecoder` is async; the sink needs a pre-decoded frame cache,
  not synchronous decoder calls inside `render()`.
- **WebCodecs tab-killers** (all three crashed the spike harness — PHASE-0 §4b): (1) drive a
  `VideoDecoder` with exactly **one in-flight request** — any scrub/seek UI needs a coalescing
  queue keeping only the latest requested frame; (2) close `VideoFrame`s in the output callback,
  never buffer them (~30 MB each at 6K); (3) mp4box.js exposes `DataStream` as a **browser
  global**, not `MP4Box.DataStream` — the latter throws inside the demux promise executor and the
  `await` hangs forever with no error.
- **mach timebase** — 41.667 ns/tick on this machine; Intel is 1/1. Always `mach_timebase_info()`.
