# STC-301 — the screenshot slice's gates, and where the ticket and the repo disagree

Six gates were specified. Five exist; the sixth is the ticket's own closing
line and only a person can do it. **Two of the six cannot be CI gates**, and one
is built by a different method than the ticket names. Both departures are
recorded here rather than done quietly, in the idiom of
`docs/STC-300-FORMAT-AUDIT.md`.

## Where each gate lives

| # | gate | where | CI? |
|---|---|---|---|
| 1 | alpha correctness, light and dark | `npm run gate:still` | **yes** |
| 2 | redaction irreversibility | `helper/test/still-encode.test.ts` | **yes** |
| 3 | capture latency | `helper/test/still-gates.grant.test.ts` | **no — needs a grant** |
| 4 | nothing lost | `app/test/nothing-lost.e2e.test.ts` | **yes** |
| 5 | format round-trip, incl. a frozen v1 | `transform/test/shot-v1-frozen.test.ts` | **yes** |
| 6 | capture during recording | `helper/test/still-gates.grant.test.ts` | **no — needs a grant** |
| — | *"one real portfolio figure, start to finish"* | a person, on a Mac | no |

```
npm test              # gates 2, 4, 5
npm run gate:still    # gate 1
npm run test:capture  # gates 3 and 6, on a Mac with a Screen Recording grant
```

---

## Disagreement 1 — gates 3 and 6 cannot be "enforced in CI"

The ticket's first line is *"Each is enforced in CI on macOS runners, not
checked by eye."* Gates 3 and 6 both call `capture-still`, which needs a
**Screen Recording grant for whatever process runs the tests**. GitHub's
runners do not have one and cannot be given one — that is why this project
already keeps `*.grant.test.ts` out of `npm test` entirely, with CLAUDE.md's
reasoning that a skip inside the suite "reads as covered and rots".

So they are built as grant tests: real, runnable, and run by a person with
`npm run test:capture`. The alternative — CI gates that skip on every push —
would be strictly worse, because a green tick that means nothing is the
"success by finding nothing to do" failure this repo has already paid for
three times.

**What that costs, stated plainly:** capture latency and mid-recording capture
are unverified between Macs. Nothing on a push will tell you if either
regresses. If that becomes unacceptable, the fix is a self-hosted macOS runner
with a granted TCC identity, not a CI gate that pretends.

## Disagreement 2 — gate 1 asserts properties, not golden PNGs

The ticket asks for *"golden-PNG fixtures for all five output modes … light and
dark appearance"*. STC-291 already refused goldens for this exact renderer and
CLAUDE.md records why: gradients, blurred shadows and antialiased curves are
Skia's output, and **this project's own pre-encode hashes already differ
between rasterisation backends** (`10a05a33…` on GPU, `bc03e397…` on
swiftshader, same code and same document). A committed reference PNG is a
stored constant across engines the codebase does not control — it goes red on a
Chromium bump rather than on a regression, which is precisely the flaky gate
the ticket's own Constraints section forbids.

What the gate asserts instead holds in any correct rasteriser:

* alpha is exactly 0 outside the window's real rounded shape;
* the interior is the capture's own colour, untinted by decoration;
* the antialiased corner keeps the capture's colour **at every alpha** — the
  assertion that catches a premultiplied-alpha mistake;
* the shadow decreases monotonically to zero;
* a background covers every pixel;
* two renders of one document are byte-identical *within one browser*.

**The light/dark half the ticket asked for is real and was worth adding.** The
same injected premultiply mistake drifts a light capture by **245** and a dark
one by only **26** — an order of magnitude less signal for the identical bug,
because the furthest a near-black fill can slide toward black is its own
magnitude. Testing one appearance genuinely covers half the failure.

That measurement also set the tolerance. It is **8**, not the 24 the older
fringe check uses: at 24 the dark half would have caught the injected bug by a
margin of two, which is not a check worth having. A clean render drifts by 1.

The fills are near-white and near-black rather than pure, deliberately: a pure
white fill cannot slide toward white and a pure black one cannot slide toward
black, so the extremes are the two values that make each half unfalsifiable.

---

## Gate 4 found two real bugs on its first run

Worth recording, because it is the argument for the gate existing. Five
captures in quick succession produced **five shots on disk, three export
requests, and two files**.

1. **A panel replaced before it had composited exported nothing.**
   `runExport` opens `if (!composite) return false` — a fair guard — but
   `settle()` treated that as completion, so main destroyed the window and the
   capture was never exported. `settle` now waits for the decode-and-draw.
2. **Concurrent exports overwrote each other**, and the code had predicted it.
   Names are made unique against a directory listing taken before writing, so
   five racing settles all saw an empty folder and chose the same name.
   `uniqueFileName`'s own comment says a counter from a listing "is correct
   only until two exports race" and offers the suffix loop as belt-and-braces —
   but the suffix loop re-checks the **same stale snapshot**. Names are now
   reserved in-process before the write.

Measured at each step rather than assumed: 5/3/2 → 5/5/3 after the first fix →
5/5/5 after the second.

## What makes each gate deterministic on a runner

The ticket's Constraints section demands an answer, having paid for flaky gates
three times (STC-250, STC-258, STC-259). Per gate:

* **1** — one browser, one page, properties rather than stored constants; the
  only cross-render comparison is two renders in the same browser.
* **2** — decodes the encoded PNG; no timing, no rendering, no display.
* **4** — the panel timeout is pinned to its 3 s floor rather than the 6 s
  default; it waits on **directories and files**, never on an animation or a
  panel appearing; and it captures through the `display` action, which opens no
  overlay and needs no pointer, so there is no window-server race.
* **5** — pure arithmetic over a frozen document. No canvas at all.
* **3** — the budget is on the STEADY state, not the cold first call, which
  pays for `SCShareableContent` enumeration every later call does not. Five
  measurements, all printed.
* **6** — the recording is given 2 s either side of the still so the comparison
  is against steady-state frames rather than the first-frame ramp.

## Reading gate 3's output

It prints on success as well as failure, because the ticket asks for drift to
be visible rather than binary:

```
[gate 3] verb to buffer (wall, first is cold): 412.7, 61.2, 58.9, 60.4, 57.8 ms (median 60.4, worst 412.7, budget 200)
```

The first number being much larger is expected and is not a failure — the
budget is applied to the rest. If the STEADY numbers climb toward 200,
`docs/STC-289-RUNBOOK.md` §latency says which phase to look at:
`captureMs - contentMs` is the screenshot, `contentMs` is display enumeration,
`writeMs - captureMs` the PNG encode.

## The gate that is not a gate

> "Whatever the gates say, the slice is not done until one real portfolio
> figure has been made with it, start to finish, and put on the site. Gates
> catch regressions; only using it catches the presets being wrong."

That is STC-313, and nothing here substitutes for it. Every preset value in
`still-decorate.ts` is marked provisional in its own comment for the same
reason — they were reasoned, not seen.

## If a gate here ever flakes

The ticket: *"A gate that flakes gets fixed or deleted the same week."* The
honest options in order: find the non-determinism and remove it; make the gate
assert something weaker but still true; delete it and say what is no longer
covered. **Not** on the list: retrying until it passes, or widening a tolerance
until the failure stops. Gate 1's tolerance in particular was set from a
measured injected fault — raising it silently un-does that.
