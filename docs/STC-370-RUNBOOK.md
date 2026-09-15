# STC-370 — region and window scope for recordings: what to run on the Mac

Written on a Linux session with no `swiftc` and no ScreenCaptureKit, so none
of it had run against a real display, a real window, or real hardware when
first written. **§§1-4 below are now RUN AND CONFIRMED on real hardware
(2026-09-14, macOS, run manually against `helper/build/stc-helper` — not
through this repo's own automated session).** Region capture, window capture,
a real mid-take resize, a real mid-take close, and a real plain move were all
driven by hand; results are recorded under each section rather than left as
predictions. One design assumption from the original write-up was WRONG in
the specific reason it predicted (§3b) — corrected below rather than quietly
fixed, because a documented prediction that turned out wrong is worth more
on the record than smoothed over.

## What changed

- `start` accepts `region` (`{x, y, width, height}`, display-local points,
  like `capture-still`'s `crop`) or `windowId` (a `CGWindowID`, from the
  `windows` verb) in addition to the existing `displayId`. All three are
  optional and mutually exclusive between `region`/`windowId`; no scope
  fields at all is the unchanged phase-1 behaviour (the whole display SCK
  lists first, or the named `displayId`).
- `anchors.json` gains a `scope` block (**version 3**) for a region or window
  take, naming what was actually captured — display-local points for a
  region, id/app/title/bounds for a window. A whole-display take is
  unaffected and still writes version 2 with no `scope` block at all
  (`anchorsDocument` emits the minimum version that can express the
  document, the same rule `projectForWrite`/`shotForWrite` already use).
- A window-scope take polls its own window once a second
  (`CaptureSession.windowWatchIntervalSeconds`) via `CGWindowListCopyWindowInfo`.
  A size change past half a point ends the take cleanly with
  `stop.reason: "window-resized"`; the window no longer being found ends it
  with `"window-closed"` — **though in practice, on hardware, an outright
  close is normally caught first by the pre-existing stream-death path
  (`"stream-stopped"`, STC-306) rather than this poll; see §3b.** A pure move
  is ignored — the design decision is that
  `SCContentFilter(desktopIndependentWindow:)` follows the window as it
  moves, so the frames should keep arriving at the same pixel size. **This
  was the one claim in this ticket a Mac could prove wrong outright, and it
  held** — see §4.
- `chooseDisplayForWindow` (which display a window belongs to) is now shared
  between the still path and the recording path, replacing a second inline
  copy that used to live in `Still.swift`.

## 0. Build and the no-hardware checks

```
git pull && helper/build.sh && tools/test-host/build.sh
npm run typecheck && npm test
```

`npm test` runs:
- the decisions harness (`parseStartRequest`, `chooseDisplayForWindow`,
  `decideWindowWatch`) — pure, no display needed;
- the anchors harness, building region-scope and window-scope documents and
  validating them against `schema/anchors-3.schema.json` with Ajv;
- `capture.test.ts`'s new request-validation cases (region+windowId
  together, a non-positive region, a malformed windowId) — these answer
  before ScreenCaptureKit is touched, so they need no grant either.

None of that proves the SCK calls themselves work. That is what is left.

## 1. Region scope, by hand

```
mkdir -p /tmp/stc-region && \
(echo '{"cmd":"start","dir":"/tmp/stc-region","region":{"x":100,"y":100,"width":800,"height":600},"seq":1}'; \
 sleep 3; echo '{"cmd":"stop","seq":2}') | helper/build/stc-helper 3>&1 | jq .
```

Expect `started` naming a `capture` roughly 800×600 (times the display's
backing scale, evenly floored) — NOT the whole display's size. After it
stops, `cat /tmp/stc-region/anchors.json | jq .scope` should show
`{"kind": "region", "region": {"x": 100, "y": 100, "width": 800, "height": 600}}`
and `.version` should be `3`. Open `display.mp4` — it must show only the
800×600 region of the screen, positioned where you asked, with no scaling
artifacts.

