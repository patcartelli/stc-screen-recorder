import { describe, test, expect } from "vitest";
import { runSwiftHarness } from "./_swift-harness.js";


describe("capture decisions", () => {
  test("Swift pure-function assertions all pass", () => {
    const out = runSwiftHarness({
      label: "dec",
      sources: [
        "helper/src/CaptureDecisions.swift",
        "helper/test/decisions/main.swift",
      ],
    });
    expect(out, out).toContain("ALL PASS");
  });
}, 60_000);
