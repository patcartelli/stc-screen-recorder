# The determinism gate has not run in 19 consecutive CI runs

Measured 2026-08-30. Re-derive with `node scripts/gate-skip-rate.mjs [runs]`.

## The number

All four gates label a machine fault `ENVIRONMENT` and skip rather than redden.
That is correct and deliberate — a red X meaning *either* "you broke determinism"
*or* "Apple's shared GPU did not answer" is ambiguous, not loud. `CLAUDE.md` says
so, and says what to watch for:

> If skips become the norm the guarantee has quietly stopped being checked. The
> answer at that point is the decoder, not more attempts.

That has happened. Over the last 20 completed CI runs:

| gate | passed | observed | skip rate |
|---|---|---|---|
| **Determinism** | **0** | **19** | **100%** |
| Seek | 9 | 15 | 40% |
| Export | 8 | 12 | 33% |
| Identity | 8 | 12 | 33% |

The determinism gate has not passed once in the window. Every green tick in that
period is green on the strength of the other checks; determinism is simply
unverified.

## The boundary is exact, and it is the commit that added skipping

| | run | when | commit |
|---|---|---|---|
| last PASS | 33208678820 | 2026-08-28 20:32 | `cb03ee9` — *say where the decoder stops* |
| first SKIP | 33211768357 | 2026-08-28 21:15 | `9df1e27` — *retry the gate on the machine, skip loudly* |

Forty-three minutes apart. From the moment the gate gained the ability to skip,
it has done nothing else.

This is **not** evidence that `9df1e27` broke anything. The underlying fault
predates it — before that commit the same fault turned master red on roughly half
of push runs, which is why the skip was introduced. What the boundary shows is
that the change converted a **visible ~50% failure** into a **silent 100%
non-execution**, and nothing has flagged it since.

One thing genuinely did get worse and is not explained: before `9df1e27`, PR runs
mostly passed and push runs mostly failed. After it, everything skips. A retry of
3 should make skips *less* likely than a single attempt, not universal.

## What the failure actually is

Every skipped attempt looks identical:

```
ENVIRONMENT: Error: the in-page gate run (decode, render, encode) did not return within 180000 ms
  (teardown: browser.close() did not return within 30000 ms)
GATE: FAIL
[gate-retry] attempt 1/3 failed for an environment reason; retrying
```

Two things follow, and both point away from the decoder bound:

1. **It fails at the OUTER, process-side bound** (`EVAL_MS`, 180 s) — not at the
   in-page `FLUSH_MS` (60 s). An in-page bound is a JS timer, and a timer cannot
   fire while the renderer's main thread is blocked. So the renderer is wedged,
   not slow. This is `CLAUDE.md`'s **Mode B**, which it already states cannot be
   diagnosed from inside the page.
2. **`browser.close()` then hangs its full 30 s**, every time — the documented
   signature of closing a browser whose renderer is stuck.

## The retry buys nothing, and costs 10.5 minutes a run

All three attempts fail the same way, at the same bound, in every run examined.
Attempts 2 and 3 have never once succeeded where attempt 1 failed. Each attempt
costs 180 s of bound plus 30 s of teardown, so the determinism gate burns
**~10.5 minutes per CI run** to reach a conclusion it had after 3.5.

Per STC-259's own rule — *retry logic must key on the failure being the MACHINE's*
— a retry whose second and third attempts are known to be perfectly correlated
with the first is not absorbing a transient. Dropping `ATTEMPTS` to 1 for this
gate would reclaim 7 minutes per run and lose no information. That is a
mitigation, not a fix.

## Two things I got wrong, recorded so they are not repeated

**I first reported the gate's reason as `decoder flush did not complete within
60000ms`.** It is not. Those lines — 105 of them across the cached logs — come
overwhelmingly from the **Test** step, where they are a *fixture string* inside
`transform/test/gate-retry.test.ts` asserting the retry classifier. They are test
data, not a fault. The gate's real signature is the 180 s outer bound above.

**I hypothesised that a bound had been tightened at the boundary,** which would
have meant the gate was skipping healthy runs. Refuted by the diff: `c35e61d`
only extracted the existing literal `60_000` into the named `FLUSH_MS` and added
diagnostics. The threshold did not move.

**My first version of the measuring script was itself wrong** in the way this
repo keeps finding: it detected a gate by step-name text that, for three of the
four gates, *only appears when they skip*. It therefore scored every healthy run
as "no signal" and computed a skip rate from the skips alone. The committed
script keys on each gate's own `PASS`/`FAIL`/`DID NOT RUN` markers instead.

## What to do next

1. **Diagnose Mode B out of process.** In-page instrumentation cannot see this by
   construction. Chrome's own GPU logging is the avenue — `--enable-logging
   --v=1`, and `chrome://gpu` state captured before the wedge.
2. **Consider `ATTEMPTS = 1` for the determinism gate** until the wedge is
   understood. The retry is provably not helping and costs 7 min per run.
3. **Do not add attempts to the other three gates.** `CLAUDE.md` already
   rejected that on arithmetic (118 min, needing a ~2 hour cap).
4. **Run `node scripts/gate-skip-rate.mjs` before trusting a green CI run** on
   anything determinism-sensitive.

## Method

`scripts/gate-skip-rate.mjs` pulls the last N completed runs via `gh`, downloads
each job log, and classifies each gate by its own markers. Runs whose logs have
expired are skipped rather than counted, so the denominator cannot drift
silently. It prints a warning of its own when any gate exceeds a 50% skip rate.
