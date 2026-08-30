import { describe, test, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runSwiftHarness,
  HARNESS_RUN_MS,
  HARNESS_DEADLINE_MS,
  HARNESS_EXIT_MARGIN_MS,
} from "./_swift-harness.js";

/**
 * The harness said the MACHINE declined, not that WriterGate regressed.
 *
 * Keyed strictly on the marker the harness prints on that one path. A death by
 * signal or a failed assertion must never match: retrying or skipping those
 * would discard the exact regression this file exists to catch, and STC-254
 * already arrived once wearing an environment failure's clothes.
 */
const isEnvironmentFailure = (m: string) =>
  m.includes("ENVIRONMENT:") && !/died by signal/.test(m) && !m.includes("FAIL:");

/**
 * A skipped gate has to be loud. CLAUDE.md's standing warning is about success
 * by finding nothing to do, in a place where success reads as verification —
 * so this prints an Actions annotation that survives into the run summary
 * rather than a green tick that says nothing happened.
 */
function announceSkip(detail: string) {
  const line =
    "WriterGate regression gate DID NOT RUN — the machine could not provide an " +
    "H.264 encoder after repeated attempts (STC-259). This is not a pass.";
  // process.stderr, NOT console.warn. Vitest attributes console output to the
  // test that produced it and DISCARDS it for a skipped one — verified: the
  // annotation vanished entirely. A skip notice that only prints when it is not
  // needed is the silent skip this exists to prevent.
  if (process.env.GITHUB_ACTIONS) {
    process.stderr.write(`::warning title=WriterGate gate skipped::${line}\n`);
  }
  process.stderr.write(`\n${line}\n${detail.slice(-600)}\n`);
}


const SOURCES = [
  "helper/src/WriterGate.swift",
  "helper/test/writer-gate/main.swift",
];

/**
 * The runner's observed process lifetime MINUS the deadline that process was
 * handed: spawn, Swift runtime init, and the watchdog's print and `_exit`.
 * Worst of 8 runs on this machine, 2026-08-31. This is the quantity
 * HARNESS_EXIT_MARGIN_MS exists to cover.
 */
const MEASURED_OVERSHOOT_MS = 26;

/**
 * CI's runner is a contended VM and process spawn is exactly what it is slow
 * at. Unlike the number above this one is an ALLOWANCE, not a measurement, and
 * it is the only unverified term here.
 */
const CI_HEADROOM = 20;

