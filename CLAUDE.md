# stc-screen-recorder — Claude Code handoff

macOS screen recorder. Electron UI + Swift helper. Captures display + cursor
events → deterministic transform → CFR MP4 with cursor overlay.

## Where things are

| path | what |
|---|---|
| `PHASE-1.md` | current phase plan — read this first |
| `docs/PHASE-0-FINDINGS.md` | spike results; all settled decisions sourced here |
| `docs/HANDOFF-2026-08-31.md` | what moved on 2026-08-31, what was got wrong, and the one open question |
| `helper/src/` | Swift helper (increment 1, in progress) |
| `helper/src/Protocol.swift` | JSON-line IPC + Clock |
| `helper/src/Watchers.swift` | display/device watchers |
| `helper/src/main.swift` | App lifecycle, command dispatch |
| `helper/build.sh` | builds and signs; `SIGN_ID="..." ./build.sh` to override |
| `helper/test/stop-bounds.test.ts` | the stop chain: camera backstop < display backstop < the client's request timeout |
| `helper/test/ipc.test.ts` | black-box IPC tests — spawn the binary, drive stdin, assert on fd3/stdout |
| `app/src/helper-client.ts` | promise-based client for the two-channel protocol (fd3 + lossy stdout) |
| `app/src/supervisor.ts` | keeps the helper alive; makes crashes and lost recordings legible |
| `app/src/main.ts` | Electron main — owns the supervisor, spawns the helper as its child |
| `app/build.mjs` | esbuild bundle -> `app/dist/`; `npm run app:start` builds and launches |
| `transform/src/` | the pure transform + shared sink modules (TS; render, time, cursor, demux, decode, compositor) |
| `schema/` | versioned session schemas (anchors-1/2, events-1/2, project-1/2) |
| `transform/src/cursor-art.ts` | the macOS pointer set as vector paths (STC-239); the events-2 `shape` enum must equal its list |
| `helper/src/CursorShape.swift` | the AppKit side of STC-309: pointer → `CursorSignature`, the 30 Hz `CursorSampler`, and the `cursor-probe` spike. Decisions are in `CaptureDecisions.swift` |
| `docs/STC-309-RUNBOOK.md` | what to run on the Mac for STC-309, in order, and what each run must show |
| `helper/src/Still.swift` | `capture-still` and `windows` (STC-289): one frame through `SCScreenshotManager`, reached via the ObjC runtime because the 13.3 SDK has no header for it; display filter for regions, window filter for windows |
| `helper/src/StillDecisions.swift` | the still path's pure decisions — request parsing, crop, cursor localisation, `shotDocument` — tested without a display by `helper/test/still/` |
| `schema/shot-1.schema.json`, `transform/src/shot.ts` | the still document and its loader (`parseShot` refuses rather than defaults); `fixtures/shot/` |
| `docs/STC-289-RUNBOOK.md` | what to run on the Mac for the still path, and what each result means |
| `fixtures/` | hand-authored 5 s fixture session + deterministic display.mp4 generator |
| `harness/` | vite-served browser harness hosting both sinks |
| `scripts/gate.mjs` | increment-0 determinism gate (Playwright + real Chrome) |
| `scripts/gate-skip-rate.mjs` | how often each gate actually RAN on CI — run it before trusting a green tick |
| `docs/STC-259-GATE-SKIP-RATE.md` | the 100%-skip finding, its evidence, and what to do |
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
| STC-232 | **PHASE 3 COMPLETE 2026-08-30** — increments 1-5 done. Recorded from the app with the camera toggle on, previewed with no hand-written project.json, sync measured at 65 ms | nothing |
| STC-232 4b | **done and VISUALLY CONFIRMED 2026-08-28** — both sinks draw the PiP, gate proves it, app opens camera takes, and a human watched a real 4K take. Increment 5 is unblocked | nothing; increment 5 is next |
| STC-259 | **DONE** — steps 1-3, plus Mode B diagnosed. Both encoder queries bounded at 15 s, the harness's first append bounded behind a deadline watchdog, and the product answered: it does not need one. `ATTEMPTS = 1` (measured useless). The wedge is the decoder's synchronous `configure()`. **`prefer-software` did NOT fix it, CONFIRMED on CI** — run 33576888543 wedged all four gates with `decoder preference: prefer-software` in every trail | nothing. What the decoder is blocked ON is the open question, and it is no longer answerable by choosing a different decoder |
| STC-249 | **DONE** — both halves. Channel independence is mutation-proven without a grant (`ring-overflow.slow.test.ts`); the capture-side half RAN on real hardware 2026-08-31 and passed (`lossy-under-capture.grant.test.ts`) | nothing |
| STC-254 | **done** — append/teardown race fixed (part 2), SIGTRAP crash handler closed (part 3). Master CI green again | nothing; watch that master stays green |
| STC-287 | **done** — the camera's lifecycle is no longer invisible: device name while recording, a visible reason when it fails, and each take states when its PiP starts or that the camera recorded nothing. The ~1.4 s gap itself is inherent and deliberate | nothing |
| STC-286 | **cause found 2026-08-31, and now reported DURING the take.** In clamshell the built-in camera OPENS — `camera-started device: "FaceTime HD Camera"` — then delivers nothing: 0-byte camera.mp4, `present: false`. Not a failed open and not a wrong pick (`pickCamera` chose correctly over a virtual device and Continuity). A 3 s liveness watchdog warns while recording | nothing — both arms verified on hardware, lid shut AND lid open |
| STC-239 | **transform half DONE 2026-09-02** — the placeholder circle is macOS pointer artwork (arrow, I-beam, crosshair, pointing hand), vector paths with the hotspot at the origin, drawn at `pxPerPoint` (display→output ratio × `project.cursor.scale`). `events-2` adds `{kind:"cursor", shape}`; the sim shows the arrow until the first one, which is what every v1 take means. `project.cursor.style: "circle"` keeps the old placeholder as an option (project.json only — no UI for it). **The helper still writes v1 and emits no cursor events**, so real takes show the arrow throughout. Merged as #65; closed 2026-09-02 | nothing — the helper half is STC-309 |
| STC-309 | **DONE 2026-09-04, WATCHED on hardware.** The helper samples `NSCursor.currentSystem` at 30 Hz on its own thread (`helper/src/CursorShape.swift`), classifies against references MEASURED at start from the four `NSCursor` built-ins, emits `{kind:"cursor", shape}` only on change, and writes events.json **v2** time-ordered. Spike on hardware: the API sees other apps' pointers from the background helper, all four shapes match byte-for-byte, a sample costs 1.04 ms mean / 41 ms max (why it is NOT on the tap thread). An 11 s take from the app (726 moves, 37 shape changes) was exported and watched: I-beam over the field, hand over the links, arrow elsewhere, click highlight under the I-beam, in step with the video. Pinned as `fixtures/real-session-cursor/` + `helper/test/real-events-cursor.test.ts`. #67, #75, #76 | nothing. More shapes (resize, hands, not-allowed — seen as unknown, written as arrow) need artwork + events-3 |
| STC-306 | **helper half DONE 2026-09-04.** A display stream that dies under a live take (`didStopWithError` after `started`) now ends the take the way a display change does: `CaptureSession.onStreamDied` → `App.stop(reason: "stream-stopped")`, warning first, unsolicited `stopped` after, sidecars written and `display.mp4` finalised. `anchors-2` `stop.reason` gained `stream-stopped` / `stream-stopped-timeout`. The helper's FIRST production fault injector: `STC_CAPTURE_FAULT=stream-died` makes the session call its own delegate 0.5 s after a successful start, which is how `helper/test/stream-died.grant.test.ts` watches the path fire instead of reasoning about it. Written on Linux with no swiftc — CI's macOS runner is the first compile | `npm run test:capture` on the Mac: both new tests need the grant. `npm run test:capture` also covers STC-311's new schema validation |
| STC-311 | **DONE 2026-09-04.** `anchors-2` `stop.reason` now describes what the helper can actually write: the fixed reasons plus `quit` / `stdin-closed` / `stopped-during-start`, a `^signal-[0-9]+(-timeout)?$` pattern for the open-ended family, and a `-timeout` variant of every one. `helper/test/stop-reasons.test.ts` is the drift guard — it READS the reason literals out of the Swift call sites and holds the schema to them, so it needs no list of its own | nothing; the schema half runs in `npm test` |
| STC-289 | **helper still capture — written 2026-09-04 on Linux; COMPILED and unit-tested on CI (SDK 15), NOT yet built against the Mac's 13.3 SDK or run with a grant.** `capture-still` returns one frame via `SCScreenshotManager` with no stream and no recording lifecycle; `windows` lists what a window shot can name. Display filter + `sourceRect` for region/full shots, `desktopIndependentWindow` filter for window shots with alpha end to end; `frame.png` + `shot.json` (shot-1, cherry-picked from the review branch) in the request's dir; cursor sampled from `NSEvent.mouseLocation`, absent when on another display; 10 s answer-once backstop. The pure half is tested without a grant and every document it writes is validated against the schema AND `parseShot` on every `npm test` | a Mac: `docs/STC-289-RUNBOOK.md`. The ObjC-runtime call is the one line no test on Linux can vouch for; `still.grant.test.ts` is the proof |
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
  a watchable file. The cursor was a placeholder circle until STC-239 (2026-09-02); it is macOS
  pointer artwork now, arrow by default.
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
- **The two channels are independent, and that is now MEASURED, not just described (STC-249).**
  A stalled stdout — stalled hard enough that the ring is actively dropping — does not stop fd3
  answering: 24 ms for a `status` on this machine. The failure that rules out is silent and total,
  because a parent whose UI stopped reading stats would find it could no longer stop the recording
  either, and the take would be unfinishable.
  Proven by MUTATION, which is the only way this claim means anything: move `cond.unlock()` in
  `LossyChannel.writeLoop` to AFTER the writes — the lock held across I/O, exactly the
  back-pressure bug the design forbids — and both tests in `ring-overflow.slow.test.ts` fail.
  Getting the lossy channel into a dropping state is escalated, never a fixed stall: measured idle
  here, 2000 ms dropped NOTHING, 4000 ms dropped 1051, 8000 ms dropped 5038. The kernel's pipe
  buffer decides, and CI's is bigger — a fixed stall calibrated here is the portability bug that
  file already hit on its first CI run.
  **The capture-side half is now VERIFIED on real hardware (2026-08-31).**
  `helper/test/lossy-under-capture.grant.test.ts` recorded for 8 s with stdout never read, and the
  ring overflowed on the first attempt without escalating. Frames captured, ZERO dropped, zero
  non-monotonic; `stop` was issued and answered over fd3 while stdout was stalled; and a drained
  control of the same length captured comparably. So the claim that stats cannot back-pressure the
  capture graph is measured, not merely described.
  It needs a Screen Recording grant for the TERMINAL that runs it — the helper is spawned directly,
  so it inherits the launching process's TCC identity, and STCTestHost being granted says nothing
  about that. `npx vitest run --config vitest.grant.config.ts helper/test/lossy-under-capture.grant.test.ts`;
  the SKIP-GRANT path returns before any recording, so a missing grant costs seconds.

