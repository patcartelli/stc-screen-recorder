# STC Screen Recorder — brief and locked decisions

**Status: DRAFT for the author to correct (2026-09-02).** Every row below carries a status the
author has not yet confirmed. Rows marked *confirm* are the ones where the code and the stated
decision disagree and only the author can say which is right. Once corrected, this file is the
project's conventions document: `CLAUDE.md` is the handoff log and the trap index, `PHASE-*.md`
are the phase plans, and this is the thing they are all measured against.

Statuses used: **holds** (decided and the code does it), **not yet built** (decided, no code, no
plan in the tree), **drifted, deliberate** (the code differs for a stated reason), **confirm**
(the code differs and no reason is recorded).

## The product

A macOS screen recorder for a single person making a recording of their own screen, with their
camera in a corner and a cursor that is drawn, not captured. Recording is capture only; every
decision about how the take *looks* is an edit made afterwards, in a document, and rendered by one
pure function that preview and export both call. The recorder must never lose a take it has
started, and must never let a take that is missing something look like a take that is not.

## Locked decisions

### Determinism and the transform

| decision | status | evidence |
|---|---|---|
| `render(project, session, t) → FrameState` is a pure function: no wall clock, no decoder scheduling, no live helper stats, no current display state. Preview and export are two sinks that call it with different `t` sequences. One implementation; sinks may not fork it | **holds** | `transform/src/render.ts`; `preview.ts` and `export.ts` both call `render` + `composite`; `gate:identity` compares them shuffled vs ascending; `test:slow` compares the app's export against the CLI's |
| Fixed simulation step, 120 Hz. All times inside the transform are integer nanoseconds or integer ticks. 60 fps export samples every other tick | **holds** | `transform/src/time.ts`; `tickOf`/`tickTimeNs` are the only conversions |
| Cursor state is a function of tick `n`, never of render-call count. `stateAt(n)` is identical stepped or sought | **holds** | `transform/src/cursor.ts`: checkpoints *are* the stepped state, so a seek replays the exact float sequence |
| Frame selection at `t`: the source frame with the greatest PTS ≤ `t`; hold, never interpolate; per track | **holds** | `frameIndexAt`; camera track bounded by `anchors.camera.{firstFramePtsNs, lastFramePtsNs + frameIntervalNs}` so a dead camera does not freeze a face on screen |
| "Export ≠ preview" is the defining bug class. Pre-encode RGBA is what the gates hash; encoded bytes are never compared | **holds** | `scripts/gate*.mjs`; the hash is compared only within one browser and one raster backend |
| Anything that changes rendered pixels lives in the project document or is a versioned constant | **confirm** | `OMEGA` and `CHECKPOINT_INTERVAL` in `cursor.ts` are neither recorded in the project nor versioned; a re-render after an easing change is unexplainable (review P5) |

### Data model

| decision | status | evidence |
|---|---|---|
| `recording.json` is a **segments array** from day one; each segment's media is a **replaceable identity** (stable id, not path or index), so re-take can swap media, keep the edit, regenerate auto-zoom | **not yet built** | today: one directory per take; `anchors.json` names media by filename (`files.display`, `files.camera`); `project.json` references no media at all; the take's identity is its directory name. Review §7 puts this first among schema work because every day of editing on the current shape is migration cost |
| Sidecars are versioned; readers accept v1..vN, writers emit latest | **holds** | `schema/anchors-{1,2}`, `project-{1,2}`, `events-1`; `loadSession`, `parseProject`, `takes.ts` each accept both |
| `project.json` is the edit document (output size, cursor style, PiP geometry, trim). The take's own camera decides whether a PiP is on by default | **holds** | `transform/src/trim.ts` `parseProject` / `defaultProject`; there is exactly one parser and every caller goes through it |
| Times in sidecars are session-relative integer ns; `t0Ns` is a decimal string because boot-relative ns can exceed 2^53 | **holds** | `schema/anchors-2`; `AnchorsDoc.swift` |
| The camera block is **absent** when no camera was requested; `present:false` means requested and yielded nothing | **confirm** | the schema says this; `AnchorsDoc.swift` always writes the block, so every display-only take is labelled a camera failure in the library (review finding 4 / P2) |

### Capture

