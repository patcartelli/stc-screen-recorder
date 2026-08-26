import { describe, test, expect } from "vitest";
import { runSwiftHarness } from "./_swift-harness.js";


describe("writer gate (STC-254)", () => {
  // A first append racing teardown used to kill the helper outright — SIGSEGV
  // on CI, twice, inside AVFoundation's lazy compressor creation. The harness
  // dies by signal when it regresses, so execFileSync throwing IS the failure.
  test("a first append racing teardown does not kill the process", () => {
    const out = runSwiftHarness({
      label: "writer-gate",
      sources: [
        "helper/src/WriterGate.swift",
        "helper/test/writer-gate/main.swift",
      ],
    });
    expect(out, out).toContain("ALL PASS");
  });
}, 120_000);
