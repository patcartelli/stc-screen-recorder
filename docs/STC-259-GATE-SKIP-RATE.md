# How often do the CI gates actually run?

Measured 2026-08-30. Re-derive with `node scripts/gate-skip-rate.mjs [runs]`.

> **This document was published with a wrong headline and corrected the same day.**
> It first claimed the determinism gate had not run in 19 consecutive CI runs.
> That number came from a broken measurement — see *The correction* below. The
> real rate is 60% over the runs that can be measured. The findings about the
> retry and the failure signature were read directly out of step logs and stand.

## The number

All four gates label a machine fault `ENVIRONMENT` and skip rather than redden.
That is correct and deliberate: a red X meaning *either* "you broke determinism"
*or* "Apple's shared GPU did not answer" is ambiguous, not loud. `CLAUDE.md` says
so, and says what to watch for:

> If skips become the norm the guarantee has quietly stopped being checked. The
> answer at that point is the decoder, not more attempts.

Over the last 23 completed runs, of which **10 could be measured**:

| gate | passed | measurable runs | skip rate |
|---|---|---|---|
| Determinism | 4 | 10 | 60% |
| Seek | 4 | 10 | 60% |
| Export | 4 | 8 | 50% |
| Identity | 4 | 8 | 50% |

The other 13 runs are excluded, not counted as skips: `gh run view --log`
returned every line as `UNKNOWN STEP` for them, and a verdict cannot be scoped to
a gate without step attribution.

**When attribution is available is not understood, and an earlier version of this
document got it backwards.** It claimed attribution "ages out within a day or
two". Measured over 12 consecutive runs: every run younger than ~200 minutes had
NO attribution, and every run between 212 and 319 minutes old had it. So it
*appears* some hours after a run rather than ageing out — though some day-old
runs lack it too, so age alone does not explain it and no mechanism has been
confirmed. The practical consequence is the reverse of what was published: a run
that just finished cannot be measured yet.

**The four gates skip together.** In every run where one skipped, all four did;
in every run where one passed, all four did. This is a property of the job, not
of any gate — the machine is either able to service a video pipeline for that
run or it is not.

## Re-measured 2026-09-01: `prefer-software` was not the cause

#56 changed the gates to ask Chromium for `prefer-software` decoding, on the
theory that CI's paravirtualized hardware decoder is what wedges them. The
2026-08-31 handoff flagged that as **a hypothesis tested only on a machine that
does not exhibit the fault** — two post-change runs were green against a
baseline that was also mostly green.

`node scripts/gate-skip-rate.mjs 20`, over the 20 runs to `82c9375`:

| gate | passed | measurable runs | skip rate |
|---|---|---|---|
| Determinism | 6 | 8 | 25% |
| Seek | 13 | 18 | 28% |
| Export | 13 | 18 | 28% |
| Identity | 13 | 18 | 28% |