| decision | status | evidence |
|---|---|---|
| All capture lives in the Swift helper — display, cursor events, camera **and mic** — so everything shares one mach-time clock family. No capture or timestamping on the Electron/JS side | **holds for display + camera; mic not yet built** | `helper/src/Capture.swift`, `CameraCapture.swift`; `getUserMedia` explicitly rejected (camera spec). Mic: deferred since phase 1; phase 0 measured its clock (+1.8 ms to camera) and found the Bluetooth trap |
| Clock: `mach_timebase_info` at helper start, written to anchors. `displayTime` is mach ticks and is converted; `CGEvent.timestamp` and camera PTS are already ns and are **not** | **holds** | `CaptureDecisions.swift` `machToNs`; `CameraCapture.ptsNs` |
| ≤ 3840×2160, H.264, hardware encode only; VFR at capture, CFR at export | **holds** | `CaptureGeometry.swift`; writer settings; `export.ts` |
| The helper is a long-running child of Electron, so it inherits the app's TCC identity | **holds** | `app/src/main.ts`, `supervisor.ts` |
| Two IPC channels: fd3 reliable with sequence numbers; stdout lossy drop-oldest telemetry that can never back-pressure capture | **holds, measured** | `Protocol.swift`, `Ring.swift`; STC-249 |
| A display reconfiguration stops the take cleanly rather than rebuilding mid-file | **holds, deliberate** | `AVAssetWriter` cannot change dimensions mid-file; also the only correct answer while a display's global origin can move mid-take (review P7) |
| Camera: opt-in toggle, default off, sticky; opened at start and closed at stop, never held idle; 1280×720; opened off the critical path | **holds** | camera spec; `settings.ts`; `startCameraAsync` |
| Never take the default audio input blind; a Bluetooth mic is refused in favour of any wired/USB device | **decided in phase 0, not yet exercised** | PHASE-0 §2a; applies when mic capture lands |
| Every request to the helper is answered exactly once, by whichever path gets there first, and every wait has a bound and a reason | **holds, one gap** | `finishStart`, `stop`'s `finishUp`, `withTimeout`; the gap is a `start` that completes after a `stop` (review P3) |

### Cursor

| decision | status | evidence |
|---|---|---|
| Rule 2: the cursor is **never only in the video**. Telemetry is always captured, with no toggle | **holds in code; confirm the policy** | no code path or setting disables the tap. The one thing that does is a missing Input Monitoring grant (`tapCreate` returns nil): the helper warns, records video only, and since #64 the app says so loudly. **Open:** should a take without a tap refuse to start instead of warning? The brief's wording says telemetry is not optional |
| Pixel exclusion (`showsCursor = false`) is the default | **holds** | `Capture.swift` |
| Baking in the system cursor is an opt-in that disables cursor styling for that take | **not yet built** | no setting, no field in `project`, no branch in the compositor |
| The cursor is drawn from events by the transform; artwork is a placeholder circle | **holds** | `compositor.ts`; real pointer artwork is listed as a known limit |

### Editing

| decision | status | evidence |
|---|---|---|
| Editing is non-destructive. Source media is never mutated | **holds; boundary hardened in #64** | trim is a `project.json` field; exports are written beside the take; delete goes to the Trash; `export:write` now refuses the take's own filenames |
| Auto-zoom is two stages on two signals: **clicks decide when** (300 ms pre / 2500 ms post / 2500 ms merge); **movement decides where** (greedy dead-zone clustering at 0.5 / 0.7 of the visible viewport). They must not be entangled in one pass | **not yet built** | no code. When built: two pure functions in `transform/src` with fixture tests, one per signal, and the compositor consumes their output. Depends on segments and on cursor telemetry being a hard requirement |
| Trim is in/out points in session ns, clamped to the 60 fps grid | **holds** | `trim.ts` |

### Platform and rendering

| decision | status | evidence |
|---|---|---|
| macOS 26 floor; no compatibility scaffolding for older targets | **drifted, deliberate — by toolchain** | no Xcode on the dev machine: `swiftc` 5.8 with the 13.3 SDK, `helper/build.sh` targets macOS 13.0, and `captureResolution` is reached by KVC (`Capture.swift`) because the 13.3 headers lack it. That KVC and the 13.0 target are exactly the scaffolding to delete when Xcode lands. **Open:** when |
| Compositing in WebGPU/WGSL; no GLSL fallback | **not yet built** | Canvas 2D (`compositor.ts`, 47 lines). There is no GLSL either, so nothing to remove. The pre-encode hash will change when this lands; survivable because the gates compare within one backend |
| Electron shell; renderer is sandboxed and never sees a path or node | **holds** | `preload.ts` enumerates every channel; `tsconfig.browser.json` makes `process` a type error in the renderer |
| Signing: a stable identity (self-signed dev cert now, Developer ID later) because ad-hoc revokes TCC on every rebuild | **holds** | PHASE-1 → Signing |

### UI

| decision | status | evidence |
|---|---|---|
| SolidJS; signals, not effects-as-glue. `createEffect` used to synchronise derivable state is a defect | **not yet built** | `app/src/renderer.ts` is ~660 lines of vanilla DOM with module-level `let` state. No framework dependency. Review §7 puts this after the editor exists, because a new UI on an editor that does not exist has nothing to show |
| Every failure the helper reports reaches the user; a warning on the reliable channel is never dropped by the UI | **holds since #64** | `renderer.ts` warning handler |
| Takes are listed even when broken, with the reason; a corrupt sidecar costs the label, never the recording | **holds** | `takes.ts` |

