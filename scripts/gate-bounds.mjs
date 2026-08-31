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

/**
 * How many times the determinism gate is attempted, and the bound on ONE
 * attempt.
 *
 * These live HERE, with the other bounds, and gate-retry imports them — not the
 * other way round. #42 put them in gate-retry and had this file import them,
 * which was right while gate-retry was the only runner; once every gate is
 * bounded from GATE_PROCESS_MS below, that direction becomes a cycle
 * (gate-bounds -> gate-retry -> gate-bounds) and ESM deadlocks on the top-level
 * await rather than failing clearly. One direction: gate-retry depends on
 * bounds, bounds depend on nothing.
 *
 * ATTEMPT_MS must clear attemptFloorMs() — see gate-bounds.test.ts. It was
 * 600_000 in #39, which made ATTEMPTS x 10 min = the entire job cap for this
 * gate alone.
 */
/**
 * How many times the determinism gate is attempted before it is called a SKIP.
 *
 * ONE, deliberately, since 2026-08-30. It was 3, and measurement says the extra
 * two are pure cost: across 19 consecutive CI runs the gate skipped EVERY time,
 * all three attempts failing identically at the same bound, and attempts 2 and 3
 * never once succeeded where attempt 1 failed. That is 7 minutes of CI per run
 * spent re-learning what attempt 1 already reported.
 *
 * A retry is for a fault that is genuinely per-attempt. This one is not: the
 * signature is a WEDGED RENDERER (the outer EVAL_MS bound fires and
 * `browser.close()` then hangs its full TEARDOWN_MS), which a fresh attempt in
 * the same job inherits. See docs/STC-259-GATE-SKIP-RATE.md.
 *
 * Restoring it is a one-line change and the retry loop stays fully tested at
 * whatever value this holds — but do not restore it without re-measuring, or the
 * 7 minutes come back for the same nothing. The number to check first is
 * `node scripts/gate-skip-rate.mjs`.
 */
export const ATTEMPTS = 1;
export const ATTEMPT_MS = 420_000;

/** Per-evaluate bound. Override for experiments; CI uses the default. */
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
/**
 * The whole `npm run test:slow` step, bounded as ONE process the way each gate
 * is — not as a sum of per-test timeouts, which is the model that rots.
 *
 * 81 s on this machine against the committed fixture (it was 171 s while it
 * still reached for a real 4K take on the Desktop, which is also why it could
 * never run on CI). 12 min is ~9x that: an allowance for a contended runner,
 * not a calibration.
 *
 * The step's `timeout-minutes` in ci.yml must equal this, and
 * gate-bounds.test.ts asserts it rather than trusting the two to be kept in
 * step by hand.
 */
export const SLOW_TESTS_MS = 720_000;

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
/**
 * Collects the page's own progress checkpoints, so a WEDGED renderer can still
 * say where it stopped.
 *
 * Mode B is the failure where the renderer's main thread blocks: no in-page
 * timer fires, no promise settles, `page.evaluate` never returns, and
 * `browser.close()` then hangs its full teardown. Nothing readable from inside
 * the page survives it — which is why every in-page bound is useless here and
 * why these runs historically said nothing at all.
 *
 * A console message is the exception. It crosses to this process over CDP AS IT
 * IS MADE, so a mark logged immediately before a blocking call is already here
 * when that call wedges. The last line of the trail names the call.
 *
 * Arrival times are stamped by this process, not the page: a wedged renderer
 * cannot be trusted to timestamp anything, and the gap before the silence is
 * exactly the interesting number.
 */
export async function instrumentPage(page, { keep = 40 } = {}) {
  // The wedge injection has to be installed BEFORE any page script runs, which
  // is what addInitScript is for. Bundled with the trail so a gate cannot wire
  // one without the other and end up with a fault nothing observes.
  const fault = process.env.STC_GATE_FAULT ?? "";
  if (fault.startsWith("wedge:")) {
    await page.addInitScript((at) => { window.__wedgeAt = at; }, fault.slice("wedge:".length));
  }
  return attachCheckpointTrail(page, { keep });
}

export function attachCheckpointTrail(page, { keep = 40 } = {}) {
  const t0 = Date.now();
  const trail = [];
  page.on("console", (m) => {
    const text = m.text();
    if (!text.startsWith("[gate-mark")) return;
    trail.push(`+${String(Date.now() - t0).padStart(7)} ms  ${text}`);
    if (trail.length > keep) trail.shift();
  });
  return {
    get length() { return trail.length; },
    dump(write = (s) => console.error(s)) {
      if (!trail.length) {
        write("--- NO in-page checkpoints arrived ---");
        write("    The page never reached its first mark, so the wedge is before");
        write("    runGate's first statement — page load, module eval, or the");
        write("    readiness probe itself.");
        return;
      }
      write(`--- last ${trail.length} in-page checkpoints before the bound fired ---`);
      for (const l of trail) write("  " + l);
      write("    ^ the wedge is in whatever follows the LAST line.");
    },
  };
}

