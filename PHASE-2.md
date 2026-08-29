# Phase 2 — finish the product loop  ✅ COMPLETE

Record → preview → export, all inside the app. Take library, scrub-safe preview player, export
with progress and cancellation, and labelling/deletion. 121 tests; five gates
(`gate`, `gate:export`, `gate:seek`, `gate:identity`, plus `test:slow` for
cross-implementation export identity).

**Goal:** make the thing usable by a person. Phase 1 proved record → composite → export works;
the app can only do the first of those. Export exists solely as a CLI script that spins up Vite,
Playwright and Chrome. Nobody can watch their own recording.

Nothing new is captured in this phase. Camera PiP, microphone, system audio, mid-recording
display rebuild, segmentation, device-loss recovery and the soak harness all stay deferred —
hardening or extending a product nobody can use yet is the wrong order.

Full phase-0 findings: [docs/PHASE-0-FINDINGS.md](docs/PHASE-0-FINDINGS.md).
Phase 1 as shipped: [PHASE-1.md](PHASE-1.md).

## Inherited, still binding

| decision | why |
|---|---|
| `render(project, session, t) → FrameState` is pure; preview and export are two SINKS | the contract phase 1 was built around. Phase 2 is where it finally earns its keep: until now both sinks lived in a test harness, and the app had neither |
| frame selection: greatest PTS ≤ `t`, hold, never interpolate | same rule in both sinks or they diverge whenever the VFR and CFR grids are out of phase, which is continuously |
| all times integer nanoseconds, session-relative | events.json and display.mp4's sample table share one origin; `anchors.capture.firstFrameNs` is the exact value a recovered offset is checked against |
| capture ≤3840×2160 | above 4K, hardware encode AND Chrome's decoder both fall off a cliff |
| `project` is the edit document | already versioned and schema'd; it is where any future trim/PiP settings live |

## The shape of the work

```
Take library  ──►  Preview player  ──►  Export
   (list)          (seek + play)      (progress, cancel)
                        │                   │
                        └──── render() ─────┘
                         one transform, two sinks
```

The interesting engineering is **seeking**. `ForwardFrameSource` is forward-only by design and
suits export exactly; a scrub bar is the opposite access pattern. PHASE-0 §4b was written from a
harness that crashed the tab repeatedly doing this, and every lesson applies:

1. exactly one in-flight decode request, with a coalescing queue that keeps only the most
   recently requested frame — a slider drag fires dozens of events and overlapping decodes
   against one decoder leak 4K frames until the tab dies
2. never reset on overshoot inside a batched-flush loop — that was an infinite loop allocating a
   fresh `VideoDecoder` every spin
3. close `VideoFrame`s in the output callback, retaining at most one — ~30 MB each at 6K

## Settled by increment 0 — export throughput

Measured on a real 3840×2160 take (900 output frames):

| path | ms/frame | note |
|---|---|---|
| gate (software raster + hash) | 52.2 | what phase 1 measured; hashing alone is 79% of it |
| export (software raster, no hash) | 24.7 | |
| **export (GPU raster, no hash)** | **11.0** | **1.52× realtime — a 5-minute take exports in 3.3 min** |

Two things this settles:

- **A progress bar is honest.** Export is faster than realtime, so increment 4 can show progress
  rather than dispatching a background job. It is still minutes for a long take, so it must be
  cancellable and must not block the UI.
- **The raster backend is free.** `willReadFrequently: true` forces software rasterisation and was
  over half the export cost, but it exists only so the gate can read pixels back. Both backends
  were checked and are individually deterministic **and produce byte-identical output**
  (`cda78486efab82e40b4ee728…` from both), so the sink-identity gate remains valid whichever is
  used and the fast path carries no correctness risk. Had they disagreed, the gate would have been
  verifying a rendering path that no export actually uses.

## Increments

0. **Throughput measurement** *(done — see "Settled by increment 0" above)* — export with and
   without the per-frame hash, on a real take. Decides increment 4's UX. No feature work; a number.
1. **Take library** *(done)* — list recordings with duration, size, date, resolution, event count,
   read from the sidecars. Gate: a take recorded by the app appears with correct metadata, and a
   directory that is not a valid session is reported as such rather than crashing the list.