- **The pre-encode hash DEPENDS ON THE RASTERIZATION BACKEND, and that was found by CI.**
  Measured on `fixtures/basic`, same code and same project: GPU gives
  `10a05a33…`, swiftshader gives `bc03e397…`. `composite()` draws to a canvas and the pixels are
  Chromium's to produce, so the determinism this repo gates on holds WITHIN a backend, not across
  two. Every gate compares inside ONE browser and is unaffected — but any cross-engine comparison
  is asserting something the codebase does not control.
  `app/test/export-identity.slow.test.ts` is exactly that: the app's Electron against the CLI's
  Chrome. It passed here for weeks and failed on its first CI run with precisely those two hashes,
  because Electron rasterized in software and Chrome used the GPU. Reproduced locally in one
  command by forcing swiftshader, which is how it was identified rather than guessed.
  Both sides are pinned to software now (`scripts/render-backend.mjs`, `STC_FORCE_SOFTWARE_RENDER`
  for the CLI side) — software because it is the backend every environment can provide. The flags
  live in ONE module and `transform/test/render-backend.test.ts` refuses a second copy; this is the
  fourth "one value, two copies" defect fixed in a single session.

- **`test:slow` runs in CI now, and the reason it never could was a Desktop dependency.**
  `app/test/export-identity.slow.test.ts` reached into `~/Desktop/stc` for a take and threw when
  it found none, so the one check that catches a UI-vs-CLI export divergence ran nowhere
  automatically — and it has caught two real ones. CLAUDE.md already recorded four E2E files being
  moved off the Desktop for exactly this; this file was missed because it is not in `npm test` and
  nobody was watching it. It uses `fixtures/basic` now (171 s -> 81 s), with
  `STC_EXPORT_IDENTITY_TAKE=real|<path>` to restore the heavier check by hand.
  The step is bounded as ONE process (`SLOW_TESTS_MS`, 12 min) the way each gate is, counted in
  `worstCaseJobMs` (56.8 min against a 65 min cap), and three guards assert the chain: ci.yml's
  step bound equals the declared constant, the model MOVES when the term is deleted, and a slow
  test's own `testTimeout` stays under the step's bound. That last one was missing and the config
  allowed **30 minutes per test** — three tests could have claimed 90 inside a 12-minute step and
  a 65-minute job, and a hung one would have died anonymously at the cap.
  **CI runs only `export-identity` from that suite, not the whole thing.**
  `ring-overflow.slow.test.ts` escalates a stall until the KERNEL's pipe overflows, so its
  duration is a property of the machine; its own comment already recorded that it "timed out on CI
  at 180 s", which is why it lived outside CI — and putting the whole suite in took it along. It
  passed three runs and timed out on the fourth. A test that reddens PRs at random is worse than
  one that does not run, so CI names the file it runs and `gate-bounds.test.ts` refuses
  `ring-overflow` there. The cost is real and stated in the doc: the lossy channel's end-to-end
  wiring and STC-249's channel-independence check are local-only commands.
  `vitest.slow.config.ts` was also UNSCOPED (`**/*.slow.test.ts`), so it globbed
  `.claude/worktrees/` — the same defect fixed in `vitest.grant.config.ts` on 2026-08-27, one file
  over. It is not cosmetic: it made a mutation test lie, reporting "2 failed | 2 passed" where the
  passes were other checkouts. Scoped, the same mutation fails 2 of 2.

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
- **A camera that OPENS and then delivers nothing is the failure that looks like success
  (STC-286).** Confirmed on real hardware 2026-08-31, laptop in clamshell on an external display:
  `camera-started` fires with `device: "FaceTime HD Camera"`, `camera.mp4` is created at 0 bytes,
  `captureOutput` is never called once, and `anchors.camera` ends `{present: false}` with NO device
  name — `track()` returns nil on zero frames and takes `deviceName` with it, which is why the
  test-host transcript was needed to identify the device at all.
  It is NOT a failed open, NOT a permission problem, and NOT the wrong device: `pickCamera` chose
  the built-in over an Elgato virtual camera and a Continuity iPhone, so #44's `transportType`
  ranking is holding. `startRunning()` simply returns on a camera that will never produce a frame.
  STC-287's work made this look WORSE before it made it better: the app showed the device name for
  the whole take — accurate, and actively misleading — and only admitted the truth in the library
  afterwards. `CameraCapture.noFramesWarningSeconds` (3 s, armed after `startRunning`) now warns
  while the take is still running. Three seconds because frames follow `startRunning` almost
  immediately: the ~1.4 s a viewer waits for the PiP is the OPEN, already done by then.
  Clamshell is only the reproducible case — a covered lens, another app holding the device, or a
  Continuity camera wandering off all look identical, and all are now reported.
  **BOTH ARMS are verified on hardware (2026-08-31), which no automated test can do — nothing in
  the suite can produce a camera delivering frames.** Lid shut, three runs: the camera opens, names
  itself, delivers nothing, and the warning fires 3.06 s after `camera-started`. Lid OPEN, control
  run: the same camera opens, `present: true`, first frame at 1.759 s, ~29 fps over a 10.6 s track,
  and the watchdog stays SILENT. The margin is real rather than assumed — almost all of that 1.76 s
  is the OPEN, and frames follow `startRunning` immediately, which is what the 3 s is measured
  against.
  NB the control very nearly read as a second clamshell run: `ioreg -r -k AppleClamshellState -d 4`
  prints a whole subtree, and `grep -o 'Yes\|No'` on it matches an unrelated token long before the
  clamshell line. Scope the grep to `"AppleClamshellState"` or the reading is not about the lid at
  all.

