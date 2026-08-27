import { describe, test, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSwiftHarness, HARNESS_RUN_MS } from "./_swift-harness.js";

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


describe("writer gate (STC-254)", () => {
  // A first append racing teardown used to kill the helper outright — SIGSEGV
  // on CI, twice, inside AVFoundation's lazy compressor creation. The harness
  // dies by signal when it regresses, so execFileSync throwing IS the failure.
  test("a first append racing teardown does not kill the process", async (ctx) => {
    let out: string;
    try {
      out = await runSwiftHarness({
        label: "writer-gate",
        sources: [
          "helper/src/WriterGate.swift",
          "helper/test/writer-gate/main.swift",
        ],
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

    // The harness's bound on an encoder query must stay clear of the runner's
    // bound on the whole harness. Set them near each other and the runner wins
    // the race, the harness's explanation is never printed, and the run reads
    // as an unexplained stall — which is what all five STC-259 sightings were.
    // Checked against the real values rather than kept in step by hand.
    const bound = out.match(/encoder query bound (\d+) ms/);
    expect(bound, out).not.toBeNull();
    expect(Number(bound![1]) * 2).toBeLessThanOrEqual(HARNESS_RUN_MS);
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
      sources: [
        "helper/src/WriterGate.swift",
        "helper/test/writer-gate/main.swift",
      ],
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
      "WriterGate regression. The race assertions never ran.\n";

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
      sources: [
        "helper/src/WriterGate.swift",
        "helper/test/writer-gate/main.swift",
      ],
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
