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
  method, and the runs needed to re-check it have since aged out of step
  attribution. It cannot be confirmed and should not be repeated.

What survives unchanged, because it was read directly from gate step logs rather
than from the aggregate: the wedged-renderer signature, the retry being useless,
and the step timings above.

## What to do next

1. **Diagnose Mode B out of process.** In-page instrumentation cannot see this by
   construction. Chrome's own GPU logging is the avenue — `--enable-logging
   --v=1`, and `chrome://gpu` state captured before the wedge.
2. ~~Consider `ATTEMPTS = 1`.~~ **Done 2026-08-30.**
3. **Do not add attempts to the other three gates.** Already rejected on
   arithmetic (118 min, needing a ~2 hour cap) — and since all four gates skip
   together, a retry could not help them either.
4. **Wait a few hours before measuring a run.** A just-finished run comes back
   with no step attribution and is silently unmeasurable; attribution appeared
   at around 3.5 hours in every case measured. The earlier advice here said the
   opposite — "measure fresh runs" — and was wrong.

## Method

The script pulls the last N completed runs through `gh`, downloads each job log,
slices it **by step**, and classifies each gate only by markers found inside its
own step. Runs with no step attribution are named and excluded rather than
scored. It prints a warning when any gate crosses a 50% skip rate.
