# STC-309 — helper emits cursor-shape events: what to run on the Mac

Written on a Linux session that cannot run `swiftc`, so **every Swift line in
this change is unverified until the first build**. The order below is the
ticket's: the spike decides whether the mechanism works, the pure decision is
tested without hardware, the sampler is checked against the tap, the format
flips, and a human watches a take.

## 0. Build

```
helper/build.sh
tools/test-host/build.sh
npm run typecheck        # passed on Linux
npm test                 # decisions harness + cursor-shape-names + ipc cursor-probe cases
```

If `swiftc` rejects anything, the likely spots are `helper/src/CursorShape.swift`
(CoreFoundation timer + `NSCursor` API names) and the two harness cases in
`helper/test/decisions/main.swift` that call `fnv1a` through `withUnsafeBytes`.

## 1. Spike — does `NSCursor.currentSystem` see other apps' pointers?

**ANSWERED 2026-09-03, on real hardware: yes.** 599 samples in 20 s, 0 nil, on
the sampler's own thread (no main-thread requirement). The I-beam over a text
field matched `NSCursor.iBeam` byte-for-byte (hash `19fb277f344bcd43`,
23x22 pt, hotspot 12,11 at 2x), 14 changes emitted, every one a real flip.
Four distinct references, all at scale 2 on this display:

| shape | pt | hotspot | reps | hash |
|---|---|---|---|---|
| arrow | 28x40 | 5,5 | 4 | `24354067dc3c353e` |
| ibeam | 23x22 | 12,11 | 4 | `19fb277f344bcd43` |
| crosshair | 24x24 | 11,11 | 2 | `527f2d226d18ddbd` |
| pointingHand | 32x32 | 12,8 | 2 | `1e8904d0d3385a7` |

Five unknown pointers were seen and correctly written as `arrow` (window-edge
and corner resize cursors: 18x28 @ 9,14; 22x22 @ 11,11 twice with different
bytes; 30x24 @ 15,12). Those are events-3 material.

**What the measurement changed:** a sample costs **1.04 ms mean, 41 ms max**,
not microseconds. That is not a cost the tap's run loop can carry, so the
sampler moved to its own thread (`Capture.startCursorSampler`) and
`orderedEvents` restores time order at write time. The rest of this section is
kept as the procedure for re-measuring.

**`pointingHand` confirmed on a second run (2026-09-04):** hovering a link
emitted `pointingHand`, so all four shapes match their `NSCursor` built-ins
byte-for-byte on this machine. The first run never saw it only because no
link was hovered.

