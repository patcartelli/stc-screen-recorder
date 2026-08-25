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
| `helper/test/ipc.test.ts` | black-box IPC tests — spawn the binary, drive stdin, assert on fd3/stdout |
| `app/src/helper-client.ts` | promise-based client for the two-channel protocol (fd3 + lossy stdout) |
| `app/src/supervisor.ts` | keeps the helper alive; makes crashes and lost recordings legible |
| `app/src/main.ts` | Electron main — owns the supervisor, spawns the helper as its child |
| `app/build.mjs` | esbuild bundle -> `app/dist/`; `npm run app:start` builds and launches |
| `transform/src/` | the pure transform + shared sink modules (TS; render, time, cursor, demux, decode, compositor) |
| `schema/` | versioned session schemas (anchors-1, events-1, project-1) |
| `fixtures/` | hand-authored 5 s fixture session + deterministic display.mp4 generator |
| `harness/` | vite-served browser harness hosting both sinks |
| `scripts/gate.mjs` | increment-0 determinism gate (Playwright + real Chrome) |
| `tools/test-host/` | signed bundle that spawns the helper for capture tests; `--probe` reports TCC state. **CFBundleIdentifier is load-bearing** — the grant is keyed to it |
| `fixtures/real-session/` | sidecars from a real recording (mp4 omitted, 9.4 MB) pinning click/drag semantics |
| `*.grant.test.ts` | needs a Screen Recording grant — excluded from `npm test`, run via `npm run test:capture`. A separate file, not a skip: skips read as covered and rot |
| `scratch/` | phase-0 spike code and outputs (mp4box.js, harness, sample session dirs) |
| `council/` | cross-AI reviews of the phase-1 plan |

## Build & smoke

```
helper/build.sh                                    # -> helper/build/stc-helper (see Signing)
echo '{"cmd":"status"}' | helper/build/stc-helper  # expect ready -> status -> bye JSON lines
npm test                                           # everything that runs anywhere (must be green)
npm run test:capture                               # the one test needing a Screen Recording grant
npm run test:slow                                  # cross-implementation export identity (minutes)
npm run gate / gate:export / gate:seek / gate:identity
npm run gate                                       # increment-0 sink-identity gate (needs Chrome)
npm run app:start                                  # build + launch the Electron shell
```

## Current status

- **Increment 0 (transform contract):** DONE — schemas, fixture session (incl. generated
  display.mp4 with exact-ns sample table), pure `render()`, both sinks, and the gate all pass:
  200 sampled t byte-identical between sinks, two independent exports identical, encode works
- **Increment 1 (helper control plane):** DONE — lifecycle, watchers, command set, and the
  two-channel IPC (fd3 reliable + seq echo; stdout lossy drop-oldest ring on a dedicated writer
  thread) all built and tested black-box against the real binary. No capture yet.
- **Increment 2 (capture ported in):** DONE and verified on real hardware. An 8 s recording
  produced 458 frames / 865 events / 0 dropped, both sidecars schema-valid, clicks and drags
  correct, and events sharing one time origin with the frame grid. Verified through
  `tools/test-host` (a signed bundle that spawns the helper, so the helper inherits its TCC
  identity — the same arrangement Electron will use, now known to work).
- **Increment 3 (Electron shell):** DONE — `app/src/{helper-client,supervisor,main,preload,renderer}.ts`.
  Client and supervisor are Electron-free and tested against the real helper binary; the shell is
  verified by a Playwright-Electron E2E test that launches the app for real.
- **PHASE 2 IS COMPLETE** — record → preview → export in the app; take library, labelling, delete
  to Trash.
- **Increment 4 (composite + export):** DONE — gate passed on a 60 s real recording (3414 source
  frames -> 3617 CFR output frames, two independent exports byte-identical pre-encode, peak
  buffered 16 frames). `npm run gate:export [sessionDir]` — defaults to the newest take.
  **Visually confirmed** (2026-08-24): cursor present, correctly positioned, in sync with the
  video, click highlight visible, motion smooth. Hashes prove the two sinks AGREE; only watching
  proves the agreed answer is right — a uniformly mispositioned or time-shifted cursor passes
  every automated check in this repo. `node scripts/export-one.mjs <sessionDir> [seconds]` writes
  a watchable file. NB the cursor is a placeholder circle, not the real pointer artwork.