## Settled by measurement — do not relitigate

The numbers behind the rows above, each measured on real hardware. Full detail in
`docs/PHASE-0-FINDINGS.md` and `PHASE-1.md` → "Settled by phase 0".

- Above 4K, hardware H.264 encode drops from 0.81 to 0.25 Gpx/s (software fallback); Chrome's decoder shares the ceiling.
- CFR-by-repeat at capture spent 82% of a loaded encoder on duplicates and dropped 60% of real frames.
- `prefer-software` encode truncated at 19% of frames at 4K60; it is not a fallback.
- mach ticks are 41.667 ns on Apple Silicon and 1 ns on Intel; `CGEvent.timestamp` offset to the display clock is 0 ms, drift 0.0000 ms.
- Camera lags the display by 65 ms (±33, the camera's own frame interval); camera-to-mic +1.8 ms median.
- A cold USB camera can take 2.2 s to open, which is why it opens off the start path.
- Export runs at 1.52× realtime at 4K on GPU raster; preview holds the whole file in memory, ~15 min of 4K is the ceiling.
- A `VideoDecoder` must be driven with one in-flight request, frames closed in the output callback, and never reset on an empty output queue.

## Conventions the code follows

Stated as rules. Corrected wording welcome; the intent is what the review found the code already doing.

1. **Boundary.** The helper owns every device and every timestamp; main owns every path, every preference and the helper process; the renderer owns pixels and never sees a path, a file or node. Helper↔main is JSON lines (fd3 reliable with `seq`, stdout lossy); main↔renderer is bytes on channels enumerated once in `preload.ts`.
2. **Pure core vs. sink.** If it can be written as a function of data already read, it goes in `transform/src/` (or the Swift equivalents: `CaptureDecisions`, `CaptureGeometry`, `AnchorsDoc`, `Ring`, `WriterGate`) and is tested with fixtures. Only reading, writing, scheduling and waiting stay in the sink or the callback.
3. **Naming.** `<module>.ts` in `src/`, `<module>.test.ts` in the sibling `test/`. The suffix states the runtime requirement: `.test.ts` runs anywhere; `.e2e.test.ts` needs Electron and runs serialised; `.slow.test.ts` needs minutes; `.grant.test.ts` needs a TCC grant and is a separate file, never a skip. `_`-prefixed files are test support. Fixtures are directories named for what they exercise.
4. **Every wait has a bound and a reason** (`withTimeout(p, ms, what)`). Every bound has a fault injector and a test that watched it fire. A bound that fires says whether the machine or the code was at fault.
5. **One value, one place.** Where two languages force a copy, a test pins the copies together.
6. **Reported, never silently skipped.** Invalid takes are listed with a reason; dropped stats are counted; a skipped gate prints an annotation; a request is answered exactly once.
7. **A test seam must be a world the fake can be true in.** The stand-in helper speaks the control plane and can actually be recording; it never claims anything about capture.
8. **A new test is watched failing before it is believed.** Mutation-check the guard, not just the happy path.
9. **The comment states the failure the code prevents**, with date and ticket. `CLAUDE.md` is the index of those traps.

## Non-goals and deferrals

Multiple cameras, camera-only recording, system audio, HDR/P3, uploads, anything cross-platform,
pause during recording, display hot-swap rebuild mid-file, N-minute segmentation, device-loss
recovery, fault-injection soak. Each of these was deferred explicitly in a phase plan; none is a
decision against, only a decision about order.

## Open questions for the author

1. **Xcode and the macOS 26 floor.** The helper builds against the 13.3 SDK because there is no Xcode. Is the floor a target for when Xcode lands, or a requirement now?
2. **Cursor telemetry as a hard requirement.** A missing Input Monitoring grant currently warns and records video only. Refuse to start instead?
3. **`recording.json` vs `project-3`.** Is `recording.json` a new file beside `anchors`/`events`/`project`, or the successor to `project.json`? The segments array needs an owner.
4. **WebGPU and SolidJS timing.** Both are decided; neither has a phase. Review §7 orders them after the segments schema and auto-zoom. Agree?
5. **Transform versioning.** Should easing constants live in `project` (editable per take) or as a stamped transform version (global, recorded)?

## Where to read next

- `CLAUDE.md` — handoff log, current status table, and every trap found so far.
- `PHASE-1.md`, `PHASE-2.md`, `docs/superpowers/specs/2026-08-26-camera-pip-design.md` — the phase plans as shipped.
- `docs/review-2026-09-02.md` — the review this file was drafted from: findings, drift, proposals, and what is next in order.
