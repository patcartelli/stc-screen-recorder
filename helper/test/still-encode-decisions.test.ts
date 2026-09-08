import { describe, test, expect } from "vitest";
import { runSwiftHarness } from "./_swift-harness.js";
import { FORMATS, STILL_FORMATS, STILL_COLOR_SPACES } from "../../transform/src/still-export.js";

/**
 * STC-293: the still export path's decisions, and the one place the Swift
 * encoder and the TypeScript planner are checked against each other.
 *
 * The Swift harness asserts the pure half — request parsing, the bitmap
 * layout, which ImageIO properties a request implies, the EXIF date format —
 * and PRINTS its format table. This side reads that table and compares it to
 * `FORMATS` in `transform/src/still-export.ts`.
 *
 * That comparison is the point. The ticket's Note demands one encoder, and the
 * shape this codebase's "one value, two copies" defects have taken every time
 * is not a second implementation, it is a second LIST: a format added on one
 * side and not the other, or a UTI that drifts from the extension. There is no
 * way to have a single list here (one side is Swift, the other TypeScript), so
 * the next best thing is a test that fails the moment they disagree — the same
 * arrangement `cursor-shape-names.test.ts` has for the pointer shapes.
 */
describe("still export decisions (STC-293)", () => {
  test("Swift pure-function assertions pass, and its format table matches the transform's", async () => {
    const out = await runSwiftHarness({
      label: "still-encode",
      sources: [
        "helper/src/StillEncodeDecisions.swift",
        "helper/test/still-encode/main.swift",
      ],
    });
    expect(out, out).toContain("ALL PASS");

    const swiftFormats = out.split("\n")
      .filter((l) => l.startsWith("format "))
      .map((l) => {
        const m = /^format (\S+) (\S+) alpha=(true|false) lossy=(true|false)$/.exec(l);
        if (!m) throw new Error(`unparseable harness line: ${l}`);
        return { name: m[1]!, uti: m[2]!, alpha: m[3] === "true", lossy: m[4] === "true" };
      });

    // Named rather than counted: a harness that stopped printing one format
    // must be a failure here, not a quietly smaller sample.
    expect(swiftFormats.map((f) => f.name).sort()).toEqual([...STILL_FORMATS].sort());

    for (const f of swiftFormats) {
      const ts = FORMATS[f.name as keyof typeof FORMATS];
      expect(ts, `the transform has no format "${f.name}"`).toBeDefined();
      expect(f.uti, `${f.name}: UTI`).toBe(ts.uti);
      expect(f.alpha, `${f.name}: carries alpha`).toBe(ts.alpha);
      expect(f.lossy, `${f.name}: lossy`).toBe(ts.lossy);
    }

    const swiftSpaces = out.split("\n")
      .filter((l) => l.startsWith("colorspace "))
      .map((l) => l.slice("colorspace ".length).trim());
    expect(swiftSpaces.sort()).toEqual([...STILL_COLOR_SPACES].sort());
  });
});