- **Increment 5 (smoke test):** DONE. 5-minute capture (9311 frames, 0 dropped, 0 non-monotonic,
  peak 60.0 fps in the second half — no throttling). Display-change stop (clean, correct
  `stop.reason`, partial mp4 parses and plays). 30 s export from 2:30 into the take watched and
  confirmed: cursor tracking, correct segment, smooth.
- **PHASE 1 IS COMPLETE** — record -> composite -> export, verified end to end on real hardware.
- **The helper can stop itself** — a display change makes it stop cleanly and emit an unsolicited
  `stopped`. Anything holding recording state must reconcile, or it sits there believing a
  recording is live; the supervisor listens for that event and treats the heartbeat's `state` as
  the authority so any desync self-heals.

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
  the capture graph. *(built — `IO.send` reliable, `IO.stat` lossy; capture callbacks use
  `IO.stat` only.)* When fd3 is absent both fall back to blocking stdout so a bare terminal run
  still works; they must never share fd 1 in split mode, or the lossy writer's partial
  non-blocking writes would interleave with reliable lines.
- **Signing:** ad-hoc revokes TCC on every rebuild. The self-signed **"STC Dev Signing"** cert
  (`d9ea4803…`, login keychain) already exists and both the helper and the probe are signed with
  it — *verified* to keep grants across rebuilds (PHASE-1.md → Signing). `find-identity -v` still
  reports 0 identities because it filters on *trust*; that is cosmetic and does not affect signing
  or TCC, and build.sh already falls back to the unfiltered list. **Do not open Keychain Access to
  "fix" it** — on macOS 27.0 it hung hard enough to require a force reset, and the setting buys
  nothing.

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
  *(`LossyChannel` does this. When capture lands, emit stats with `IO.stat`, never `IO.send`.)*
- **A failed `swiftc` leaves the previous binary in place** — `helper/build/stc-helper` is not
  removed on failure, so anything that runs the binary without checking build.sh's exit code
  silently tests stale code. The IPC tests rebuild in `beforeAll` and let a non-zero exit throw.
- **Node's paused child-stdio streams need an explicit `resume()`** — attaching a `data` listener
  to a child's stdout after `pause()` does NOT re-enable reading; the stream silently delivers
  nothing forever. Any test that stalls a consumer to exercise back-pressure must call `resume()`.
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
- **Never block on `SCStream.startCapture`'s completion** — it dispatches to the same
  ScreenCaptureKit queue that delivered `SCShareableContent`'s callback, so a semaphore wait
  there deadlocks against itself and only clears when the timeout fires. This cost a flat 10 s
  on every `start` until it was found; `start` is ~0.2 s once the wait is removed.
- **`display.mp4`'s first sample is NOT at session time zero** — AVAssetWriter records the gap
  between "start received" and "first frame arrived" as an **empty edit** (`media_time: -1`) and
  leaves sample CTS starting at 0. A demuxer that reads only the sample table reports every frame
  early by that gap: measured at 231.7 ms on a real capture, ~14 frames of cursor desync — small
  enough to look like a rendering bug rather than a clock one. `demux.ts` adds the empty-edit
  duration; `fixtures/offset/` is the regression fixture.
- **A no-op rebuild is a vacuous TCC test** — `swiftc` is deterministic and
  `codesign --timestamp=none` adds no entropy, so unchanged source rebuilds to the *same* CDHash.
  Any "did the grant survive a rebuild?" check must confirm the CDHash actually changed first.
- **A bare CLI binary has a different TCC identity than a bundle** — exec'ing it inherits the
  launching terminal's grants (PHASE-0 §6), so terminal-testing the helper proves nothing about
  the shipped app. Permission work needs a bundle launched via `open`. Use `tools/test-host`.
- **`codesign` blocks on a GUI keychain dialog** — signing with "STC Dev Signing" can raise a
  SecurityAgent prompt, and an unattended build then hangs *forever* rather than failing. If a
  build wedges, look for the dialog (and answer "Always Allow", not "Allow"). A `timeout` around
  codesign kills the dialog before a human can find it.
- **`~/.Trash` cannot be enumerated** — macOS refuses `scandir` on it (EPERM) without Full Disk
  Access, for the test runner AND for Electron, while still allowing a targeted `existsSync`. A
  test that lists the Trash silently asserts nothing.
- **`await import()` inside a Playwright `evaluate` is rewritten by vitest** into
  `__vite_ssr_dynamic_import__`, which does not exist in the process the code is shipped to. Use
  `process.getBuiltinModule(...)`.
