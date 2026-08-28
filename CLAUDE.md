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

## Where things stand (2026-08-26)

**Phases 0, 1 and 2 are complete.** The app records, previews and exports, verified on real
hardware and confirmed by eye on the composited cursor. 137 tests, four gates.

CI on `master` went red on 2026-08-25 (the `#6` and `#7` merges) with the STC-254 crash —
intermittent, so PR runs passed while the push runs failed. Root-caused and fixed on 2026-08-26;
master is green again. See the append/teardown trap below. **Do not read a green PR run as proof
for an intermittent fault** — the regression test is the evidence, the green tick is corroboration.

Repo: https://github.com/patcartelli/stc-screen-recorder — **public** (unlimited Actions minutes;
macOS bills 10x on private repos and burned ~42% of a monthly allowance in one day).

### Workflow — master is protected

`master` requires the `test` check and enforces it on admins, so **direct pushes are blocked**.
Everything goes through a PR:

```
git checkout -b accounts/stc-NNN-slug
# work, commit
git push -u origin HEAD
gh pr create --base master
npm run merge -- <pr>      # merges ONLY if that PR's CI is green
```

Use `npm run merge`, not `gh pr merge --auto` — see the trap below about why `--auto` was useless
here (it is now backed by a required check, but the script also refuses to read a green result
belonging to a different commit).

### Next up

| ticket | what | needs |
|---|---|---|
| STC-232 4b | **done and VISUALLY CONFIRMED 2026-08-28** — both sinks draw the PiP, gate proves it, app opens camera takes, and a human watched a real 4K take. Increment 5 is unblocked | nothing; increment 5 is next |
| STC-259 | **cause confirmed and contained** — both encoder queries bounded at 15 s, run retried 3x, then a loud SKIP. Measured on CI both ways on one commit | steps 2 and 3: the harness's first `AVAssetWriter` append is still unbounded, and whether `CameraCapture.swift`/`Capture.swift` need the same is still open |
| STC-249 | lossy ring under REAL capture load — the semantics are tested, the live scenario is not | a recording with a stalled stats consumer |
| STC-254 | **done** — append/teardown race fixed (part 2), SIGTRAP crash handler closed (part 3). Master CI green again | nothing; watch that master stays green |
| STC-232 | phase 3: camera PiP — recommended first, it avoids §2a's CoreAudio wedge entirely | a scope decision |
| STC-247 | multi-display capture | a second display |
| STC-251/252 | preview memory ceiling (~15 min at 4K); Node 20 actions deprecation | — |

`PHASE-2.md` records the measured limits (export 1.52x realtime, preview ~1.2x file size in RAM).

### Open PR from another agent

`#3 STC-241: in-app trim before export` — a separate agent, working in the linked worktree at
`../stc-screen-recorder-stc-241`. Untouched by this session. It overlaps `transform/src/export.ts`
and the app UI; git reports no textual conflict, but `test:slow` (UI vs CLI export identity) is the
gate that would catch a semantic one, and it does not run in CI.

## Build & smoke

