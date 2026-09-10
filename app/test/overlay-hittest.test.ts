import { describe, test, expect } from "vitest";
import { HANDLES, HANDLE_GRAB_PADDING, handleAt, handlePoint } from "../src/overlay-hittest.js";
import type { Rect } from "../src/selection.js";

/**
 * The overlay's hit-testing, without a screen (STC-290's decisions again).
 *
 * `handlePoint`/`handleAt` were never unit tested — they lived in `overlay.ts`,
 * which runs `document.getElementById` at import time and so cannot be
 * imported outside a browser. Splitting them into `overlay-hittest.ts` is what
 * makes this file possible; it exists to check the geometry a resize actually
 * depends on, and the tie-break behaviour a floored marquee (selection.ts's
 * `resizeRect` minimum) makes newly reachable.
 */
const r: Rect = { x: 100, y: 200, width: 40, height: 20 };

describe("handlePoint", () => {
  test("all eight positions sit on the rect's edges and corners", () => {
    expect(handlePoint(r, "nw")).toEqual({ x: 100, y: 200 });
    expect(handlePoint(r, "n")).toEqual({ x: 120, y: 200 });
    expect(handlePoint(r, "ne")).toEqual({ x: 140, y: 200 });
    expect(handlePoint(r, "e")).toEqual({ x: 140, y: 210 });
    expect(handlePoint(r, "se")).toEqual({ x: 140, y: 220 });
    expect(handlePoint(r, "s")).toEqual({ x: 120, y: 220 });
    expect(handlePoint(r, "sw")).toEqual({ x: 100, y: 220 });
    expect(handlePoint(r, "w")).toEqual({ x: 100, y: 210 });
  });
});

describe("handleAt", () => {
  test("a press within padding of a handle grabs it", () => {
    const near = { x: 140 + HANDLE_GRAB_PADDING - 1, y: 220 + HANDLE_GRAB_PADDING - 1 };
    expect(handleAt(r, near)).toBe("se");
  });

  test("a press just outside every handle's padding grabs nothing", () => {
    const justOut = { x: 140 + HANDLE_GRAB_PADDING + 1, y: 200 };
    expect(handleAt(r, justOut)).toBeUndefined();
  });

  test("nearer handle wins where two overlap, regardless of HANDLES order", () => {
    // Between "n" (120,200) and "nw" (100,200): 5px from n, 25px from nw.
    expect(handleAt(r, { x: 115, y: 200 })).toBe("n");
    // The reverse side: nearer nw.
    expect(handleAt(r, { x: 105, y: 200 })).toBe("nw");
  });

  test("an exact tie is broken by HANDLES order — last checked wins", () => {
    // Centre of a marquee whose half-extent on both axes equals the padding:
    // every handle is exactly HANDLE_GRAB_PADDING away (Chebyshev distance),
    // so this is the tie the resize floor makes reachable.
    const tiny: Rect = { x: 0, y: 0, width: HANDLE_GRAB_PADDING * 2, height: HANDLE_GRAB_PADDING * 2 };
    const centre = { x: HANDLE_GRAB_PADDING, y: HANDLE_GRAB_PADDING };
    for (const h of HANDLES) {
      expect(Math.max(Math.abs(handlePoint(tiny, h).x - centre.x),
                       Math.abs(handlePoint(tiny, h).y - centre.y)))
        .toBe(HANDLE_GRAB_PADDING);
    }
    // "<=" keeps replacing on every equal distance, so the LAST entry in
    // HANDLES wins — pinned here so reordering HANDLES is a visible change
    // rather than a silent one.
    expect(handleAt(tiny, centre)).toBe(HANDLES[HANDLES.length - 1]);
  });
});