- **Seeking to a frame's exact PTS can land BEFORE it** — `seek()` floors time to a 120 Hz tick,
  and the floor of a first frame at 209.1 ms is 208.33 ms, where frame selection correctly reports
  "nothing yet" and paints black. Round up: `PreviewPlayer.firstRenderableNs`.
- **A custom protocol cannot be fetched from a `file://` window** — Chromium blocks cross-origin
  fetches from a file origin to any non-http scheme, so `protocol.handle` is useless unless the
  app itself is served over a custom scheme. The preview passes bytes over IPC instead, which also
  means the renderer never names a path.
- **mp4box reports a malformed file by never calling back** — no `onReady`, no `onError`, so a
  promise wrapping it never settles and the caller waits forever with no error and no stack.
  `demux.ts` checks `sawReady` after the synchronous parse and carries a watchdog. Any callback
  API wrapped in a promise needs the same question asked: what happens when it stays silent?
- **`performance.memory.usedJSHeapSize` does not count ArrayBuffers** — they live outside V8's
  heap, so a 458 MB buffer can read as "0 MB heap growth". Measure renderer RSS via
  `app.getAppMetrics()` instead; anything else quietly measures nothing.
- **Preview holds the whole video in memory** — measured 458 MB file → +548 MB renderer RSS
  (chunked; it was +862 MB read in one message). Roughly 1.2x the file, so a ~15-minute 4K take is
  the practical ceiling before the renderer is in trouble.
- **Tests must not depend on `~/Desktop/stc`** — four E2E files used to reach for "whatever real
  recording is there". That broke the moment those takes were deleted and CI could never have run
  them. `app/test/_take-fixture.ts` copies the committed `fixtures/basic` session instead; the
  GATES still default to a real take, which is where 4K behaviour gets exercised.
- **Every wait needs a bound and a reason** — the rule this codebase kept re-learning. Five hangs
  in one day traced to promises settled only by someone else's callback: mp4box, `VideoDecoder`,
  `VideoEncoder`, `AVAssetWriter` and `SCStream` all signal trouble by never calling back. Wrap
  them in `withTimeout(p, ms, what)` from `transform/src/timeout.ts`; `what` becomes the error
  message. Two waits are deliberately unbounded and say so in comments — the lossy writer thread
  idling on its condition, and the event tap's `CFRunLoopRun` — because nothing is waiting on them.
- **A `VideoDecoder` can swallow input and emit nothing** — it buffers before its first output,
  so waiting for output when the queue has drained deadlocks on a perfectly healthy decoder. Feed
  more, flush only when there is nothing left to feed, and never wait unbounded. Related: flushing
  mid-stream to force output leaves it demanding a keyframe (`a key frame is required after
  configure() or flush()`), which breaks the next forward continue.
- **A stray `~/node_modules` hijacks module resolution** — the home directory holds a broken pnpm
  tree (rollup missing its native binary, esbuild built for x64 on an arm64 machine). Anything not
  installed *locally* may resolve there and fail bizarrely. Install tools as project devDeps.
- **Recordings go to `~/Desktop/stc/<timestamp>/`, never a temp dir** — `os.tmpdir()` on macOS is
  `/var/folders/.../T`, purged on boot and swept after ~3 days. A take is a deliverable, not
  scratch. `STC_RECORDINGS_DIR` overrides it (the E2E suite sets it so runs never touch the Desktop).
- **`-3805 "application connection being interrupted"` usually means OUR OWN app is still running**
  — a leftover `electron .` (or any second SCStream from this project) holds the display and every
  new capture fails this way. It reads like a permission or entitlement problem and is not one:
  with the stray app gone, the same helper immediately reports the honest `no-displays` instead.
  Check `ps -Ao pid,command | grep stc-screen-recorder` before debugging anything else.
- **`SCStream` can fail through `didStopWithError` INSTEAD of `startCapture`'s completion** — seen
  as `-3805 "application connection being interrupted"`. Wiring only the completion left `start`
  permanently unanswered. Every request path must resolve exactly once: the delegate answers a
  pending start, and a 15 s backstop answers if neither fires.
- **An empty events.json does not mean the tap is broken** — an automated capture records zero
  events simply because nothing moves the mouse, which is indistinguishable from a dead button
  path. Verifying input needs deliberate input; `fixtures/real-session/` pins the result.