- **Two checks can each exist and still leave a hole between them, if they are on different
  VALUES (STC-311).** `anchors-2`'s `stop.reason` was a closed enum of five reasons and their
  `-timeout` variants. The helper writes four families it refused: `quit`, `stdin-closed` and
  `signal-N` from `App.shutdown` (STC-304), and `stopped-during-start` (STC-305). Both halves of
  the check were already in the repo and neither could see it —
  `shutdown-during-recording.grant.test.ts` asserted `reason === "signal-15"` without validating
  the document, and `anchors/main.swift` validated documents against the schema but only ever
  built them with `stopReason: "user"`. Assertion on one value, validation on another; the gap
  sat exactly between. Nothing broke downstream only because NOTHING validates anchors.json at
  load — `recording.ts` and `takes.ts` read `stop.t` and never `stop.reason` — so it was a schema
  that lies rather than a take that fails, which is why it survived three tickets.
  The fix is not a longer enum: `CaptureSession.stop`'s backstop answers `\(reason)-timeout` for
  WHATEVER reason it was given, so the suffix is a property of every family and hand-listing the
  cross-product is the drift that caused this. The schema states the rule (enum + a `signal-`
  pattern), and `helper/test/stop-reasons.test.ts` READS the reason literals out of the Swift call
  sites — expanding `signal-\(sig)` from the signal list it finds in `installSignalHandlers`, and
  THROWING on any interpolation it cannot expand rather than skipping it — and holds the schema to
  them. Deliberately no list of its own: a fourth copy is the defect, not the fix. Watched failing
  against the pre-STC-311 schema, against a schema missing only `stopped-during-start`, and — the
  one that matters — against `{"type": "string"}`, which is what "fixing" a schema by widening it
  until nothing fails looks like.
  NB the signal list is grepped by WHAT ITS LOOP DOES (`shutdown(reason:)`), not by position:
  `main.swift` has two `for sig in [...]` loops and the FIRST is `installCrashHandlers`
  (SIGSEGV/BUS/ILL/FPE/ABRT/TRAP), which dies with a stderr line and never writes a reason at all.
  A fourth copy was found while fixing this and deleted rather than corrected: `transform/src/
  types.ts` typed `stop.reason` as a union of four, missing `stream-stopped` and every shutdown
  reason. A union that cannot express values real files carry type-checks a lie and makes a
  `switch` look exhaustive; it is `string` now, with the enumeration living only in the schema.