2. **Seeking frame source** *(done — `npm run gate:seek`)* — the scrub-safe decoder. Gate:
   forward, backward, repeated and out-of-range seeks all terminate and return the frame
   `frameIndexAt` names; buffered frames stay bounded under a sustained synthetic scrub; no
   `VideoFrame` is leaked. Verification pixel-probes the 12-bit index block row that
   `fixtures/gen-display.swift` draws into every frame, so a seek proves it returned the frame
   asked for rather than a plausible neighbour.
3. **Preview player** *(done — `npm run gate:identity`)* — canvas + transport, every frame from
   `render()` and the shared compositor. Gate: 60 sampled `t`, export visiting them ascending and
   preview visiting them **shuffled** (a scrub is not a playthrough), 0 mismatches. Plus three
   E2E tests driving the real app: a take renders actual pixels rather than an empty canvas,
   scrubbing changes the frame, and pause really pauses.
4. **Export from the UI** *(done)* — with progress and cancellation. Gate: a UI export and a CLI
   export of the same take produce identical pre-encode hashes (`npm run test:slow` — it runs one
   UI export and two CLI exports, so it takes minutes and is not in `npm test`). Export is ONE
   implementation in `transform/src/export.ts` called by both the app and the gates; a second copy
   would make that gate compare two programs rather than verify one. Each export writes a manifest
   recording its pre-encode hash — an export nobody can verify is an export nobody can trust.
5. **Take management** *(done)* — reveal in Finder, delete with confirmation, rename.

   "Rename" became **labelling**, deliberately. The directory name is a timestamp and is both the
   take's identity and the sort key; renaming it would scramble chronological order, break an open
   preview, and invalidate paths already handed out for exports. A `take.json` sidecar carries the
   friendly name, the timestamp stays visible, and a corrupt sidecar costs the label rather than
   the recording.

   Delete confirms and then calls `shell.trashItem` — it never unlinks. The gate proves the take is
   in the Trash rather than merely gone, which is a different claim: "it vanished" is also what
   `rm -rf` looks like.

## Non-goals for phase 2

Trimming and editing (the `project` schema has room; the UI does not), real cursor artwork,
camera PiP, audio of any kind, uploads, anything cross-platform. Recording remains
start/stop-only — no pause.

## Known limits (measured)

| | |
|---|---|
| preview memory | 458 MB take → +548 MB renderer RSS (~1.2x). A ~15-minute 4K take is the practical ceiling. |
| preview memory, PiP | see "A second decoder" below — measured 2026-08-27 |
| export speed | 11.0 ms/frame at 4K = 1.52x realtime. A 5-minute take exports in ~3.3 min. |
| cursor | a placeholder circle, not real pointer artwork |

## Two concurrent H.264 encodes — measured 2026-08-27

The camera PiP design (STC-232) listed this as an open risk: nothing had ever
measured what a second hardware encode costs the display track. One 15 s take
with both running, on this machine, `tools/test-host --camera`:

| | |
|---|---|
| display | 3840x2160, **862 frames, 0 dropped, 0 non-monotonic**, 56.6 fps avg, 23.1 MB |
| camera | Elgato Facecam 4K [USB2] at 1280x720, 16.67 ms interval (60.0 fps), 14.7 MB |
| camera track | first frame 0.604 s, last 15.220 s, against a 15.381 s session |

**The display track lost nothing measurable.** Zero dropped and zero
non-monotonic frames is the same result the display-only smoke test produced,
so a 720p second encode does not visibly tax a 4K60 capture on this hardware.

Two caveats worth keeping with the numbers. This is a single 15 s take, not a
soak — the increment-5 smoke test should repeat it at five minutes, which is
where the display-only baseline (9311 frames, 0 dropped, peak 60.0 fps) was
established. And it is one machine with a hardware encoder; CI runs a
*paravirtualised* encoder shared with other tenants (see STC-259), where the
answer may differ entirely.

**Camera open is slower than the design spec assumes.** Phase 0's figure is a
~1035 ms warm-up. Measured here: a cold Elgato Facecam 4K on USB2 took
**2.246 s merely to open** — before any warm-up — while a warm one delivered
its first frame at 604 ms. That spread is the reason the camera is opened off
the critical path rather than before `start` is answered; inline, every
`started` reply would have been 2.2 s late on a cold device.

## Risks

