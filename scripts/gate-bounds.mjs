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
export const EVAL_MS = Number(process.env.STC_GATE_EVAL_MS ?? 180_000);
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