```
helper/build.sh                                    # -> helper/build/stc-helper (see Signing)
echo '{"cmd":"status"}' | helper/build/stc-helper  # expect ready -> status -> bye JSON lines
npm run typecheck                                  # ALL THREE tsc passes — bare `tsc` runs one
npm test                                           # everything that runs anywhere (must be green)
npm run test:capture                               # the one test needing a Screen Recording grant
npm run test:slow                                  # cross-implementation export identity (minutes)
npm run gate / gate:export / gate:seek / gate:identity
npm run gate                                       # increment-0 sink-identity gate (needs Chrome)
npm run app:start                                  # build + launch the Electron shell
npm run merge -- <pr>                              # merge a PR, but ONLY if its CI is green
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
- **`gh pr merge --auto` does NOT wait for CI here** — auto-merge waits for *required* status
  checks, and requiring one needs branch protection, which needs GitHub Pro or a public repo. This
  is a free private repo, so there are no required checks and `--auto` merges IMMEDIATELY. It
  landed PR #2 while its run was still in progress. Use `npm run merge -- <pr>`
  (`scripts/merge-when-green.mjs`), which polls the run matching the PR's head SHA and refuses to
  merge anything not green.
- **`gh pr checks --watch` exits 0 when no checks exist yet** — it does not wait for one to
  appear. Run it in the seconds between opening a PR and GitHub registering the workflow and it
  prints `no checks reported` and exits **successfully**, which reads as "passed" to anything
  that checks the exit code. Seen on PR #10: the watch returned exit 0 before the run existed,
  and the run then started 20 s later and was still in progress. Same family as the `--auto`
  trap above — a command that succeeds by finding nothing to do, in a place where success is
  read as verification. Confirm a run exists for the PR's head SHA first
  (`gh run list --branch <branch>`), then watch that run by id with
  `gh run watch <id> --exit-status`.
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
- **An `AVAssetWriter` append and its teardown must not overlap** — a take's FIRST append lazily
  creates the video compressor and takes milliseconds. If `markAsFinished`/`finishWriting` run on
  another thread inside that window, AVFoundation retains a track it has already released and the
  process dies. This was STC-254: intermittent on CI, invisible here, because on this machine the
  first frame lands long before any stop and on a CI VM it can land inside one. Appending *after*
  `markAsFinished` has returned is safe — it returns `false` — so guarding the nil checks alone
  fixes nothing; the fatal window is the append's own duration. `WriterGate` holds its lock across
  the append. Reproduces out of process in one to two iterations (`helper/test/writer-gate/`).
- **A fault does not pick one signal** — the same use-after-free landed as `EXC_BREAKPOINT`/SIGTRAP
  on CI (both reports) and as `EXC_BAD_ACCESS`/SIGSEGV in the local repro, depending on what the
  freed memory happened to hold. The crash handler originally covered SIGSEGV/BUS/ILL/FPE/ABRT but
  not SIGTRAP, so the variant that actually reached CI died mute — the parent saw a bare signal
  number from precisely the fault the handler existed to explain. SIGTRAP is now installed and
  every signal is named explicitly; the old `default: "SIGABRT"` would have mislabelled anything
  added to the loop, and a diagnostic that lies is worse than one that admits ignorance.
  `helper/test/crash-signals.test.ts` signals the real binary and asserts the stderr line.
- **The Camera pane only lists apps that have already REQUESTED access** — there is no
  add button, so a bundle that merely *reads* `AVCaptureDevice.authorizationStatus` never
  appears there and can never be granted. Reading status is not enough to become grantable;
  something must call `requestAccess` once to raise the prompt. `requestAccess` shows the
  dialog WITHOUT opening the device or lighting the LED, which is what makes it safe to call
  from a probe. `tools/test-host --camera-request` exists for exactly this.
- **Camera TCC inherits through the bundle, same as Screen Recording — verified 2026-08-26.**
  `helper/test/camera.grant.test.ts` launches the helper from the signed test-host and the
  helper reports `authorized`. This was STC-232 increment 1's gate, sequenced first precisely
  because a failure would have invalidated the shared-process capture design.
- **An empty events.json does not mean the tap is broken** — an automated capture records zero
  events simply because nothing moves the mouse, which is indistinguishable from a dead button
  path. Verifying input needs deliberate input; `fixtures/real-session/` pins the result.
- **CI's H.264 encoder can block forever on first touch — MEASURED, not inferred (STC-259).**
  Run 33102859258, same commit, two attempts: the first had `VTCopyVideoEncoderList` block past
  15 s; the re-run listed 21 encoders and acquired a hardware session in 144.9 ms. CI reports
  `paravirtualized:Apple Video Encoder`, a passthrough to a host shared with other tenants, so
  the verdict is per-host and per-moment. Any FIRST touch is exposed — the inventory, the
  acquisition, and `AVAssetWriter`'s lazy compressor creation, which is where both original
  STC-254 crash reports pointed. This is what made unrelated PRs go red for days. `writer-gate`
  bounds both encoder queries at 15 s, retries the run three times, then reports a loud SKIP.
- **A new bound must be checked against every bound already covering the same code**, not just
  against the thing it bounds. Three bounds added to `writer-gate` in one day each failed to
  fire: a synchronous call blocked the event loop its timer lived on; collected stderr was
  discarded because the promise never settled; and an inner bound was set exactly equal to the
  outer one, so the informative message always lost the race. Each was individually sound. The
  harness now prints its own bound and the test asserts it against the runner's exported
  `HARNESS_RUN_MS`, so the clearance is checked rather than kept in step by hand.
- **A bound nobody has watched fire is indistinguishable from one that cannot fire.** Same for a
  retry nobody has counted. `STC_WG_FAULT` hangs the encoder query on demand and
  `STC_WG_ATTEMPT_LOG` records one line per process start, so both are asserted against observed
  behaviour. The load-bearing assertion is that the failure is OURS and not the runner's
  (`not.toContain("did not finish within")`) — an inner bound that loses that race is decorative.
- **Vitest DISCARDS `console.*` output from a test that ends up skipped** — it attributes console
  output to the producing test, and a skipped one prints nothing. A skip notice written with
  `console.warn` therefore vanishes exactly when it is needed, leaving a silent green tick where
  a gate did not run: CLAUDE.md's "success by finding nothing to do" trap, self-inflicted. Write
  skip notices with `process.stderr.write`, which survives, and verify by actually skipping.
- **A test seam that fakes state the subject contradicts races the subject's own self-healing.**
  `supervisor.test.ts`'s crash-mid-recording test called `markRecordingForTest()` against a live,
  *idle* helper. The supervisor treats the heartbeat as the authority and heals any desync, so any
  stats line landing between the kill and `waitForExit` resolving cleared `recordingDir` and the
  crash had nothing left to report as lost — `expected +0 to be 1`, green on this Mac 8/8 and on
  reruns, red on a loaded CI VM (run 33104414974). Nothing was wrong with the product: the
  self-healing is the documented feature. The fix is a world the fake can be true in —
  `app/test/_fake-helper.mjs` speaks the control plane, can actually be recording, and lets the
  test drive the real `startRecording`. Waiting for the helper's own heartbeat to AGREE is the
  load-bearing step; it is precisely what the old fake could not survive.

- **The gates' encoder is bounded on BOTH sides of the process line, and the outer one is the
  load-bearing half.** #30 bounded every `page.evaluate` (Playwright has no default timeout on it);
  #31 added the in-page half — `harness/main.ts` now has the bounded back-pressure drain that
  `transform/src/export.ts` already had, so a stalled encoder fails at the frame it stopped on
  ("encoder stopped draining at frame 35 of 300, queue stuck at 31") instead of surfacing minutes
  later with the count lost. **The inner bound cannot replace the outer one**: every in-page bound
  is a JS timer, and a timer cannot fire while the renderer's main thread is blocked.
  `VideoEncoder.configure()` is synchronous and CI's encoder is a paravirtualized passthrough that
  STC-259 measured blocking past 15 s on first touch — when that happens only another PROCESS can
  notice, which is why the gate ran 24 min with nothing to say. The page is HANDED its bound by the
  runner and echoes it back for the driver to assert, and `runGate` refuses to run without one: a
  bound the page defaults on its own is a bound nobody checks. `ENCODER_MS < EVAL_MS` is asserted in
  `gate-bounds.test.ts`, not left true by luck.
  NB pacing the encode loop changed gate C's encoded size (537167 -> 314306 bytes) — rate control
  responds to submission timing. Pre-encode determinism is untouched, which is what the gate proves;
  gate C only asserts the encoder produced bytes at all.

- **"E2E flake" on this machine is usually SATURATION, not a test bug — and the tell is which tests
  fail.** A loaded run takes down `transform/test/schema.test.ts` (pure JSON-schema validation, no
  Electron, no subprocess) and `spawnSync xcrun ETIMEDOUT` alongside the Electron suites. When a
  pure-computation test and the toolchain itself time out, nothing is wrong with the E2E tests:
  the box is starved and the most timing-sensitive tests simply fail first, which is why the app
  E2E files look like the culprits. Measured 2026-08-27: the full suite is 207+ tests spawning
  Electron many times over plus the helper's process-heavy tests, and a `npm run gate` loop
  alongside it is enough to push it over. Before debugging a flake, check `uptime` and
  `ps -Ao command | grep -c '[s]tc-screen-recorder/node_modules/electron'` — a killed run leaves
  Electron orphans behind (`afterEach` closes with `.catch(() => {})`, which swallows the failure),
  and they accumulate across interrupted runs until everything times out. A CLEAN completed run
  leaks nothing; interrupted ones do.
  Cautionary tale from the same session: a load experiment using `(while :; do :; done) &` spinners
  survived both `kill $(jobs -p)` and a `pkill -f` whose pattern did not match the resulting bare
  `/bin/zsh`. They ran for 26 minutes at 8 cores, load hit 404, and every before/after measurement
  taken in that window was worthless — including one that appeared to show a fix making things
  worse. If you generate load, kill it by PID and CONFIRM with `ps` before believing any number.

- **The E2E files run one at a time; everything else stays parallel.** `vitest.config.ts` is two
  projects — `unit` (default parallelism) and `e2e` (`fileParallelism: false`). Measured
  2026-08-28 with a sampler counting Electron MAIN processes: a full run peaked at FIVE apps on the
  machine at once before, and ONE after. That is the largest single source of the saturation
  described above. The cost is real and was measured too: the full suite goes 19 s -> 36 s, since
  the E2E files no longer overlap. `vitest.grant.config.ts` reached the same conclusion earlier for
  its own reason (concurrent `open -W` on one app bundle).
  **This is not proven to reduce the flake** — both arms were green on an idle machine, and a flake
  that needs a loaded machine cannot be measured on a quiet one without generating load, which is
  itself how a whole afternoon of measurements got invalidated. It removes a known saturation
  source; that is the whole claim.
  When counting processes to check any of this, filter with `startsWith` on the absolute binary
  path and list `ps` ONCE from inside the script. Three separate measurements in one session were
  wrong because the shell running the check had the search string in its own command line and
  matched itself — a phantom baseline of 2 with nothing running, and a "peak 6" that was mostly
  the grep. Calibrate against a known state (0 idle, 1 with one app) before trusting a number.

- **`npm run merge`'s exit code has been wrong in BOTH directions; it is now decided by asking
  GitHub, not by trusting `gh`.** First it looked like it exited 0 after giving up — that was an
  invocation piping it through `tail`, and a pipeline reports its LAST command's status, not the
  script's. Then it genuinely exited 1 after a merge that landed (PR #34): `gh pr merge
  --delete-branch` merges server-side and then deletes the LOCAL branch, which means switching off
  it, which fails from a worktree because master is checked out in the main checkout
  (`fatal: 'master' is already used by worktree`). The merge stood and the script called it a
  failure. It no longer passes `--delete-branch`: it merges, re-reads the PR's state as the
  authority, and deletes the remote ref over the API — which touches no local branch. A cleanup
  that did not happen is not a merge that did not happen, so that failure is REPORTED and does not
  change the exit code. `transform/test/merge-when-green.test.ts` drives the real script with a
  stub `gh` on PATH and watches all four outcomes, including both directions of wrongness.
  When writing such a test: `execFileSync` returns stdout ONLY, so an assertion on a message
  written to stderr fails for the wrong reason. Use `spawnSync` and read both streams.

- **The 26-minute "gate stall" was TEARDOWN, not the gate — and not the encoder.** Root-caused from
  the logs of run 33108160534: the gate did not hang. It FAILED correctly 66 s in with
  `TimeoutError: decoder flush did not complete within 60000ms`, printed that, and then sat for
  another 26 minutes in `finally` on an unbounded `browser.close()` — closing a browser whose
  renderer is wedged inside a stuck decoder never returns. The job timeout killed it, which reports
  as "cancelled", so the log looked like a hang with no explanation. #30's `closeQuietly` bounds
  teardown at 30 s and now names it: master runs 33194258237 and 33193936334 show the whole thing
  finishing in 96 s with `(teardown: browser.close() did not return within 30000 ms)` and a clean
  exit 1. **The earlier guess that this was `VideoEncoder.configure()` blocking synchronously was
  wrong** — the encoder is not involved; read the failing step's log before theorising.
  The REMAINING fault is the decoder: `VideoDecoder.flush()` not settling for a 90-frame 640x360
  fixture on CI, on roughly HALF of master's push runs. `decode.ts` now reports, on the failure path
  only, how many chunks went in, how many frames came out, `decodeQueueSize`, `state`, and what
  `isConfigSupported` says for hardware and software — because "did not complete" cannot tell a
  decoder that never started from one that stalled at the last frame, and those are different bugs.
  `FLUSH_MS` is one constant so the bound and the message it prints cannot disagree.

- **The determinism gate retries on the MACHINE and skips loudly; it never retries a wrong answer.**
  `npm run gate` is now `scripts/gate-retry.mjs`, which runs `gate.mjs` up to 3 times and keys
  strictly on the `ENVIRONMENT:` label the gate prints when a BOUND fired. Every determinism check
  reports through `fail()` with a concrete number — a hash mismatch, a frame count, zero encoded
  bytes — and a run containing any `FAIL:` line, a death by signal, or the runner's own bound is
  disqualified from being retried. After 3 environment failures it announces a SKIP (an Actions
  `::warning`, and stderr not `console.warn`) and exits 0: the annotation is the record that the
  gate did NOT run, which is not the same as a pass.
  Why this and not "let it fail loudly": master was red on ~half of pushes, and a red X that means
  either "you broke determinism" or "Apple's shared GPU did not answer" is AMBIGUOUS, not loud —
  it is how a real breakage survives, and one did on 2026-08-28 (#28/#32). Red now always means the
  code; SKIP means the machine.
  `STC_GATE_FAULT=environment|regression` makes both paths reachable on demand and
  `STC_GATE_ATTEMPT_LOG` counts attempts, so the retry is asserted against observed behaviour:
  3 attempts then SKIP for the machine, 1 attempt then exit 1 for a regression. Each guard was
  mutation-tested — dropping the `FAIL:` disqualifier, the signal check, or the condition itself
  each breaks 3 tests.

- **Retry logic must key on the failure being the MACHINE's, never on "it failed"** — a retry
  that absorbs a real regression is worse than no retry. `writer-gate` keys strictly on the
  harness's `ENVIRONMENT:` marker and excludes death-by-signal, failed assertions, and the
  runner's own timeout by name, each covered by a test. STC-254 arrived as SIGTRAP on CI and
  SIGSEGV locally; retrying either three times and calling it a skip would have buried it.
- **The PiP is visually confirmed (2026-08-28), and that is a separate fact from every gate.**
  Watched on a real 15 s 4K take (`Elgato Facecam 4K [USB2]`, 60 fps): camera bottom-right,
  correctly proportioned, appearing when the camera track starts, in sync with the screen. This
  is the same class of check PHASE-1 recorded for the cursor, and it is not redundant with the
  determinism gate — a uniformly mispositioned or time-shifted PiP passes every automated check
  in this repo, including the blind-hash check, which only proves the PiP changed *some* pixels.
  NB the first clip produced for this check was WRONG: `scripts/export-one.mjs` hardcoded a
  project with no `pip`, so it exported the take with the PiP disabled and the reviewer correctly
  reported seeing no PiP. Any artifact made for human verification must come from the take's own
  `project.json` — fixed, but the lesson is that the verification path needs verifying too.
  STILL NOT MEASURED: the camera-to-display sync NUMBER. "Looks in sync" is an eye's tolerance,
  not a millisecond figure; `scratch/` has `avsync.cjs` for producing one, and increment 5 owns it.
- **A gate with its OWN loader does not prove the app can open anything.** The
  PiP determinism gate passed on a real camera take while the Electron app
  could not open one at all: `harness/sink-identity.ts` supplied `camera.mp4`
  to `loadSession`, and `app/src/renderer.ts` and `harness/export.ts` did not,
  so every camera take died at load with "anchors.camera.present is true but no
  camera.mp4 was supplied" — `loadSession` correctly refusing to silently drop
  the PiP. Nothing caught it because every other fixture is camera-less. When a
  loader gains an input, grep `loadSession(` and fix EVERY caller; the gate is
  not one of the app's code paths. `app/test/preview.e2e.test.ts` now opens a
  PiP take from the committed fixture, and fails without the renderer fix.
- **`vitest.grant.config.ts` globbed the agent worktrees.** Its
  `include: ["**/*.grant.test.ts"]` had no directory scoping, so once
  `.claude/worktrees/` held other agents' checkouts, `npm run test:capture` ran
  their copies too — which resolve `tools/test-host/STCTestHost.app` relative to
  their own root, where it does not exist, and fail with "build it first" for a
  bundle that IS built. Seven failures, none about this checkout.
  `vitest.config.ts` was always scoped; the grant config was not.
- **Preview-memory ratios are regime-dependent — quote absolute growth.**
  PHASE-2's "~1.2x file size" came from a 458 MB take where the file dominates;
  on a 24 MB take the fixed costs dominate (decoder buffers plus a decoded 4K
  frame at ~30 MB) and display-only reads as 5.7x its own file. Same code, same
  metric, incomparable numbers. `scripts/measure-preview-memory.mjs` is the
  committed harness; PHASE-2 records what it measured and what it does NOT
  answer.
- **A 720p camera track is not automatically small next to 4K.** Measured: on a
  15 s take `camera.mp4` was 1.7x the size of `display.mp4` (15 MB vs 9 MB). A
  static screen compresses far better than a moving face, so the design spec's
  "a 720p camera adds ~10-15%" assumed a ratio that does not hold on short
  takes.
- **`tsconfig.json`'s `include` is the whole scope of static checking in this repo** — vitest
  transpiles without typechecking and esbuild does not check either, so a directory left out of
  `include` has NO static checking at all, not merely weaker checking. `include` was
  `["transform/**/*.ts"]`, so `harness/` and `app/` were never checked: adding a parameter to
  `composite()` broke `harness/main.ts:40` and `:71` while `npx tsc --noEmit` stayed green and all
  195 tests passed, and only `npm run gate` — a real browser run — caught it, as a runtime
  `TypeError`. Same family as the `--auto` and `--watch` traps: a command that succeeds by finding
  nothing to do, in a place where success is read as verification. `transform/`, `harness/`, `app/`,
  `helper/` and the root `vitest.*.ts` are all in `include` now (`helper/test/` was a third
  unchecked tree, found while fixing the first two), and `paths` maps `@transform/*` because tsc
  cannot read vite's or esbuild's aliases.
  Verified by re-adding the `composite()` parameter and watching tsc fail on those exact lines.

- **Typechecking is THREE passes — `npx tsc --noEmit` runs only the first.** Use
  `npm run typecheck`, which is what CI runs. `tsconfig.json` is the coverage pass (every .ts file,
  DOM and node both visible) and is deliberately what a bare `tsc` runs, so the default can never
  be a partial check that reads as a full one. `tsconfig.browser.json` (`types: []`) and
  `tsconfig.node.json` (`lib` without DOM) then add RUNTIME constraints on top: `document` in the
  Electron main process and `process`/`require` in the renderer or the transform are both runtime
  crashes, and both are now type errors at the use site. The browser pass also guards the
  non-negotiable structurally — a node import in `transform/src/` would quietly make the pure
  transform node-only. Scope is by directory with `app/src/renderer.ts` carved out, not an explicit
  file list, so a new file under `app/src/` gets the constraint automatically and must opt out.
  `skipLibCheck` is on in the two narrowed passes ONLY, and only because `electron.d.ts` declares
  the main, renderer and `<webview>` APIs in one file and cannot parse without `lib.dom` (11x
  TS2304); the coverage pass has it off, so declaration files are still checked exactly once.
  All four constraints were verified by watching them fail — `document` in main, `process` in the
  renderer, `require` in the transform, and the `composite()` arity drift — each confirmed to make
  `npm run typecheck` exit non-zero, then reverted.
