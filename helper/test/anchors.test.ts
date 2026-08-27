import { describe, test, expect } from "vitest";
import { runSwiftHarness } from "./_swift-harness.js";

describe("anchors document", () => {
  test("Swift anchors assertions all pass", async () => {
    const out = await runSwiftHarness({
      label: "anchors",
      sources: [
        "helper/src/AnchorsDoc.swift",
        "helper/test/anchors/main.swift",
      ],
    });
    expect(out, out).toContain("ALL PASS");
  });
}, 60_000);
