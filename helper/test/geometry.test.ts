import { describe, test, expect } from "vitest";
import { runSwiftHarness } from "./_swift-harness.js";


describe("capture geometry", () => {
  test("Swift pure-function assertions all pass", async () => {
    const out = await runSwiftHarness({
      label: "geom",
      sources: [
        "helper/src/CaptureGeometry.swift",
        "helper/test/geometry/main.swift",
      ],
    });
    expect(out, out).toContain("ALL PASS");
  });
}, 60_000);
