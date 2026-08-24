# Phase 2 — finish the product loop

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

## Open question to settle FIRST

**Is export fast enough to run in the app?** The measured ~55 ms/frame at 4K is *gate* cost: it
includes a 33 MB `getImageData` and a SHA-256 per frame, needed only to compare sinks. A real
export encodes straight from the canvas. Until that is measured we do not know whether UI export
is roughly realtime or ten times slower than realtime, and that changes what the UI must promise
(a progress bar vs a background job with notification).

## Increments

0. **Throughput measurement** — export with and without the per-frame hash, on a real take.
   Decides increment 3's UX. No feature work; a number.
1. **Take library** — list recordings with duration, size, date, resolution, event count, read
   from the sidecars. Gate: a take recorded by the app appears with correct metadata, and a
   directory that is not a valid session is reported as such rather than crashing the list.
2. **Seeking frame source** — the scrub-safe decoder. Gate: forward, backward, repeated and
   out-of-range seeks all terminate and return the frame `frameIndexAt` names; buffered frames
   stay bounded under a sustained synthetic scrub; no `VideoFrame` is leaked.
3. **Preview player** — canvas + transport, every frame from `render()` and the shared
   compositor. **Gate: preview at time `t` is byte-identical to export at time `t`, measured in
   the app.** This is the increment-0 gate re-run against the real product rather than a harness,
   and it is the one that proves the two-sink contract actually holds where it matters.
4. **Export from the UI** — with progress and cancellation. Gate: a UI export and a CLI export of
   the same take produce identical pre-encode hashes.
5. **Take management** — reveal in Finder, delete with confirmation, rename.

## Non-goals for phase 2

Trimming and editing (the `project` schema has room; the UI does not), real cursor artwork,
camera PiP, audio of any kind, uploads, anything cross-platform. Recording remains
start/stop-only — no pause.

## Risks

| risk | approach |
|---|---|
| **Scrubbing crashes the renderer** | PHASE-0 §4b's three failure modes are known and specific; increment 2 exists to solve them in isolation, with its own gate, before any UI depends on it |
| **Export too slow to sit in the UI** | measured in increment 0, before the UX is designed around an assumption |
| **Preview and export silently diverge** | increment 3's gate compares them byte-for-byte in the app. A cursor drawn in the wrong place passes every structural check, so the human check from phase 1 stays part of the loop |
| **A take is deleted by accident** | destructive actions confirm, and delete moves to Trash rather than unlinking |