Split at `7f3a3d7` (#56 — its own push run is the first carrying the change),
the seek/export/identity column gives 2 skips in 6 measurable runs before and 3
in 12 after. **Do not read that as an improvement.** At those sample sizes 33%
and 25% are the same number, and the earlier 60% came from a different run set
again.

**The rate is not the evidence here; the checkpoint trail is.** Run
`33445860846` — post-change, all four gates SKIP:

```
Determinism gate: the in-page gate run did not return within 180000 ms
  +    317 ms  [gate-mark 1] export[A]: decodeAll (VideoDecoder.configure is synchronous)
  (teardown: browser.close() did not return within 30000 ms)

Seek gate: the decoder accepted chunks and emitted none — frameAt(0) never resolved
  +    406 ms  [gate-mark 1] seek: new SeekingFrameSource (VideoDecoder.configure is synchronous)
```

Same call, same 300-400 ms into the page, same outer bound firing while no
in-page timer can — the pre-change signature from `33384105552` exactly, both
modes still in one job. Asking for software decoding did not move the wedge.

### The hole that made that conclusion weaker than it looked

`scripts/gate.mjs` verifies the page used the preference the runner sent — and
that check runs *after* `bounded(page.evaluate(...))` returns. **A wedge never
returns, so on precisely the runs the check exists for, it cannot fire.** The
conclusion above rested on the unverified assumption that `addInitScript` had
applied; the trail from a wedge named the blocking call but not what it was
asking that call for.

The same shape as everything in the 2026-08-31 handoff's closing section: a
measurement that could not see the thing it was being read as evidence about.

`harness/decoder.ts` now applies the preference and MARKS it, so it arrives over
the one channel that survives a blocked main thread, ahead of the first decoder
touch. Watched firing locally under `STC_GATE_FAULT=wedge:`:

```
--- last 23 in-page checkpoints before the bound fired ---
  +    701 ms  [gate-mark 1] decoder preference: prefer-software
  +   1580 ms  [gate-mark 2] export[A]: decodeAll (VideoDecoder.configure is synchronous)
```

### Confirmed on CI, run 33576888543

The run that merged the mark wedged, which gave it its first opportunity. All
four gates skipped, and every trail carried the preference ahead of its own
first decoder touch:

| gate | preference mark | first decoder touch |
|---|---|---|
| Determinism | 393 ms | 466 ms — `decodeAll` |
| Seek | 531 ms | 584 ms — `new SeekingFrameSource` |
| Export | 450 ms | 482 ms — `loadSession` |
| Identity | 348 ms | 375 ms — `loadSession` |

Every one reads `decoder preference: prefer-software`. **The page did get
software decoding and wedged in `configure()` anyway.** The finding is closed:
`prefer-software` is not the cause, on evidence rather than on the assumption
that `addInitScript` had applied.

That verdict does not rest on step attribution — the run has none, every line
being `UNKNOWN STEP`. It does not need any: `decoder preference:` is printed
only by `harness/decoder.ts`, and the two references to the string in
`transform/test/decoder-preference-mark.test.ts` sit behind a `console.log`
spy, so nothing but a live gate can emit it. That check is the lesson of the
100%-skip retraction applied before publishing rather than after.

### One `[gate-mark 1]` per document, not per run

The same run printed **two** `[gate-mark 1]` lines in three of the four trails.
Not the code running twice: `seek-gate.mjs`, `export-gate.mjs` and
`identity-gate.mjs` each `page.reload()` deliberately, to settle vite's dep
re-optimisation, and `mark.ts`'s `seq` is per-document. `gate.mjs` does not
reload, which is exactly why the determinism trail shows one.

`attachCheckpointTrail` now says so where it happens:

```
  +    588 ms  [gate-mark 1] decoder preference: prefer-software
  +    872 ms  --- page reloaded; the next mark numbers restart at 1 ---
  +    943 ms  [gate-mark 1] decoder preference: prefer-software
  +   1375 ms  [gate-mark 2] seek: new SeekingFrameSource (...)
```

It hangs off `framenavigated`, which commits before the new document's scripts
run. `load` and `domcontentloaded` both fire *after* module evaluation and would
sort the separator to the wrong side of the marks it explains.

## What a skip costs, and what a pass costs

Measured from step durations on real runs:

| | determinism gate step | whole job |
|---|---|---|
| healthy | **9 s** | 2.7 min |
| wedged, `ATTEMPTS = 3` | **641 s** | 20.8 min |

A healthy run clears all of gates A, B and C in nine seconds. A wedged one used
to spend nearly eleven minutes discovering it could not start.

## It is a wedged renderer, not a slow decoder

Every skipped attempt is identical:

```
ENVIRONMENT: Error: the in-page gate run (decode, render, encode) did not return within 180000 ms
  (teardown: browser.close() did not return within 30000 ms)
GATE: FAIL
[gate-retry] attempt 1/3 failed for an environment reason; retrying
```

It fails at the **outer, process-side** bound (`EVAL_MS`, 180 s), not at the
in-page `FLUSH_MS` of 60 s. An in-page bound is a JavaScript timer, and a timer
cannot fire while the renderer's main thread is blocked. So the renderer is
wedged, not slow. `browser.close()` then hangs its full 30 s, the documented
signature of closing a browser whose renderer is stuck.

This is the failure `CLAUDE.md` calls **Mode B**, and already states cannot be
diagnosed from inside the page. Read directly from the gate's own step logs, not
from the broken aggregate.

## The retry bought nothing

In every skipping run examined, all three attempts failed the same way at the
same bound, and attempts 2 and 3 never once succeeded where attempt 1 failed.
The fault is per-run machine state — which a fresh attempt inside the same job
inherits — not a per-attempt transient.

**`ATTEMPTS` is 1 since 2026-08-30.** Worst-case job dropped 58.8 → 44.8 min.
That is a mitigation, not a fix. Restoring the retry is a one-line change and the
loop stays tested at any value, but re-measure first.

## The correction

The first published version of this document said **"0 passes in 19 runs, 100%
skip"**. It was wrong, and the cause is the trap this very investigation had
already written down one section earlier.

`scripts/gate-skip-rate.mjs` searched the **whole-job log** for
`Determinism gate DID NOT RUN`. That string is printed verbatim into the **Test**
step by `transform/test/gate-retry.test.ts`, which exercises `announceSkip` for
real. Every run that ran the unit tests therefore looked like a skipped gate —
including runs where the gate had passed in nine seconds.

That is the same mistake as reading `decoder flush did not complete within
60000ms` as the gate's reason when it too is a fixture string. Documenting a trap
is not the same as being immune to it.

Two consequences:

- **The rate is 60%, not 100%**, over 10 measurable runs rather than 19.
- **The boundary claim is retracted.** The earlier version pinned the last pass
  to `cb03ee9` and the first skip to `9df1e27` — the commit that introduced
  skipping — 43 minutes apart. That was derived from the same contaminated
  method, and the runs needed to re-check it come back with no step attribution,
  so it cannot be re-measured. It cannot be confirmed and should not be repeated.

What survives unchanged, because it was read directly from gate step logs rather
than from the aggregate: the wedged-renderer signature, the retry being useless,
and the step timings above.

## What to do next

1. ~~Read the decoder preference off the next wedge's trail.~~ **Done
   2026-09-02**, run 33576888543 — see above. `prefer-software` reached all four
   pages and all four wedged anyway. The next question is what the decoder is
   actually blocked on, and it is no longer answerable by choosing a different
   one.
   (This item used to read "diagnose Mode B out of process — in-page
   instrumentation cannot see this by construction, Chrome's GPU logging is the
   avenue". #50 disproved that: a console message escapes a blocked renderer
   when nothing else does, and the trail located the wedge without any GPU log.)
2. ~~Consider `ATTEMPTS = 1`.~~ **Done 2026-08-30.**
3. **Do not add attempts to the other three gates.** Already rejected on
   arithmetic (118 min, needing a ~2 hour cap) — and since all four gates skip
   together, a retry could not help them either.
4. **A fresh run is measurable for three of the four gates.** Seek, export and
   identity print markers that no test emits, so they can be read off an
   unattributed log; determinism cannot, because `gate-retry.test.ts` prints its
   markers verbatim, and reading that fixture as a live skip is how this
   document was published wrong. Wait a few hours if you need determinism too —
   attribution appeared at around 3.5 hours in every case measured. (Earlier
   advice here said "measure fresh runs", then "you cannot measure fresh runs";
   both were too broad.)

## What CI's slow step does NOT cover

`npm run test:slow` locally runs two files; CI runs only
`app/test/export-identity.slow.test.ts`.

`helper/test/ring-overflow.slow.test.ts` is machine-dependent by construction —
it escalates a stall until the kernel's pipe buffer overflows, and how long that
takes is the kernel's business. Its own comment recorded that it "timed out on
CI at 180 s", which is why it lived outside CI in the first place; adding the
whole suite took it along, and it passed three runs before timing out on the
fourth. A test that reddens PRs at random is worse than one that does not run.

So the lossy channel's end-to-end wiring, and the channel-independence check
added for STC-249, are **local-only commands**. Neither runs automatically.

## Method

The script pulls the last N completed runs through `gh`, downloads each job log,
and — where GitHub has attributed the log to steps — classifies each gate only
by markers found inside its own step. Without attribution it falls back to the
whole log for the three gates whose markers no test prints, and reports
determinism as `n/a`; `n/a` is excluded from the rates, never counted as a skip.
`transform/test/gate-skip-rate.test.ts` asserts that safe set against the test
tree, so a test that started printing one of those markers fails there instead
of silently corrupting the measurement. It prints a warning when any gate
crosses a 50% skip rate.