| risk | approach |
|---|---|
| **Scrubbing crashes the renderer** | PHASE-0 §4b's three failure modes are known and specific; increment 2 exists to solve them in isolation, with its own gate, before any UI depends on it |
| **Export too slow to sit in the UI** | measured in increment 0, before the UX is designed around an assumption |
| **Preview and export silently diverge** | increment 3's gate compares them byte-for-byte in the app. A cursor drawn in the wrong place passes every structural check, so the human check from phase 1 stays part of the loop |
| **A take is deleted by accident** | destructive actions confirm, and delete moves to Trash rather than unlinking |

## A second decoder's cost to preview — measured 2026-08-27

The camera PiP design listed this as an open risk and guessed "a 720p camera
track adds ~10-15% to renderer RSS". That guess is **not supported**, and the
reason matters more than the number.

`node scripts/measure-preview-memory.mjs <takeDir>` is the harness — committed,
because the PHASE-2 figure above was measured ad hoc and could not be re-run
when a second decoder arrived. It stages the take twice, once with the camera
stripped (and `anchors.camera.present` cleared, since `loadSession` refuses a
claimed camera with no file), and reads renderer RSS via `app.getAppMetrics()`.

On a 15 s 4K take with an Elgato Facecam at 1280x720:

| | files | renderer RSS | growth |
|---|---|---|---|
| display only | 9 MB | 118 -> 169 MB | +51 MB |
| display + camera | 24 MB | 118 -> 232 MB | +114 MB |

The camera track cost **+63 MB**. As a percentage that is +124%, and quoting
that figure alone would be misleading twice over:

1. **`camera.mp4` is 1.7x the size of `display.mp4` on this take** (15 MB vs
   9 MB). A 720p60 camera is not automatically small next to 4K: the display
   track is a mostly-static screen and compresses far better than a moving face.
   The spec's estimate assumed a display track that dwarfs the camera; on short
   takes it does not.
2. **Ratios are regime-dependent.** PHASE-2's ~1.2x came from a 458 MB take,
   where the file dominates. At 24 MB the fixed costs dominate instead — decoder
   buffers plus a decoded 4K frame at ~30 MB — which is why display-only reads
   as 5.7x its file here and 1.2x there. The two numbers are not comparable.

**Quote the absolute growth, not the multiple.** And STC-251's ~15-minute 4K
ceiling is a LONG-take question that this short take does not answer: the
camera's contribution there is still unmeasured, and re-running this harness on
a long take is the way to settle it rather than extrapolating from +63 MB.

## Camera-to-display sync — MEASURED 2026-08-29

The camera PiP design asks for a millisecond figure, not "looks in sync". It was
confirmed by eye on 2026-08-28; this is the number.

**Camera lags the display by 65 ms** (cross-correlation r=0.895, margin 0.255
over unrelated lags), on a 22 s take: `FaceTime HD Camera` at 30.0 fps against a
3840x2160 display track at 57.1 fps.

### Method

One physical event visible in both tracks. The camera faces the user and cannot
see the screen, but a full-screen white flash changes room and face illumination
enough to register — `display.mp4` records the flash directly, `camera.mp4` sees
it reflected. Both tracks carry session-relative ns from the same mach clock, so
the gap between them IS the camera's latency, with no extra reference needed.

- `node scripts/flash-for-sync.mjs 4000` while capturing
- `node scripts/measure-camera-sync.mjs <takeDir>`

NOT `scratch/avsync.cjs` — that measures camera-to-MIC from a clap and needs a
`mic.wav` this project does not produce (audio is deferred, STC-233/234). An
earlier handoff pointed at it for this measurement; that pointer was wrong.

### What the number does and does not cover

- **One take, one camera, one machine.** A FaceTime HD at 30 fps. An Elgato
  Facecam at 60 fps would very likely differ, and USB2 adds its own latency.
- **The resolution floor is 33.4 ms** — the camera's own frame interval. A 30 fps
  camera cannot locate an event finer than one frame, so 65 ms is 65 +/- ~33, not
  65.0.
- **Edge-pairing was tried first and was WRONG.** It found 5 steps in the display
  and 1 in the camera, paired them by index, and reported -1233 ms — the camera
  seeing a flash before the screen showed it. Auto-exposure ramps rather than
  steps, and one spurious transition shifts every later pair. Correlation uses
  the whole signal instead of chosen points, which is why it survives different
  frame rates, different brightness scales and an extra transition.
- **The tool refuses rather than guessing.** Verified on a take recorded without
  flashes: luma swing 4.5 against a threshold of 20, so it reports NO FLASH
  instead of correlating two noise floors. It also refuses when the correlation
  peak does not clear unrelated lags by 0.15.
