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
`tapReenables` is 0 with the sampler on the tap's run loop.

## 3. Hardware verification (increment 4)

Record from the app (`npm run app:start`): hover a text field, a link, the
desktop, then click in the field. Export and **watch**: I-beam over the field,
hand over the link, arrow elsewhere, the click highlight under the I-beam, all
in sync with the video. A uniformly wrong shape passes every automated check in
this repo; only watching catches it.

Then commit the sidecars (not the mp4) as `fixtures/real-session-cursor/` and
pin them in a `real-events`-style test: cursor events present; no two
consecutive with the same shape; every shape in the enum seen; times monotonic
and interleaved with moves.

## 4. Close out

CLAUDE.md's STC-309 row → done with the date and what was watched; PHASE-2's
cursor row loses "which the helper does not emit yet"; Linear → Done with the
PR attached.

## What changed, and why it is shaped this way

- `helper/src/CaptureDecisions.swift` — `CursorSignature`, `CursorReference`,
  `classifyCursor`, `decideCursorShape`, `fnv1a`, `orderedEvents`. Pure; tested
  in `helper/test/decisions/main.swift`.
- `helper/src/CursorShape.swift` — the AppKit bridge (`signature(of:)`,
  `references()`), `CursorSampler` (a `CFRunLoopTimer` on whichever loop it is
  handed), and `CursorProbe` (the spike).
- `helper/src/Capture.swift` — the sampler is scheduled on the tap thread's run
  loop after the tap is enabled; `recordCursorShape` appends under `lock` with
  `t` from the helper's own clock minus `t0Ns`; `stats()` gains `cursorEvents`;
  `writeSidecars` writes version 2, time-ordered. `cursorSampleIntervalSeconds`
  is the one named constant (30 Hz; up to 33 ms lag, two frames at 60 fps).
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