describe("writer gate (STC-254)", () => {
  // The margin has to be checked against what it COVERS, not against itself.
  //
  // The in-run assertion below — `HARNESS_RUN_MS - deadline >= margin` — is a
  // tautology as long as the deadline is DEFINED as that subtraction: it stays
  // green with the margin set to zero, at which point the harness's deadline
  // and the runner's kill coincide and the harness's explanation always loses
  // the race. That is "a bound's own slack hides a missing term in its floor"
  // in its purest form, and this repo has now shipped it three times. This is
  // the assertion that makes the magnitude falsifiable.
  test("the exit margin covers the overshoot it exists to cover", () => {
    expect(HARNESS_EXIT_MARGIN_MS).toBeGreaterThanOrEqual(
      MEASURED_OVERSHOOT_MS * CI_HEADROOM,
    );
    // Strictly inside the kill, never merely equal to it.
    expect(HARNESS_DEADLINE_MS).toBeLessThan(HARNESS_RUN_MS);
  });

  // A first append racing teardown used to kill the helper outright — SIGSEGV
  // on CI, twice, inside AVFoundation's lazy compressor creation. The harness
  // dies by signal when it regresses, so execFileSync throwing IS the failure.
  test("a first append racing teardown does not kill the process", async (ctx) => {
    let out: string;
    try {
      out = await runSwiftHarness({
        label: "writer-gate",
        sources: SOURCES,
        // STC-259, observed for real on run 33102859258: VTCopyVideoEncoderList
        // blocked past 15 s on a contended runner with nothing injected. The
        // refusal is per-process, so another attempt may get an encoder. Only
        // the run is retried — the compile is not repeated.
        retryRun: { attempts: 3, when: isEnvironmentFailure },
      });
    } catch (e) {
      const msg = (e as Error).message;
      // Anything that is NOT the machine declining is a real failure and is
      // rethrown untouched, including a death by signal.
      if (!isEnvironmentFailure(msg)) throw e;
      announceSkip(msg);
      return ctx.skip();
    }
    expect(out, out).toContain("ALL PASS");

    // Every bound the harness holds is echoed on stdout and checked here
    // against the runner's own, rather than kept in step by hand. The chain
    // that has to hold, innermost first:
    //
    //   each specific bound  <=  the harness's deadline  <=  the runner's kill
    //                                                        minus room to print
    //
    // Break any link and the harness dies mute, which is what all five STC-259
    // sightings looked like from outside. Asserted as a COMPOSITION — each term
    // named and required — because a bound's own slack will otherwise hide a
    // missing one, which has already happened twice in this repo.
    const echoed = (label: string) => {
      const m = out.match(new RegExp(`${label} (\\d+) ms`));
      expect(m, `the harness must echo its ${label}\n${out}`).not.toBeNull();
      return Number(m![1]);
    };

    // The handoff is WIRED: this number reached the harness from the runner
    // rather than being one the harness chose for itself.
    const deadline = echoed("harness deadline");
    expect(deadline, out).toBe(HARNESS_DEADLINE_MS);
    // ...and it leaves the harness room to print its explanation and exit
    // before the runner kills it.
    expect(HARNESS_RUN_MS - deadline, out).toBeGreaterThanOrEqual(HARNESS_EXIT_MARGIN_MS);

    // Each specific bound has to be able to fire BEFORE the generic watchdog,
    // or the message naming WHICH call wedged is unreachable and every stall
    // reports the same shrug.
    for (const label of ["encoder query bound", "first append bound"]) {
      expect(echoed(label), `${label} must be able to fire before the deadline\n${out}`)
        .toBeLessThanOrEqual(deadline);
    }
  });

  // STC-259 step 2. The last first touch of the encoder this harness left
  // unbounded, and the one both original STC-254 crash reports pointed at: an
  // AVAssetWriter creates its video compressor lazily on the FIRST append, and
  // where no encoder can be had it does not fail, it blocks. Before this bound
  // a run wedged there printed "phase 2: live-gate append" and then nothing,
  // until the runner killed it 45 s later with no idea why.
  test("a hung FIRST APPEND fails as ENVIRONMENT, not as a WriterGate regression", async () => {
    const err = await runSwiftHarness({
      label: "writer-gate-append-hang",
      sources: SOURCES,
      // Fires in a second and a half rather than the production fifteen. The
      // production value's clearance is checked above, against the runner's.
      env: { STC_WG_FAULT: "first-append-hang", STC_WG_APPEND_BOUND_MS: "1500" },
    }).then(() => null, (e: Error) => e);

    expect(err, "a wedged first append must not be reported as a pass").not.toBeNull();
    const msg = err!.message;

    // THE assertion, same as for the encoder queries: our bound has to win the
    // race against the runner's, or its message never reaches anyone.
    expect(msg, msg).not.toContain("did not finish within");
    expect(msg, msg).toContain("ENVIRONMENT:");
    // Names the call, not merely the phase. "Something in phase 2" is the
    // vagueness this bound exists to replace.
    expect(msg, msg).toMatch(/first AVAssetWriter append/);
    expect(msg, msg).not.toMatch(/died by signal/);
  });

  // The race loop's 120 appends are deliberately inline and individually
  // unbounded: the race under test is between the appending thread and the
  // teardown thread, and wrapping the append would insert a third thread and a
  // dispatch of unknown latency between them — the one edit that could quietly
  // stop this harness reproducing STC-254 while still passing. The deadline
  // watchdog covers them instead, and a watchdog that cannot say WHERE it fired
  // reports exactly the nothing the runner's kill already reports.
  //
  // 3 s against the 124 ms this harness takes to reach the race loop on this
  // machine — a measured ratio, not a picked number.
  test("a stall with no specific bound is caught by the deadline, and named", async () => {
    const err = await runSwiftHarness({
      label: "writer-gate-deadline",
      sources: SOURCES,
      env: { STC_WG_FAULT: "race-append-hang", STC_HARNESS_DEADLINE_MS: "3000" },
    }).then(() => null, (e: Error) => e);

    expect(err, "a wedged race-loop append must not be reported as a pass").not.toBeNull();
    const msg = err!.message;

    expect(msg, msg).not.toContain("did not finish within");
    expect(msg, msg).toContain("ENVIRONMENT:");
    expect(msg, msg).not.toMatch(/died by signal/);
    // Named. If this ever fails the message carries the real checkpoint, which
    // is the whole feature working.
    expect(msg, msg).toMatch(/race iteration \d+ of \d+/);
  });

  // A bound a process picks for itself is a bound nobody compares against the
  // one that will actually kill it, so an unset deadline is refused outright
  // rather than defaulted — the same rule `gate-run.mjs` applies to the gates.
  //
  // And the refusal must NOT read as the machine declining: retrying a wiring
  // mistake three times and announcing a skip is precisely how a gate stops
  // running without anyone noticing.
  test("the harness refuses to run without being handed its deadline", async () => {
    const err = await runSwiftHarness({
      label: "writer-gate-no-deadline",
      sources: SOURCES,
      env: { STC_HARNESS_DEADLINE_MS: "" },
    }).then(() => null, (e: Error) => e);

    expect(err, "an unwired bound must not read as a pass").not.toBeNull();
    expect(err!.message, err!.message).toMatch(/will not run without knowing/);
    expect(isEnvironmentFailure(err!.message), err!.message).toBe(false);
  });

  // STC-259. Five CI sightings, and the fifth discriminated: "harness started"
  // printed, the encoder inventory line did not. VTCopyVideoEncoderList blocked
  // and never returned. CI's encoder is `paravirtualized:Apple Video Encoder`,
  // a passthrough to a host shared with other tenants, so any FIRST touch of it
  // can block indefinitely there.
  //
  // The fault is injected because the real one is a contended CI host we cannot
  // summon. What is being tested is the bound, not VideoToolbox: a bound nobody
  // has watched fire is indistinguishable from one that cannot fire, and three
  // bounds added to this harness in a single day each failed to fire for a
  // different reason.
  test("a hung encoder query fails as ENVIRONMENT, not as a WriterGate regression", async () => {
    const err = await runSwiftHarness({
      label: "writer-gate-hang",
      sources: SOURCES,
      // Short bound so this costs a second rather than the production fifteen.
      // What is under test is that the bound fires and says so; the production
      // value's clearance is checked above, against the runner's own.
      env: { STC_WG_FAULT: "encoder-query-hang", STC_WG_ENCODER_BOUND_MS: "1500" },
    }).then(() => null, (e: Error) => e);

    expect(err, "a wedged encoder query must not be reported as a pass").not.toBeNull();
    const msg = err!.message;

    // THE assertion. Our bound has to win the race against runSwiftHarness's
    // 45 s outer bound, or its message never reaches anyone and the run reads
    // as an unexplained stall — which is exactly the five sightings. An inner
    // bound that loses this race is decorative.
    expect(msg, msg).not.toContain("did not finish within");

    // Distinguishable from the regression this harness exists to catch. The
    // trap that cost an afternoon was an environment failure wearing the
    // crash's clothes.
    expect(msg, msg).toContain("ENVIRONMENT:");
    expect(msg, msg).toMatch(/encoder query/i);
    expect(msg, msg).toContain("NOT a");
    expect(msg, msg).not.toMatch(/died by signal/);
  });

  // The retry exists to absorb a contended host. It must never absorb the
  // regression. These are the real message shapes runSwiftHarness produces.
  describe("what counts as the machine declining", () => {
    const envFailure =
      "writer-gate: harness exited 2.\nstdout tail:\nencoder query bound 15000 ms\n" +
      "ENVIRONMENT: the encoder query VTCopyVideoEncoderList did not answer within 15000 ms\n" +
      "This is the machine declining to provide what the harness needs, NOT a\n" +
      "WriterGate regression. The race assertions did not complete.\n";

    test("a wedged encoder is the machine declining", () => {
      expect(isEnvironmentFailure(envFailure)).toBe(true);
    });

    // THE case that matters. STC-254 killed the harness by SIGTRAP on CI and
    // SIGSEGV locally. If either were ever treated as an environment failure,
    // the regression would be retried three times and then reported as a skip.
    test("a death by signal is NOT, even alongside an ENVIRONMENT line", () => {
      expect(isEnvironmentFailure(
        "writer-gate: harness died by signal SIGTRAP.\nstdout tail:\n",
      )).toBe(false);
      expect(isEnvironmentFailure(
        "writer-gate: harness died by signal SIGSEGV.\nstdout tail:\nENVIRONMENT: stale\n",
      )).toBe(false);
    });

    test("a failed race assertion is NOT", () => {
      expect(isEnvironmentFailure(
        "writer-gate: harness exited 1.\nstdout tail:\nFAIL: append after close must drop\n",
      )).toBe(false);
    });

    test("a timeout is NOT — that is the stall, and it must stay visible", () => {
      expect(isEnvironmentFailure(
        "writer-gate: harness did not finish within 45000 ms; killed its process group.",
      )).toBe(false);
    });
  });

  // A retry nobody has watched happen is the same trap as a bound nobody has
  // watched fire. The harness logs one line per start, so the count is read
  // from the machine rather than assumed from the code.
  test("an environment failure is retried, and the run is retried but not the compile", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "stc-wg-retry-")), "attempts");
    const err = await runSwiftHarness({
      label: "writer-gate-retry",
      sources: SOURCES,
      env: {
        STC_WG_FAULT: "encoder-query-hang",
        STC_WG_ENCODER_BOUND_MS: "300",
        STC_WG_ATTEMPT_LOG: log,
      },
      retryRun: { attempts: 3, when: isEnvironmentFailure },
    }).then(() => null, (e: Error) => e);

    expect(err, "a persistently wedged encoder must still end as a failure").not.toBeNull();
    expect(isEnvironmentFailure(err!.message), err!.message).toBe(true);
    // Three starts, not one: the run really was retried.
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(3);
  });
}, 120_000);