- **A raw `display.mp4` never has a cursor, and a "the cursor is missing" report must say which file
  was watched.** `showsCursor` is off by design; the pointer exists only in an EXPORT, drawn from
  events.json. The first STC-309 watch (2026-09-04) was reported as "no cursor at all", and the file
  had 726 moves and 37 shape changes — the raw capture had been opened in QuickTime. Ask which file
  before reading a transform regression into it; `node scripts/export-one.mjs <take> 30` is the
  fastest way to a watchable one.
- **`stop()`'s own `tapEnable(false)` comes back to the tap callback as `tapDisabledByUserInput`,
  and the helper used to count it as a re-enable — and then RE-ENABLE the tap it had just
  disabled.** Invisible until STC-309 asserted `tapReenables == 0` on a real take and got 1, on a
  build where the sampler was already off the tap's thread. Two stories fit one number (starvation
  vs. our own disable), so `decideCursorEvent` now names the reason, `stoppingBegan` is set BEFORE
  the disable, disables after it are counted apart (`stats().tapDisabled.afterStop`) and not acted
  on, and `STC_NO_CURSOR_SAMPLER=1` records a control take with no sampler at all. The capture
  grant test prints the counts on success. A `timeout` in that breakdown would be real starvation.
- **`NSCursor.currentSystem` costs 1 ms typical and 41 ms worst per read (measured, STC-309).** Not
  microseconds. Anything on the tap's run loop that can take 41 ms risks `tapDisabledByTimeout`, so
  the cursor sampler has its own thread and `orderedEvents` restores time order at write time. The
  ticket's plan put it on the tap thread for ordering; the measurement overruled the plan.