**CONFIRMED 2026-09-14.** `capture` came back 1600×1200 (800×600 at this
machine's 2x backing scale, matching `captureSize`'s even-floor rule
exactly), `scope`/`version` matched, and the video showed only that region,
correctly positioned, no scaling artifacts. **Also found, unrelated to
region/window scope itself:** the exact `(echo start; sleep N; echo stop) |
helper` shell idiom this runbook uses lost the take entirely if the pipe
closed right behind the `stop` line — the process could exit before the async
teardown wrote `anchors.json`/finalised `display.mp4` (confirmed: a
`display.mp4` existed on disk but QuickTime refused to open it — no `moov`
atom, because `finishWriting()` never got to run). Filed and **FIXED as
STC-376 (2026-09-14, PR #139, merged)**: `App.shutdown()` now joins a stop
already in flight instead of exiting past it. The `; sleep 1` workaround this
runbook carried after every `stop` line is removed below now that the actual
race is closed — **still not hardware-verified**, since that fix landed from
a Linux session with no way to run it; if a `stop`-then-pipe-close still
loses a take on real hardware, that is a regression worth its own ticket.

## 2. Window scope, by hand

```
(echo '{"cmd":"windows","seq":1}'; sleep 1) | helper/build/stc-helper 3>&1 | jq '.windows[] | select(.title != null)'
```

Pick an `id` for a real window (Finder, a browser, anything titled). Then:

```
mkdir -p /tmp/stc-window && \
(echo "{\"cmd\":\"start\",\"dir\":\"/tmp/stc-window\",\"windowId\":<ID>,\"seq\":1}"; \
 sleep 3; echo '{"cmd":"stop","seq":2}') | helper/build/stc-helper 3>&1 | jq .
```

Expect `anchors.json`'s `scope.window.id` to match, `scope.window.bounds` to
match the window's real on-screen size, and `display.mp4` to show **only**
that window — alpha is not the point here (that is the still path's
`window-only` mode; a recording still writes an opaque frame), but the
window's content should fill the frame with no desktop bleeding in around it.

**CONFIRMED 2026-09-14** on a real Finder window: capture size, `scope.window`
(id/app/title/bounds), and the video all matched — content filled the frame,
no desktop around the edges.

## 3. The mid-take window watcher

**3a — resize, for real.** Start a window-scope recording of a resizable
window (a Finder window, a browser). While it is recording, drag a corner to
resize it. Expect: the take stops on its own within ~1 s of the resize,
`anchors.json`'s `stop.reason` is `"window-resized"`, and `display.mp4` plays
back cleanly up to that point (no corrupted trailing frames, no crash). This
is the step that tests the "moves are safe, resizes are not" design decision
for real — if SCK behaved differently before this fires (delivering
oddly-sized or torn frames), that shows up in the video.

**CONFIRMED 2026-09-14, twice.** A deliberate corner-drag resize was caught
within ~300 ms (well under the 1 Hz poll interval — it happened to land
right behind a tick), `stop.reason` was `"window-resized"`, and the video
played back cleanly with no corruption. Separately, an ACCIDENTAL resize
(grabbed while trying to test a plain move, see §4) was caught identically —
useful corroboration that detection isn't a fluke of one careful test.

**3b — close, for real.** Start a window-scope recording, then quit or close
the window's app. Expect the same clean stop, with `stop.reason:
"window-closed"`.

**PARTIALLY WRONG, CORRECTED 2026-09-14.** The take does stop cleanly — but
`stop.reason` came back `"stream-stopped"`, not `"window-closed"`.
`SCStream` itself dies (`didStopWithError`, the pre-existing STC-306 path)
faster than this ticket's 1 Hz poll can notice the window is gone, so for an
outright close the OLD mechanism wins the race and answers first; the new
`window-closed` poll path never got a chance to fire. The take was still
intact — sidecars correct (`scope.window` present and right), video played
fine up to the close — so the SAFETY property holds; only the diagnosed
REASON differs from what this ticket predicted. `window-closed` is not proven
dead code: it should still be the path that fires for a window that
disappears from `CGWindowListCopyWindowInfo`'s on-screen list WITHOUT killing
the stream.

**Minimising, tried as the candidate for that (2026-09-14): still not
`"window-closed"`.** ⌘M on the recorded window (no access to its traffic
lights) stopped the take with `stop.reason: "window-resized"`, take intact.
`CGWindowListCopyWindowInfo` still finds a minimised window rather than
dropping it — it is not "gone" the way a closed window is — but its reported
bounds collapse during/after the genie effect, which the watcher correctly
reads as a size change rather than a disappearance. So between the two ways
a window commonly "goes away" mid-take, close answers `"stream-stopped"` and
minimise answers `"window-resized"` — **`"window-closed"` was not observed
in either.** The safety property (the take always stops cleanly) held both
times; it's specifically the third named reason that has no confirmed
trigger yet. It may still be reachable — an app force-quit in a way that
doesn't tear down the stream the way an orderly close does is one
possibility nobody has tried — but it is no longer the assumed common case
this ticket's own design section originally implied.

**3c — the grant test's fault-injected version, which needs no manual
resize/close at all:**

```
npx vitest run --config vitest.grant.config.ts helper/test/region-window-scope.grant.test.ts
```

The last two tests in that file use `STC_CAPTURE_FAULT=window-resized` /
`=window-closed` to make the watcher's REACTION fire deterministically
(`Capture.swift`'s `armWindowFault`, the same idiom
`stream-died.grant.test.ts` already uses for a stream that dies mid-take).
They prove the stop/sidecar-writing path works; they do NOT prove a real
resize or close is detected in the first place — 3a/3b are what prove that.

## 4. A window that moves but does not resize

Start a window-scope recording, then drag the window to a different part of
the screen (or a different display) WITHOUT resizing it. Expect the
recording to continue uninterrupted and `display.mp4` to keep showing the
window's content — this is the "moves are ignored" decision from the design
note above. If the take instead glitches, freezes on the old position, or
stops, that decision was wrong and `decideWindowWatch`/the watcher need a
size-AND-position check, not size alone.

**CONFIRMED 2026-09-14.** A pure move (position only, confirmed no resize)
ran uninterrupted for the full recording — no unsolicited `warning` or
`stopped`, stats kept incrementing normally until the take was ended by
hand. `SCContentFilter(desktopIndependentWindow:)` does follow the window as
it moves with no code needed here, as designed.

## What is still open

- **No hardware trigger for `"window-closed"` has been found**, despite
  trying the two obvious candidates (§3b: an orderly close answers
  `"stream-stopped"`; minimising answers `"window-resized"`). The take stops
  cleanly either way, so this is not a safety gap — but the specific reason
  string may be effectively unreachable in normal use, which is worth
  knowing if anything downstream (the eventual UI, an analytics count)
  plans to distinguish it from the other two.
- 1 Hz (`windowWatchIntervalSeconds`) proved fast enough in practice (a
  resize was caught in ~300 ms, well inside the interval, on the sample
  size tested here — two resizes, one deliberate and one accidental, plus
  the minimise). Not stress-tested against a rapid resize-drag or a very
  large window.