The spike is the helper's own `cursor-probe` command, run from the signed test
host so it carries the bundle's TCC identity and the production process shape
(background, `NSApplication` accessory policy, sampling on a plain `Thread`
with its own `CFRunLoop` — exactly the tap thread's arrangement).

```
open -W tools/test-host/STCTestHost.app --args \
  --cursor-probe --helper "$PWD/helper/build/stc-helper" --ms 20000 \
  --out /tmp/cursor-probe.json
```

While it runs (20 s): hover a **text field**, a **link** in a browser, the
**desktop**, a **window edge**, and do a **Finder drag**. Then:

```
jq '.probe | {thread, samples, nilSamples, sampleUsMax, sampleUsMean, missingReferences, references, changes, emitted}' /tmp/cursor-probe.json
```

Repeat with `--on-main` and compare. The questions, and where the answer is:

| question | field | pass |
|---|---|---|
| does it see other apps' pointers from a background process? | `changes` | entries with `shape: ibeam` over the field and `pointingHand` over the link. If every change is `arrow` (or `nil-sample`) the public API is blind from here and the private `CGDisplayCopyCursorForDisplay` fallback is the next decision — **do not wire increment 2 further until this is answered** |
| does it need the main thread? | `nilSamples`, `thread` | `nilSamples: 0` on `thread: sampler`. If only `--on-main` sees changes, the timer moves to the main loop and posts to the tap thread |
| are the four references distinct and stable? | `references` | four different `hash` values; `hotX/hotY/width/height` sensible (arrow hotspot near the top-left, I-beam centred, crosshair centred) |
| what does a sample cost the tap thread? | `sampleUsMax`, `sampleUsMean` | microseconds. If `sampleUsMax` is in the milliseconds, sampling moves off the tap thread (risk 3) |
| signature stability across pointer size / 1x vs 2x | run twice with the accessibility pointer size changed, and on the built-in vs external display | `hash` moves, geometry may move — both are re-measured at tap start, so what must hold is that `changes` still map correctly, not that the numbers repeat |

Paste the table into the ticket. The gate is four distinct, stable signatures
for the four shapes with the mapping rule stated (it is in
`classifyCursor`: exact match, else unique geometry, else arrow).

A terminal-launched run also works for a quick look, with the terminal's TCC
identity rather than the bundle's:

```
(echo '{"cmd":"cursor-probe","seq":1,"ms":15000}'; sleep 17) | helper/build/stc-helper 3>&1
```

## 2. Sampler vs. tap

```
npm run test:capture
```

`capture.grant.test.ts` now asserts, on a real 3 s take: `events.json` is v2,
the stop reply's `cursorEvents` equals the cursor events in the file, no two
consecutive cursor events share a shape, the file is time-ordered, and
`tapReenables` is 0 with the sampler running (on its own thread). It prints
the tap-disable counts on success; `afterStop` is the helper's own disable
being reported back, `timeout` would be starvation.

**Ran 2026-09-04: passes, with and without `STC_NO_CURSOR_SAMPLER=1`.** The
first run reported `tapReenables: 1` on both builds; that was `stop()`'s own
`tapEnable(false)` coming back as a `tapDisabledByUserInput` event and being
counted (and re-enabled). Fixed by setting `stoppingBegan` before the disable
and ignoring disables after it. `lossy-under-capture.grant.test.ts` also
passes on this build (276 stalled vs 264 drained frames).

## 3. Hardware verification (increment 4)

**DONE 2026-09-04.** An 11 s take from the app (`~/Desktop/stc/2026-09-04_09-12-59`:
726 moves, 6 clicks, 37 shape changes over ibeam / pointingHand / arrow) was
exported with `scripts/export-one.mjs` and watched: I-beam over the field, hand
over the links, arrow elsewhere, click highlight under the I-beam, in step with
the video. Sidecars pinned as `fixtures/real-session-cursor/`, semantics in
`helper/test/real-events-cursor.test.ts`.

The watch is what makes this step worth anything: a uniformly wrong shape
passes every automated check in this repo, and only a human watching catches
it. To repeat it — after a classifier change, new artwork (STC-312), or on a
new machine — record from the app (`npm run app:start`), hovering a text
field, a link, the desktop, then clicking in the field; export and watch.

NB the first report was "no cursor at all in the video" — that was the raw
`display.mp4`, which never has one (`showsCursor` is off; the pointer exists
only in an export). Ask which file was watched before chasing a regression.

## 4. Close out

**DONE 2026-09-04** — CLAUDE.md's STC-309 row, PHASE-2's cursor row, and the
Linear ticket all updated with what was watched.

## What changed, and why it is shaped this way

- `helper/src/CaptureDecisions.swift` — `CursorSignature`, `CursorReference`,
  `classifyCursor`, `decideCursorShape`, `fnv1a`, `orderedEvents`. Pure; tested
  in `helper/test/decisions/main.swift`.
- `helper/src/CursorShape.swift` — the AppKit bridge (`signature(of:)`,
  `references()`), `CursorSampler` (a `CFRunLoopTimer` on whichever loop it is
  handed), and `CursorProbe` (the spike).
- `helper/src/Capture.swift` — the sampler runs on its own thread, started
  beside the tap; `recordCursorShape` appends under `lock` with
  `t` from the helper's own clock minus `t0Ns`; `stats()` gains `cursorEvents`;
  `writeSidecars` writes version 2, time-ordered. `cursorSampleIntervalSeconds`
  is the one named constant (30 Hz; up to 33 ms lag, two frames at 60 fps;
  ~3% of a core at the measured 1 ms per sample).
- **References are measured at tap start, not baked in.** The ticket's plan was
  a table from the spike; a table drifts the first time the pointer-size
  setting or the display scale changes, and both change the bytes. Measuring
  `NSCursor.arrow/.iBeam/.crosshair/.pointingHand` in the same process at the
  same settings makes those cancel. The spike still matters — it is what
  says whether `currentSystem` sees anything at all.
- `helper/src/main.swift` — `cursor-probe` command (idle only).
- `tools/test-host/main.swift` — `--cursor-probe [--ms n] [--on-main]`.
- `helper/test/cursor-shape-names.test.ts` — holds the Swift list to the
  schema's enum and the artwork's list (a third copy of the same four names,
  in a third language).
- `helper/test/ipc.test.ts` — two `cursor-probe` cases (shape of the reply,
  both threads), so CI exercises the AppKit path on every push.
- `helper/test/real-events.test.ts`, `helper/test/capture.grant.test.ts` —
  validate against `events-2`.
- `app/renderer/index.html`, `app/src/renderer.ts` — a "cursor shapes" row in
  the live stats beside `events`.
