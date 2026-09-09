import { describe, test, expect } from "vitest";
import {
  EMBED_CSS_WIDTH, isCaptureSize, outputOptions, outputSizeFor, selectedOption,
} from "../src/output-size.js";

const cap = (width: number, height: number) => ({ width, height });

describe("outputSizeFor — the three rules (STC-335)", () => {
  test("BOTH DIMENSIONS ARE EVEN, over a sweep that would break a naive derivation", () => {
    // H.264's 4:2:0 cannot express an odd dimension, and `round(w / aspect)` is
    // odd about half the time. A single example would pass on the lucky half,
    // so this sweeps real capture shapes against many widths.
    const captures = [
      cap(3840, 2160), cap(2560, 1440), cap(1920, 1080), cap(1728, 1117),
      cap(3326, 2160),   // the real two-display capture from STC-247
      cap(1512, 982), cap(640, 360), cap(1080, 1920), cap(1000, 1001),
    ];
    for (const c of captures) {
      for (let w = 100; w <= 4000; w += 7) {
        const s = outputSizeFor(c, w);
        expect(s.width % 2, `${c.width}x${c.height} @ ${w} → ${s.width}`).toBe(0);
        expect(s.height % 2, `${c.width}x${c.height} @ ${w} → ${s.height}`).toBe(0);
      }
    }
  });

  test("a naive width/aspect really does produce odd heights — otherwise the sweep proves nothing", () => {
    // The control. Without it, "every height is even" is also satisfied by a
    // capture set whose aspect ratios happen to be friendly.
    const naive = (c: { width: number; height: number }, w: number) =>
      Math.round((w * c.height) / c.width);
    let odd = 0;
    for (let w = 100; w <= 4000; w += 7) if (naive(cap(1728, 1117), w) % 2 === 1) odd++;
    expect(odd).toBeGreaterThan(100);
  });

  test("the aspect ratio is the capture's, within the rounding the even rule forces", () => {
    for (const c of [cap(3840, 2160), cap(3326, 2160), cap(1728, 1117)]) {
      for (const w of [640, 1232, 2464, 3000]) {
        const s = outputSizeFor(c, w);
        expect(s.width / s.height).toBeCloseTo(c.width / c.height, 2);
      }
    }
  });

  test("the height comes from the EVENED width, so the two cannot disagree", () => {
    // 1231 is odd, so the width becomes 1232 and the height must follow 1232.
    // Deriving from 1231 is the plausible alternative and gives a different
    // answer on some shapes; this pins which one is taken.
    const c = cap(1000, 1001);
    expect(outputSizeFor(c, 1231)).toEqual(outputSizeFor(c, 1232));
  });

  test("never zero, however small the ask", () => {
    for (const w of [0, 1, -50]) {
      const s = outputSizeFor(cap(3840, 2160), w);
      expect(s.width).toBeGreaterThanOrEqual(2);
      expect(s.height).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("outputOptions — what the UI offers", () => {
  test("capture size is always present, always first, and is exactly the capture", () => {
    // The only option that resamples nothing. An odd capture is offered
    // VERBATIM — evening it would quietly change the one choice that means
    // "leave it alone".
    for (const c of [cap(3840, 2160), cap(640, 360), cap(1001, 563)]) {
      const opts = outputOptions(c);
      expect(opts[0]!.id).toBe("capture");
      expect(opts[0]!.size).toEqual(c);
      expect(opts[0]!.upscales).toBe(false);
    }
  });

  test("a 4K capture is offered both embed presets, neither upscaling", () => {
    const opts = outputOptions(cap(3840, 2160));
    expect(opts.map((o) => o.id)).toEqual(["capture", "embed-1x", "embed-2x"]);
    expect(opts[1]!.size).toEqual({ width: EMBED_CSS_WIDTH, height: 694 });
    expect(opts[2]!.size).toEqual({ width: 2464, height: 1386 });
    // 2464x1386 is the number STC-313's runbook had people typing into
    // project.json by hand. It has to come out of this function unchanged.
    expect(opts.some((o) => o.upscales)).toBe(false);
  });

  test("an option wider than the capture is RETURNED and flagged, not dropped", () => {
    // Refusing by omission makes a preset vanish, which reads as a bug in the
    // list rather than a fact about the take. The UI disables it and says why.
    const opts = outputOptions(cap(1440, 900));
    expect(opts.map((o) => o.id)).toEqual(["capture", "embed-1x", "embed-2x"]);
    expect(opts.find((o) => o.id === "embed-1x")!.upscales).toBe(false);
    expect(opts.find((o) => o.id === "embed-2x")!.upscales).toBe(true);
  });

  test("a capture already at a preset's size does not offer that size twice", () => {
    const opts = outputOptions(outputSizeFor(cap(3840, 2160), EMBED_CSS_WIDTH));
    expect(opts.map((o) => o.id)).toEqual(["capture", "embed-2x"]);
    expect(opts.find((o) => o.id === "embed-2x")!.upscales).toBe(true);
  });

  test("no two options offer the same size", () => {
    for (const c of [cap(3840, 2160), cap(2464, 1386), cap(1232, 694), cap(640, 360)]) {
      const seen = outputOptions(c).map((o) => `${o.size.width}x${o.size.height}`);
      expect(new Set(seen).size, `${c.width}x${c.height}: ${seen.join(", ")}`).toBe(seen.length);
    }
  });
});

describe("selectedOption and isCaptureSize", () => {
  const c = cap(3840, 2160);

  test("finds the option a stored output corresponds to", () => {
    expect(selectedOption(c, { width: 3840, height: 2160 })!.id).toBe("capture");
    expect(selectedOption(c, { width: 2464, height: 1386 })!.id).toBe("embed-2x");
  });

  test("A HAND-EDITED SIZE IS null, NOT 'capture'", () => {
    // The workaround this ticket replaces wrote arbitrary numbers into
    // project.json, and every take edited that way still carries one. Falling
    // back to "capture" would report a setting the document does not have and
    // then overwrite it on the next save.
    expect(selectedOption(c, { width: 1920, height: 1080 })).toBeNull();
  });

  test("isCaptureSize is exact in both dimensions", () => {
    expect(isCaptureSize(c, { width: 3840, height: 2160 })).toBe(true);
    expect(isCaptureSize(c, { width: 3840, height: 2158 })).toBe(false);
    expect(isCaptureSize(c, { width: 3838, height: 2160 })).toBe(false);
  });
});