export function worstCaseJobMs({ attempts = GATE_ATTEMPTS } = {}) {
  // PRE_GATE_BUDGET_MS covers build, typecheck and `npm test`; the slow suite
  // is a separate step with its own process bound, so it is a separate term.
  let total = PRE_GATE_BUDGET_MS + SLOW_TESTS_MS;
  for (const [script, ms] of Object.entries(GATE_PROCESS_MS)) {
    total += ms * (attempts[script] ?? 1);
  }
  return total;
}

/**
 * How many times a gate re-enters its readiness wait.
 *
 * seek-gate, export-gate and identity-gate retry their evaluate on Playwright's
 * "garbage collected" error, and each retry goes back through the 60 s wait.
 * gate.mjs has no such loop. Declared rather than absorbed: the previous model
 * counted one wait per gate and said so in a comment, which is a caveat, not a
 * bound.
 */
export const GC_RETRIES = 3;

/**
 * What ONE run of each gate legitimately costs — its own inner bounds, summed
 * along the longest path it can legally take.
 *
 * This is the only place a gate's internals appear. The job's worst case is a
 * sum of PROCESS bounds (below), so internals inform whether each bound is
 * generous enough and nothing else: get this slightly wrong and a bound fires
 * early and says so, rather than a model silently under-counting.
 */
export function gateFloorMs(script) {
  const launchAndTeardown = LAUNCH_MS + 2 * TEARDOWN_MS;
  switch (script) {
    // One evaluate, one readiness wait, no GC-retry loop. Kept identical to
    // attemptFloorMs() — this is the same gate, and two floors for one script
    // would be exactly the drift this file exists to stop.
    case "gate.mjs":          return attemptFloorMs();
    // Runs A and B: two bounded evaluates.
    case "export-gate.mjs":   return launchAndTeardown + GC_RETRIES * READY_MS + 2 * EVAL_MS;
    case "identity-gate.mjs": return launchAndTeardown + GC_RETRIES * READY_MS + EVAL_MS;
    // Its own tighter, more informative bound instead of EVAL_MS.
    case "seek-gate.mjs":     return launchAndTeardown + GC_RETRIES * READY_MS + SEEK_MS;
    default: throw new Error(`no floor declared for scripts/${script}`);
  }
}

/**
 * The bound the RUNNER enforces on each gate process, and the whole of the
 * job's worst case.
 *
 * Before this, only the determinism gate had one (ATTEMPT_MS via gate-retry);
 * the other three ran unbounded and the model guessed at their internals. That
 * guess had already gone wrong twice — once by omitting the retry entirely, and
 * once by omitting the readiness wait — and on 2026-08-28 an unbounded seek
 * gate held a CI job to its 30-minute cap after failing in 10 seconds.
 *
 * A process bound cannot be under-counted the way a model can: whatever the
 * gate does inside, it cannot exceed this, so worstCaseJobMs() is a SUM rather
 * than an estimate and the GC-retry path is covered rather than absorbed.
 */
export const GATE_PROCESS_MS = {
  "gate.mjs": ATTEMPT_MS,                 // per attempt; retried, see GATE_ATTEMPTS
  "export-gate.mjs": 780_000,
  "identity-gate.mjs": 560_000,
  "seek-gate.mjs": 450_000,
};

/** Only the determinism gate is retried; the rest run once. */
export const GATE_ATTEMPTS = {
  "gate.mjs": ATTEMPTS,
};

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
      timer = setTimeout(() => {
        // `what` may be a thunk, evaluated HERE rather than at call time, so a
        // caller can fold in state that only exists once the bound fires — how
        // far a run had got, which probe was last. seek-gate hand-rolled its own
        // setTimeout to get that, and paid for it: the error it threw carried no
        // `boundFired` tag, so a Mode B wedge there reported FAIL: and reddened
        // CI for a machine fault.
        const label = typeof what === "function" ? what() : what;
        const e = new Error(`${label} did not return within ${ms} ms`);
        // TAGGED, so a gate can tell "my bound fired" from "I found a wrong
        // answer" by asking the error rather than by matching its text. A gate
        // with one catch-all had no other option and gate.mjs matches strings
        // for exactly that reason; this removes the need to invent that list
        // again in every gate that grows a catch.
        e.boundFired = true;
        reject(e);
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Did this failure come from a bound firing, rather than from the gate finding
 * a wrong answer?
 *
 * Structural first: `bounded()` tags its own timeouts. The patterns are the
 * fallback for bounds that fire INSIDE the page — those reject across the
 * process boundary as plain Errors and cannot carry a property. One shared list
 * so each gate does not invent its own and drift.
 */
const IN_PAGE_BOUND = [
  /did not complete within \d+ ?ms/,   // an in-page bound (decoder, encoder)
  /did not return within \d+ ?ms/,     // the out-of-process bound on the page
];
export function isBoundFailure(e) {
  if (e && typeof e === "object" && e.boundFired === true) return true;
  const msg = String(e?.stack ?? e ?? "");
  return IN_PAGE_BOUND.some((re) => re.test(msg));
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
