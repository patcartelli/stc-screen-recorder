import { describe, test, expect } from "vitest";
import { runSwiftHarness, HARNESS_RUN_MS } from "./_swift-harness.js";


describe("writer gate (STC-254)", () => {
  // A first append racing teardown used to kill the helper outright — SIGSEGV
  // on CI, twice, inside AVFoundation's lazy compressor creation. The harness
  // dies by signal when it regresses, so execFileSync throwing IS the failure.
  test("a first append racing teardown does not kill the process", async () => {
    const out = await runSwiftHarness({
      label: "writer-gate",
      sources: [
        "helper/src/WriterGate.swift",
        "helper/test/writer-gate/main.swift",
      ],
    });
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
}, 120_000);
