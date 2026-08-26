import { describe, test, expect } from "vitest";
import { runSwiftHarness } from "./_swift-harness.js";


describe("lossy ring buffer", () => {
  test("Swift ring assertions all pass", () => {
    const out = runSwiftHarness({
      label: "ring",
      sources: [
        "helper/src/Ring.swift",
        "helper/test/ring/main.swift",
      ],
    });
    expect(out, out).toContain("ALL PASS");
  });
}, 60_000);
