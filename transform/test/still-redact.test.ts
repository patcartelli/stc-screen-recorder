import { describe, test, expect } from "vitest";
import {
  meanLuminance, fillForLuminance, normaliseRegion, undoLast,
  REDACTION_FILL_ON_LIGHT, REDACTION_FILL_ON_DARK, REDACTION_LUMINANCE_THRESHOLD,
} from "../src/still-redact.js";

/**
 * STC-297's decisions, with no canvas and no pointer.
 *
 * What is left for the browser is whether the fill LANDS on the right pixels
 * (`npm run gate:still`) and whether it reads as deliberate to an eye
 * (`docs/STC-297-RUNBOOK.md`). Everything here is arithmetic.
 */

/** `n` pixels of one RGBA colour. */
const px = (n: number, r: number, g: number, b: number, a = 255) =>
  Uint8ClampedArray.from(Array.from({ length: n }, () => [r, g, b, a]).flat());

describe("meanLuminance", () => {
  test("white is 1 and black is 0", () => {
    expect(meanLuminance(px(4, 255, 255, 255))).toBeCloseTo(1, 6);
    expect(meanLuminance(px(4, 0, 0, 0))).toBeCloseTo(0, 6);
  });

  test("the channels are weighted, not averaged — green carries most of it", () => {
    // A flat average would make all three of these identical; Rec. 709 does not.
    const red = meanLuminance(px(1, 255, 0, 0));
    const green = meanLuminance(px(1, 0, 255, 0));
    const blue = meanLuminance(px(1, 0, 0, 255));
    expect(green).toBeGreaterThan(red);
    expect(red).toBeGreaterThan(blue);
    expect(green).toBeCloseTo(0.7152, 4);
    expect(blue).toBeCloseTo(0.0722, 4);
  });

  test("mixes average across pixels", () => {
    const half = Uint8ClampedArray.from([...px(1, 255, 255, 255), ...px(1, 0, 0, 0)]);
    expect(meanLuminance(half)).toBeCloseTo(0.5, 6);
  });

  test("fully transparent pixels are not counted as black", () => {
    // A window capture's rounded corner is rgba(0,0,0,0). Counting it as black
    // would drag a region near the corner toward "dark content" and put a
    // near-white box on a light window.
    const withCorner = Uint8ClampedArray.from([
      ...px(2, 255, 255, 255),
      ...px(2, 0, 0, 0, 0),
    ]);
    expect(meanLuminance(withCorner)).toBeCloseTo(1, 6);
  });

  test("partial alpha weighs proportionally", () => {
    const mixed = Uint8ClampedArray.from([
      ...px(1, 255, 255, 255, 255),
      ...px(1, 0, 0, 0, 127),
    ]);
    // white at weight 1, black at weight ~0.498 -> ~0.667
    expect(meanLuminance(mixed)).toBeCloseTo(1 / (1 + 127 / 255), 3);
  });

  test("an entirely transparent region reports light rather than dividing by zero", () => {
    expect(meanLuminance(px(4, 0, 0, 0, 0))).toBe(1);
    expect(meanLuminance(new Uint8ClampedArray())).toBe(1);
  });

  test("a trailing partial pixel is ignored rather than read out of bounds", () => {
    const ragged = Uint8ClampedArray.from([255, 255, 255, 255, 0, 0]);
    expect(meanLuminance(ragged)).toBeCloseTo(1, 6);
  });
});

describe("fillForLuminance", () => {
  test("light content takes the near-black fill, dark content the near-white", () => {
    expect(fillForLuminance(0.9)).toBe(REDACTION_FILL_ON_LIGHT);
    expect(fillForLuminance(0.1)).toBe(REDACTION_FILL_ON_DARK);
  });

  test("the tie falls to light, and it is stated rather than incidental", () => {
    expect(fillForLuminance(REDACTION_LUMINANCE_THRESHOLD)).toBe(REDACTION_FILL_ON_LIGHT);
  });

  test("neither fill is pure black or pure white — a fill must read as deliberate", () => {
    expect(REDACTION_FILL_ON_LIGHT).not.toBe("#000000");
    expect(REDACTION_FILL_ON_DARK).not.toBe("#ffffff");
  });

  test("both fills are opaque colours — no alpha channel anywhere near them", () => {
    // The ticket forbids partial alpha. A 6-digit hex cannot express one, so
    // this is the shape of the constant doing the enforcing.
    for (const fill of [REDACTION_FILL_ON_LIGHT, REDACTION_FILL_ON_DARK]) {
      expect(fill).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("normaliseRegion", () => {
  const frame = { width: 800, height: 400 };

  test("a drag becomes a normalised rectangle", () => {
    expect(normaliseRegion({ x: 200, y: 100 }, { x: 400, y: 300 }, frame))
      .toEqual({ x: 0.25, y: 0.25, width: 0.25, height: 0.5 });
  });

  test("dragging up-left gives the same region as dragging down-right", () => {
    const down = normaliseRegion({ x: 200, y: 100 }, { x: 400, y: 300 }, frame);
    const up = normaliseRegion({ x: 400, y: 300 }, { x: 200, y: 100 }, frame);
    expect(up).toEqual(down);
  });

  test("a drag off the edge clamps instead of being refused", () => {
    // Covering something at the margin means dragging past it; refusing that
    // would be the panel declining to do the obvious thing.
    expect(normaliseRegion({ x: 600, y: 200 }, { x: 5000, y: -80 }, frame))
      .toEqual({ x: 0.75, y: 0, width: 0.25, height: 0.5 });
  });

  test("a click is not a region", () => {
    expect(normaliseRegion({ x: 100, y: 100 }, { x: 100, y: 100 }, frame)).toBeUndefined();
    expect(normaliseRegion({ x: 100, y: 100 }, { x: 102, y: 140 }, frame)).toBeUndefined();
    expect(normaliseRegion({ x: 100, y: 100 }, { x: 140, y: 102 }, frame)).toBeUndefined();
  });

  test("the caller may raise the minimum — a preview pixel is many capture pixels", () => {
    const small = { x: 100, y: 100 };
    const nearby = { x: 130, y: 130 };
    expect(normaliseRegion(small, nearby, frame)).toBeDefined();
    expect(normaliseRegion(small, nearby, frame, 40)).toBeUndefined();
  });

  test("a frame with no area has no regions to place on it", () => {
    expect(normaliseRegion({ x: 0, y: 0 }, { x: 10, y: 10 }, { width: 0, height: 100 }))
      .toBeUndefined();
  });

  test("every region it returns is one parseShot would accept", () => {
    // The schema's rule: inside 0..1, positive extent, and x+width <= 1.
    const r = normaliseRegion({ x: -50, y: -50 }, { x: 9000, y: 9000 }, frame)!;
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
    expect(r.x + r.width).toBeLessThanOrEqual(1);
    expect(r.y + r.height).toBeLessThanOrEqual(1);
  });
});

describe("undoLast", () => {
  const a = { x: 0, y: 0, width: 0.1, height: 0.1 };
  const b = { x: 0.5, y: 0.5, width: 0.2, height: 0.2 };

  test("drops the most recent region and leaves the rest", () => {
    expect(undoLast([a, b])).toEqual([a]);
  });

  test("undoing nothing is not an error", () => {
    expect(undoLast([])).toEqual([]);
  });

  test("does not mutate what it was given", () => {
    const regions = [a, b];
    undoLast(regions);
    expect(regions).toHaveLength(2);
  });
});
