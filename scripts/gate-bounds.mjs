/**
 * Bounds for the gates' in-page work.
 *
 * `page.waitForFunction` carries a timeout; `page.evaluate` does NOT, and
 * Playwright has no default for it. Every gate does its real work inside one
 * evaluate — decode, render, and for two of them a WebCodecs encode — so an
 * unbounded evaluate is an unbounded wait on exactly the APIs this project has
 * documented as signalling trouble by never calling back (mp4box, VideoDecoder,
 * VideoEncoder). `scripts/gate.mjs` hung there for 24 minutes on CI against a
 * normal 10 s, and the only thing that stopped it was the job timeout — which
 * reports as "cancelled", so the log never said what was stuck.
 *
 * CLEARANCE — the arithmetic, not a vibe. The CI job is capped by
 * `timeout-minutes` in .github/workflows/ci.yml. If the bounds inside can sum
 * past that cap, the job timeout wins the race and the informative message is
 * lost again: the mistake writer-gate already made by setting an inner bound
 * equal to the outer one. Worst case is
 *
 *     PRE_GATE_BUDGET_MS + EVAL_SLOTS x EVAL_MS + SEEK_MS
 *
 * and `transform/test/gate-bounds.test.ts` asserts it against the workflow file
 * with a real margin, so the clearance is checked rather than kept in step by
 * hand. Normal is ~10 s per evaluate, so EVAL_MS is ~18x headroom, not a guess.
 */

/** Per-evaluate bound. Override for experiments; CI uses the default. */
// The retry's shape is part of the job's worst case, so it is read from its
// one home rather than restated here.
import { ATTEMPTS, ATTEMPT_MS } from "./gate-retry.mjs";

export const EVAL_MS = Number(process.env.STC_GATE_EVAL_MS ?? 180_000);

/**
 * Handed INTO the page, where the harness bounds its own encoder waits — the
 * back-pressure drain and the flush. It must stay under EVAL_MS or the outer
 * bound fires first and the specific message ("stopped draining at frame 35 of
 * 300") is lost to the generic one. gate-bounds.test.ts asserts that ordering
 * rather than leaving it true by luck.
 *
 * The in-page bound does NOT replace the outer one. Every bound inside the page
 * is a JS timer, and a timer cannot fire while the renderer's main thread is
 * blocked — `VideoEncoder.configure()` is synchronous, and CI's encoder is a
 * paravirtualized passthrough STC-259 measured blocking past 15 s on first
 * touch. When that happens only another PROCESS can notice. This bound is for
 * the commoner case where the page is alive and the encoder simply is not
 * draining, which the outer bound can only report as "something was stuck".
 */
export const ENCODER_MS = Number(process.env.STC_GATE_ENCODER_MS ?? 120_000);
export const TEARDOWN_MS = 30_000;

/**
 * Bounded evaluates in one CI job: gate.mjs (1), export-gate.mjs (2 — runs A
 * and B), identity-gate.mjs (1). Update this when a gate gains or loses one,
 * which is what the clearance test is there to make you notice.
 */
export const EVAL_SLOTS = 4;
/** seek-gate keeps its own tighter, more informative bound (it names the last probe). */
export const SEEK_MS = 90_000;
/** What the job spends before the gates — build, typecheck, tests: ~6 min on CI, rounded up. */
export const PRE_GATE_BUDGET_MS = 8 * 60_000;
/** Vite server plus a Chrome launch, per gate. NOT the page reaching __ready. */
export const LAUNCH_MS = 30_000;

/**
 * The wait for `window.__ready`, which every gate does after `goto` and before
 * its bounded evaluate. It is a separate 60 s bound in each gate and it is NOT
 * covered by LAUNCH_MS: it includes vite's dependency optimization, which is
 * why it has a 60 s bound of its own rather than being assumed instant.
 *
 * It sits INSIDE a retried attempt — gate-retry spawns the whole of gate.mjs —
 * so leaving it out of attemptFloorMs() made that floor 60 s too low and let
 * ATTEMPT_MS sit BELOW the real cost of an attempt. Caught in review of #42,
 * before it shipped.
 */
export const READY_MS = 60_000;

/**
 * The worst case for the WHOLE job, modelled per gate rather than as a flat
 * count of evaluates.
 *
 * The flat model (PRE_GATE + EVAL_SLOTS x EVAL_MS + SEEK_MS) was correct until
 * #39 wrapped the determinism gate in a retry, and then it was silently wrong:
 * it still said 21.5 min while that one gate could now take 30 on its own. A
 * new bound has to be checked against every bound already covering the same
 * code — the lesson this file's own comment cites, missed the next time it
 * applied.
 *
 * Each gate pays its own launch and both teardown bounds; only the determinism
 * gate is retried.
 */
export function worstCaseJobMs() {
  const perGateOverhead = LAUNCH_MS + 2 * TEARDOWN_MS + READY_MS;
  const determinism = ATTEMPTS * ATTEMPT_MS;          // self-bounded, overhead included
  const exportGate = 2 * EVAL_MS + perGateOverhead;   // runs A and B
  const identity = EVAL_MS + perGateOverhead;
  const seek = SEEK_MS + perGateOverhead;
  return PRE_GATE_BUDGET_MS + determinism + exportGate + identity + seek;
}

/**
 * WHAT THIS MODEL DOES NOT COVER, stated rather than left to be discovered.
 *
 * seek-gate, export-gate and identity-gate each retry their evaluate up to 3
 * times on Playwright's "garbage collected" error, and each retry re-enters the
 * 60 s readiness wait. The model counts ONE readiness wait per gate, not three.
 *
 * Counting all of them is not the answer: the honest maximum is ~80 minutes,
 * which is not a bound anyone would set — it is so loose it stops constraining
 * anything. The real fix is structural, and is deliberately NOT done here: give
 * every gate a per-process bound the way gate-retry gives the determinism gate
 * ATTEMPT_MS, and then each gate's internals stop needing to be re-derived by
 * hand. Until then the job cap's margin absorbs it, and this comment is the
 * record that it is absorbed rather than accounted for.
 */
export const UNMODELLED_GC_RETRY_PATH = true;

/** What one determinism-gate attempt can legitimately cost. ATTEMPT_MS must clear it. */
export function attemptFloorMs() {
  return EVAL_MS + 2 * TEARDOWN_MS + LAUNCH_MS + READY_MS;
}

/**
 * How far ATTEMPT_MS must clear the floor. A bare `>` is a token margin, and
 * the floor is the MORE dangerous of the two clearances in this file: blowing
 * the job cap is a loud timeout, while crossing the floor is silent — the
 * retry keeps looking present and can no longer fire.
 */
export const FLOOR_MARGIN = 1.2;

/** Bound a promise settled by someone else's callback. `what` becomes the message. */
export function bounded(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not return within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Teardown needs its own bound. Closing a browser whose page is wedged inside a
 * never-returning encode is the same unbounded wait one step later: bounding
 * the evaluate and not the close just moves the hang into `finally`.
 */
export async function closeQuietly(browser, server) {
  for (const [what, p] of [["browser.close()", browser?.close()], ["server.close()", server?.close()]]) {
    if (!p) continue;
    try { await bounded(p, TEARDOWN_MS, what); }
    catch (e) { console.error(`  (teardown: ${e.message})`); }
  }
}