- **The camera's whole lifecycle was invisible to the user (STC-287).** The complaint was "the PiP
  pops in ~1.9 s, so it reads as if the camera didn't work". Two corrections. The visible blank
  corner is the gap against the FIRST DISPLAY FRAME, not against session zero — the display track
  starts late too, so it is **1.26-1.39 s** measured across five real takes, not 1.9. And the
  pop-in is only the symptom people noticed: the helper had always emitted `camera-started` (with
  the device name), `camera-failed` and `virtual-camera-only`, and **the app subscribed to none of
  them**. `renderer.ts`'s warning handler matched exactly one code and dropped the rest, so a
  camera that could not open looked identical to one that worked, and a camera that opened and
  wrote zero frames (the clamshell case, STC-286's tail) looked identical to no camera at all.
  The gap itself is NOT a bug to fix: the camera opens off the critical path on purpose
  (`startRunning()` blocks and must not delay every `started` reply), and holding a future camera
  frame to fill the corner would violate the settled frame-selection rule. So the fix states the
  three facts instead — opening / live-and-named / failed-with-a-reason while recording, and on
  each take either when the PiP starts or that the camera recorded nothing.
  `_fake-helper.mjs` emits the camera events AFTER `started`, deliberately: a stand-in that
  announced the camera inside `started` could not reproduce the window being complained about.

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
  **It also read the head SHA exactly once, before the poll loop.** Push during the wait and the
  poller kept matching runs against a commit that was no longer the head — found that commit's
  green run, and merged. Hit for real on 2026-08-30 (PR #51) when a doc fix was pushed in the same
  breath as the merge; GitHub's branch protection refused it, which is luck, because this script
  exists FOR repos with no required check and that is exactly where nothing else would catch it.
  A verifier that can merge something other than what it verified is not a verifier. The head is
  now re-read every poll (fail fast, and do not wait out a full CI timeout on a dead SHA) and the
  merge itself passes `--match-head-commit`, which closes the remaining gap server-side.

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

- **The retry is part of the job's worst case, and the clearance test now says so.** #39 wrapped
  the determinism gate in 3 attempts bounded at 10 min each, and the existing clearance test —
  `PRE_GATE + EVAL_SLOTS x EVAL_MS + SEEK_MS = 21.5 min < 30 min cap` — did not model it and stayed
  green while that ONE gate could consume the entire cap before the other three ran. Third time
  this repo has met "a new bound must be checked against every bound already covering the same
  code", and the first two are in this file. `scripts/gate-bounds.mjs`'s `worstCaseJobMs()` now
  models the job per gate INCLUDING `ATTEMPTS`, `ATTEMPT_MS` is 5 min (was 10), and the cap is 45.
  Two assertions the old test could not make: `ATTEMPT_MS > attemptFloorMs()` (`EVAL_MS` + both
  teardown bounds + launch + the 60 s `__ready` wait) — below that, gate-retry's own bound fires
  before the gate can print `ENVIRONMENT:`, `isEnvironmentFailure()` correctly refuses to retry, and
  the retry silently stops working — and the worst case must scale with `ATTEMPTS`.
  **The first draft of that floor was itself 60 s short**, because it omitted the `__ready` wait
  that sits inside every retried attempt, which let `ATTEMPT_MS` sit BELOW the true cost of an
  attempt — the exact failure the assertion existed to prevent. Caught in review, not by the test.
  Worse, the first repair was VACUOUS: raising `ATTEMPT_MS` and the cap left enough slack that
  removing the term again still passed. **Assert composition, not magnitude** — the guards now say
  the floor must ACCOUNT FOR each named bound, and `READY_MS` is checked against the timeout parsed
  out of `gate.mjs` so it cannot drift from what the gate actually waits. All four mutations
  watched failing after that change, not before it.
  What the model does NOT cover is stated in `gate-bounds.mjs`: the three non-retried gates each
  retry their evaluate up to 3x on Playwright's "garbage collected" error, re-entering the 60 s
  readiness wait each time. Counting all of them gives ~80 min, which is too loose to be a bound;
  the structural fix is a per-process bound per gate, like `ATTEMPT_MS` gives the determinism gate.
- **Every gate must tear down through `closeQuietly`, and a test enforces it.** #30 bounded
  teardown in three gates and missed `seek-gate.mjs`, which then did the identical 17.5-minute
  `browser.close()` hang on the handoff PR — failing correctly in 10 s with a full decoder dump
  first, exactly like the original. `gate-bounds.test.ts` now refuses a direct `browser.close()` in
  any gate and requires each to import `closeQuietly`.

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
- **The fourth caller assembled a project outside `parseProject`, exactly as predicted — and CI
  could not see it.** `harness/sink-identity.ts` used a fetched `project.json` VERBATIM and fell
  back to a literal it built itself, with no `pip`. A hand-rolled object cannot know that
  `parseProject` turns the PiP on for a camera take (from its `hasCamera` argument), so every
  camera take with no `project.json` rendered without a PiP and `npm run gate:identity` failed on
  a real 5.6 MB camera track. `harness/main.ts` had the same bypass, benign only because
  `fixtures/basic` has no camera.
  **CI ran the identity gate on the camera-LESS fixture**, which is why nothing caught it. It now
  runs on `fixtures/pip` (224 KB, committed, a real camera track) with `project.json` deliberately
  NOT copied — a take recorded by the app has none until it is edited, so that is the path that
  must be exercised. Proven to discriminate: the same fixture take FAILS on the old code and
  passes on the new. It is a strict superset of the camera-less run, so it costs no job budget.
  `transform/test/trim.test.ts` is now the fifth caller's tripwire.

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

- **`scripts/*.d.mts` are HAND-WRITTEN and nothing compared them to the `.mjs`.** `allowJs` is off,
  so tsc reads the declaration and never looks at the implementation — the two can disagree while
  all three passes stay green. It bit twice in one day: `worstCaseJobMs` gained a parameter and
  `bounded` gained a thunk label, and both stale declarations produced errors. Those errored the
  SAFE way. The dangerous direction is the opposite — a declaration promising MORE than the code
  delivers (a renamed export, a `function` that became a constant) typechecks clean at every call
  site and fails at RUNTIME, in a script that only runs on CI or by hand.
  `transform/test/declaration-drift.test.ts` imports each module for real and checks the declared
  surface exists. It cannot check parameter types; it catches the failure that actually reaches
  runtime. All five scripts are import-safe — two are main-guarded precisely so they can be.

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
- **Every gate carries its own PROCESS bound, and the job's worst case is a SUM, not a model.**
  Only the determinism gate had an outer bound (`ATTEMPT_MS` via `gate-retry`); the other three ran
  unbounded while `worstCaseJobMs()` guessed at their internals. That guess went wrong twice — once
  omitting the retry entirely, once the readiness wait — and on 2026-08-28 an unbounded seek gate
  held a CI job to its cap for 17.5 minutes after failing correctly in 10 seconds. `gate-run.mjs`
  now bounds each gate from `GATE_PROCESS_MS`, so the worst case cannot be under-counted the way a
  model can, and the previously-absorbed GC-retry path is accounted for rather than named in a
  comment. A gate with no declared bound is REFUSED, not silently defaulted.
  The cap rose 30 → 45 → 55 → 65 as the model stopped lying, and that is not a regression: a wedged
  gate now dies at its own 7.5-13 min bound instead of holding the job, so failures got faster while
  the number went up. The cap is a backstop behind four tighter bounds.
- **A bound's own slack will hide a missing term in its floor — assert COMPOSITION, not magnitude.**
  Dropping `GC_RETRIES * READY_MS` from export-gate's floor left all 20 gate-bounds tests green,
  because a 780 s bound clears the reduced floor comfortably. Same shape as #42's vacuous first
  repair, and as a PiP test that passed with the compositor wiring removed because the display frame
  filled that corner anyway. The fix in all three cases was a positive discriminator: name the parts
  and require each, or compare against a control that differs ONLY by the thing under test. Five
  mutations are watched failing in `gate-bounds.test.ts`, including that one.
- **The gates' wedge is the DECODER's synchronous `configure()`, and the checkpoint trail found it
  without any GPU logs.** Run 33384105552 wedged all four gates; every trail stopped at the first
  decoder touch, 391-633 ms after page start — `decodeAll`, `loadSession`, `frameAt(0)`. Not the
  encoder, and not late in a long run.
  The seek gate's own IN-PAGE bound fired there (`the decoder accepted chunks and emitted none`),
  so ITS thread was alive — Mode A, already well diagnosed. The other three ran the full 180 s
  outer bound while their own 60 s in-page flush bound never fired, which is only possible if no JS
  timer could run: blocked inside the SYNCHRONOUS `VideoDecoder.configure()`. Both modes, same job,
  both the decoder.
  This SUPERSEDES "Mode B cannot be diagnosed from inside the page — Chrome's GPU logs are the
  avenue". A console message escapes a blocked renderer when nothing else does, which is the whole
  reason the trail works.
  `configure()` had no `hardwareAcceleration`, so Chromium was free to pick CI's paravirtualized
  video hardware — the class of device STC-259 already measured blocking on first touch from Swift.
  The gates now ask for `prefer-software` (`GATE_DECODER_PREFERENCE`, handed to the page by the
  runner and ECHOED BACK so a failed addInitScript cannot leave the gate quietly testing the
  default). The app never sets it and keeps hardware decode.
  **It did not work, and the echo could not tell you (measured 2026-09-01).** The gates still skip
  post-change and the trail still stops at the first decoder touch 317-406 ms in — the same
  signature. But that echo runs AFTER `bounded(page.evaluate(...))` returns, and a wedge never
  returns, so on exactly the runs it exists for it cannot fire: the conclusion rested on assuming
  `addInitScript` had applied. Same shape as every wrong number in the 2026-08-31 handoff — a
  measurement that could not see what it was being read as evidence about. `harness/decoder.ts`
  now applies the preference and MARKS it, so a wedged run says which decoder it was asking for;
  it is `[gate-mark 1]`, ahead of the first decoder touch, watched firing under
  `STC_GATE_FAULT=wedge:`.
  **CI then wedged on the very run that merged it (33576888543) and settled it.** All four gates
  skipped and every trail carried `decoder preference: prefer-software` ahead of its own first
  decoder touch — 393/466 ms determinism, 531/584 seek, 450/482 export, 348/375 identity. The page
  GOT software decoding and `configure()` blocked anyway, so the hypothesis is dead on evidence
  rather than on assuming `addInitScript` applied. NB that verdict needs no step attribution (the
  run has none): `decoder preference:` is printed only by `harness/decoder.ts`, and the two
  references in its test sit behind a `console.log` spy, so no test can emit it. That file is also the ONE place the runner's value is read — four
  harness entries carried an identical copy of the block, and `main.ts` separately re-read the
  global to echo it, which would have reported `prefer-software` even if `setDecoderPreference`
  had never been called.
  **It changes the pre-encode hash** — 10a05a33 -> bc03e397 on `fixtures/basic`, the same two
  values the rasterization pin produces, because forcing either the decoder or the renderer onto
  the CPU lands in the same state. An earlier draft of this note claimed H.264's bit-exactness made
  that impossible; the decode is bit-exact in YUV, the RGBA that reaches the canvas is not. It is
  survivable only because the gates compare within ONE browser and never against a stored constant.

- **`[gate-mark N]` is numbered per DOCUMENT, not per run — three of the four gates reload.**
  `seek-gate.mjs`, `export-gate.mjs` and `identity-gate.mjs` each `page.reload()` deliberately, to
  settle vite's dep re-optimisation; `gate.mjs` does not. `mark.ts`'s `seq` lives in the page, so a
  reload restarts it, and run 33576888543 duly printed TWO `[gate-mark 1]` lines in exactly those
  three trails — which reads as the same code running twice in one page and is not. Only the
  DRIVER can tell the difference, because noticing it from inside would need the thread that is
  stuck. `attachCheckpointTrail` announces it on `framenavigated`, which commits BEFORE the new
  document's scripts run; `load` and `domcontentloaded` both fire after module evaluation and would
  sort the separator to the wrong side of the marks it explains. Nothing is printed before the
  first mark — a reload with nothing yet collected has no ambiguity to resolve.
  This only became visible when the preference mark gave each load something to emit early; before
  that, the pre-reload document died before reaching any mark. A diagnostic gaining detail is how
  you find out what the old one was not showing you.

- **The gates skip on a large minority of CI runs, ALL FOUR TOGETHER, and that is the number to
  watch.** 60% measured 2026-08-30 over 10 runs, 25-28% measured 2026-09-01 over 20 — different
  run sets, samples too small to separate, and NOT evidence of a trend either way;
  `docs/STC-259-GATE-SKIP-RATE.md`, re-derive with `node scripts/gate-skip-rate.mjs`. In every run
  where one gate skipped all four did, and where one passed all four did — it is a property of the
  JOB (can this machine service a video pipeline right now), not of any gate.
  Healthy, the determinism gate clears A, B and C in **9 s** and the whole job takes 2.7 min.
  Wedged, that one step used to burn **641 s**. The signature is the OUTER bound (`in-page gate run
  did not return within 180000 ms`) plus `browser.close()` hanging its full 30 s: a WEDGED
  renderer, not a slow one, so no in-page JS timer can fire. Mode B — Chrome's GPU logs, not more
  instrumentation inside the page.
  **The retry bought nothing** — all three attempts failed identically at the same bound and 2 and
  3 never succeeded where 1 failed, so `ATTEMPTS` is **1** since 2026-08-30 (worst case 58.8 ->
  44.8 min). Dropping that constant quietly guts two guards, both rewritten to survive it:
  `worstCase >= ATTEMPTS * ATTEMPT_MS` is satisfied at 1 by a model that deleted the term (PROVEN —
  the old form was put back against a mutated model and passed), and `gate-retry`'s
  `toBe(ATTEMPTS)` becomes indistinguishable from the retry loop having been deleted. Assert that
  the model MOVES with the count; drive the loop with an explicit count.

- **A CI log is not one text — scope every verdict to its STEP.** This finding was first published
  as "the determinism gate has not run in 19 consecutive runs, 100% skip". That was WRONG. The
  script searched the whole-job log for `Determinism gate DID NOT RUN`, and
  `transform/test/gate-retry.test.ts` prints that line verbatim into the **Test** step because it
  exercises `announceSkip` for real — so every run that ran the unit tests read as a skipped gate,
  including runs where the gate passed in nine seconds. The same document had already warned that
  `decoder flush did not complete within 60000ms` is a FIXTURE STRING and not a fault; documenting
  a trap is not immunity to it. `gh run view --log` emits `job<TAB>step<TAB>message`, so slice by
  the step column. Step attribution is often ABSENT (`UNKNOWN STEP` for every
  line) — those runs are unmeasurable and must be named and excluded, never folded into the
  denominator. When it is available is NOT understood: measured over 12 runs, everything younger
  than ~200 min had none and everything between 212 and 319 min had it, so it appears hours after
  a run rather than ageing out — but some day-old runs lack it too. A first version of this note
  said it "ages out within a day or two" and advised measuring FRESH runs, which is exactly
  backwards: a just-finished run cannot be measured at all. Wait a few hours. A boundary claim built on the broken method (last pass `cb03ee9`, first skip
  `9df1e27`) had to be RETRACTED, because the runs needed to re-check it had already aged out.

- **"Red means the code" only became true once ALL FOUR gates could say ENVIRONMENT.** #39 gave the
  determinism gate a machine label and the claim was made then; it was 1-of-4 true. The other three
  routed machine faults through `fail()`, so on 2026-08-29 a decoder that accepted 8 chunks and
  emitted none reddened a PR twice through the seek gate — on the PR whose subject was that
  distinction. All four now label a bound firing as ENVIRONMENT.
  The three non-determinism gates SKIP on the first one and are NOT retried: retrying all four at
  3 attempts models to 118 min and would need a ~2 hour cap, against 58.8 min as it stands. The
  cost is stated rather than buried — with the fault near 50%, those gates will skip often, and a
  skipped gate is not a passed gate. If skipping becomes the norm the answer is fixing the decoder,
  not adding attempts.
- **Ask the ERROR whether a bound fired; do not match its text.** `bounded()` tags its own timeouts
  (`e.boundFired`), so a gate with a single catch-all can tell "my bound fired" from "I found a
  wrong answer" structurally. Text patterns survive only for bounds that fire INSIDE the page,
  which reject across the process boundary as plain Errors and cannot carry a property — and that
  list lives once in `gate-bounds.mjs` rather than being reinvented per gate.
  Where a gate ALREADY branches on the distinction, use the branch: `seek-gate`'s
  `stuckOnFirstSeek` is split by `classifyDecoderStall()` on the source's own state — fed,
  configured, no error, nothing out is the machine; never fed, errored, needs-keyframe, or already
  producing is OURS. Labelling the whole branch ENVIRONMENT would let a broken `SeekingFrameSource`
  skip silently, which is the regression-absorbing skip the retry rules exist to prevent.
- **`gate-bounds.mjs` owns every bound; `gate-retry.mjs` imports them.** The reverse — bounds
  importing the retry's constants — was right while the retry was the only runner, and became a
  cycle the moment every gate got a bound. ESM resolves that cycle by hanging on the top-level
  await and exiting 13, not by failing clearly. One direction: the runner depends on the bounds,
  the bounds depend on nothing.
- **You cannot bound an append in the product, and STC-259 step 3's answer is that you must not
  try.** The ticket asked whether `Capture.swift` and `CameraCapture.swift` need the append bound
  the writer-gate harness now has. They do not, and the reason is structural rather than a
  judgement call: `WriterGate.append` holds its lock ACROSS the append — that IS the STC-254 fix —
  so a bound there would have to abandon a thread still holding that lock, and
  `closeAndMarkFinished()` would go on blocking forever exactly as before. Nothing is bought at
  the append; the wedge reaches the lock whatever the append does. The containing bound belongs
  one layer out, at teardown, and both files already had one (`CaptureSession.stopTimeoutSeconds`
  20 s, `CameraCapture.stopTimeoutSeconds` 10 s, each answering exactly once). A wedged first
  append therefore costs a take its finalised mp4 and answers `<reason>-timeout` with a
  `stopWarning`; it cannot leave the app holding a recording it is unable to end. The appends also
  run OUTSIDE both objects' own `lock`, so `stats()`, `track()` and `writeSidecars()` still work
  while one is wedged — the timeout path can still produce a complete answer.
  What was actually missing was not a bound but a comparison: those two numbers and the client's
  30 s `DEFAULT_REQUEST_TIMEOUT_MS` are three constants in two languages, and the only thing
  relating them was a comment. `start` got a clearance test after STC-258 bit; `stop` never did.
  `helper/test/stop-bounds.test.ts` asserts the chain, and the camera-shorter-than-display
  ordering is load-bearing, not incidental: `CaptureSession.stop()` waits on a DispatchGroup the
  camera teardown is entered into, so reversing them makes the display side report
  `<reason>-timeout` for a camera that was about to answer cleanly — a diagnostic that lies.

- **A harness gets a DEADLINE handed down by its runner, not a sum of its own bounds.** Adding the
  append bound would have made the writer-gate harness's worst case 15+15+15 = exactly
  HARNESS_RUN_MS, which is the "inner bound set equal to the outer one" trap already in this file.
  A summed model was the alternative and it rots — it had already rotted twice for the gates. So
  `_swift-harness.ts` now hands every harness `STC_HARNESS_DEADLINE_MS` (= `runMs` minus a
  5 s exit margin), `bounded()` CLAMPS each wait to the budget remaining, and a watchdog thread
  fires at the deadline naming the last checkpoint reached. The runner's mute "did not finish
  within" kill — the shape of all five STC-259 sightings — is now unreachable in principle rather
  than by arithmetic. The harness REFUSES to run without being handed the value, and that refusal
  deliberately does not say `ENVIRONMENT:`, so a wiring mistake cannot be retried three times and
  announced as a skip.
  **The race loop's 120 appends stay inline and individually unbounded, on purpose.** The race is
  between the appending thread and the teardown thread; wrapping the append would insert a third
  thread and a dispatch of unknown latency between them — the one edit that could quietly stop
  this harness reproducing STC-254 while still passing every assertion. The watchdog covers them
  instead. Verified by mutation, not by argument: with the lock-across-append removed, the harness
  still dies SIGSEGV in race iteration 0, three runs out of three.
  **`HARNESS_RUN_MS - deadline >= HARNESS_EXIT_MARGIN_MS` is a TAUTOLOGY** while the deadline is
  defined as that subtraction — it stays green with the margin set to zero, at which point the
  harness's explanation always loses the race. Same shape as #42's vacuous repair and the PiP test
  that passed with the compositor removed. The falsifiable version compares the margin against
  what it must COVER: 26 ms of measured overshoot (runner-observed process lifetime minus the
  deadline handed in — spawn, Swift runtime init, print and `_exit`; worst of 8 runs) times a
  stated 20x CI allowance. Five mutations watched failing before any of this was believed.

- **The camera-to-display sync number is 65 ms, and `scratch/avsync.cjs` is NOT how you get it.**
  That script measures camera-to-MIC from a clap and needs a `mic.wav` this project does not
  produce; a handoff pointed at it for this measurement and was wrong. The camera faces the user,
  so the shared event is a full-screen FLASH — recorded directly in `display.mp4`, seen as
  reflected room light in `camera.mp4`, both on the same mach clock.
  `scripts/flash-for-sync.mjs` while capturing, then `scripts/measure-camera-sync.mjs <take>`.
  Measured 2026-08-29: FaceTime HD at 30 fps lags a 4K display track by 65 ms, r=0.895. The
  resolution floor is the camera's own frame interval (33.4 ms), so it is 65 +/- ~33, not 65.0.
- **Correlate the whole signal; do not pair edges.** The first version of the sync measurement
  found 5 luminance steps in the display and 1 in the camera, paired them by index and reported
  **-1233 ms** — the camera seeing a flash before the screen showed it, which is not a measurement
  but a bug with a decimal point. Auto-exposure ramps rather than steps, and one spurious
  transition shifts every later pair. Cross-correlation survives different frame rates, different
  brightness scales and an extra transition, and it reports how far its peak stands above
  unrelated lags so a weak answer can be refused instead of printed.
- **Screen Recording TCC for the DEV app depends on how it was launched, and I got this wrong.**
  Driving Electron from Playwright, capture is denied and no entry ever appears in System Settings:
  the responsible process is the launching shell, not `Electron.app`, so there is nothing for the
  user to grant. Launched normally with `npm run app:start`, macOS attributes the request to
  Electron, prompts, and the grant sticks — verified 2026-08-30 by recording a real camera take
  from the app. I told the user granting Electron "wouldn't reliably help"; that was true of the
  automated path only and wrong as stated.
  The dev `Electron.app` is ad-hoc signed (`TeamIdentifier=not set`), so per the signing trap above
  the grant is fragile across reinstalls. `tools/test-host` remains the stable-identity bundle for
  permission work.

- **A macOS 14+ class the 13.3 SDK cannot name is still callable — by name, through the runtime
  (STC-289).** `SCScreenshotManager` has no header in the SDK `helper/build.sh` compiles against, and
  the ticket's first note concluded that meant waiting for Xcode. It does not: the class exists on
  the running OS, `NSClassFromString` finds it, and `class_getClassMethod` + `unsafeBitCast` to a
  `@convention(c)` type calls the one class method with a real block — `ScreenshotAPI` in
  `Still.swift`. It is the same family as the `captureResolution` KVC in `Capture.swift`, one step
  further. The cost is stated where the code is: a misspelt selector is `still-unsupported` at
  RUNTIME, not a compile error, so `ScreenshotAPI.available` checks class AND selector before any
  request, and `still.grant.test.ts` is the only thing that proves the call. The 14+ configuration
  knobs a still needs (`ignoreShadowsSingleWindow`, `shouldBeOpaque`) go through KVC guarded by
  `responds(to:)`, and the reply reports whether each was taken rather than assuming.
  NB `captureResolution` in `Capture.swift` is set to 3; `SCCaptureResolutionType` is
  automatic 0 / best 1 / nominal 2. Explicit width/height govern, so it has never mattered — the
  still path sets 1. Not changed in the recording path here; it is not this ticket's.
