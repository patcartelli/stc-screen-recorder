import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  displayToOutput, fixedCornerPipUv, mapPoint, mapVector, outputRect, pixelsToUv,
  pixelsToUvRect, pxPerPoint, rectToDisplayLocal, regionPointToPixels, roundRect,
  snapRectEdges, toDisplayLocal, unmapPoint, uvRectToPixels, uvToPixels, type Rect,
} from "../src/spaces.js";

const pipAnchors = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "fixtures", "pip", "anchors.json"), "utf8"),
);

/** The reference rects a UV can be normalised over, including ones with an origin. */
const REFS: Rect[] = [
  { x: 0, y: 0, width: 1, height: 1 },
  { x: 0, y: 0, width: 3840, height: 2160 },
  { x: 120, y: 84, width: 1280, height: 720 },      // a still's content rect inside padding
  { x: -17, y: 9, width: 333.5, height: 111.25 },   // non-integer, negative origin
];

describe("UV ↔ pixels — the space that survives a change of crop, padding or canvas", () => {
  test("a UV point lands at the reference rect's own corners", () => {
    const ref = { x: 120, y: 84, width: 1280, height: 720 };
    expect(uvToPixels({ x: 0, y: 0 }, ref)).toEqual({ x: 120, y: 84 });
    expect(uvToPixels({ x: 1, y: 1 }, ref)).toEqual({ x: 1400, y: 804 });
    expect(uvToPixels({ x: 0.5, y: 0.5 }, ref)).toEqual({ x: 760, y: 444 });
  });

  test("nothing is clamped: a UV outside 0..1 lands outside the rect", () => {
    // Clamping here is how a cursor that was on another display would be drawn
    // pinned to an edge, which is a lie rather than a missing pointer.
    const ref = { x: 0, y: 0, width: 100, height: 100 };
    expect(uvToPixels({ x: -0.5, y: 1.5 }, ref)).toEqual({ x: -50, y: 150 });
  });

  test("inverse pair: pixelsToUv(uvToPixels(u, ref), ref) === u", () => {
    for (const ref of REFS) {
      for (const u of [0, 0.25, 1 / 3, 0.5, 0.999, 1, 1.4, -0.2]) {
        const back = pixelsToUv(uvToPixels({ x: u, y: u }, ref), ref);
        expect(back.x).toBeCloseTo(u, 12);
        expect(back.y).toBeCloseTo(u, 12);
      }
    }
  });

  test("inverse pair holds for rectangles too", () => {
    const r = { x: 0.1, y: 0.2, width: 0.35, height: 0.4 };
    for (const ref of REFS) {
      const back = pixelsToUvRect(uvRectToPixels(r, ref), ref);
      for (const k of ["x", "y", "width", "height"] as const) {
        expect(back[k]).toBeCloseTo(r[k], 12);
      }
    }
  });

  test("the reference rect is the argument — the SAME UV in two rects is two answers", () => {
    // This is what makes the still path's decorations, the PiP and a zoom crop
    // one space rather than three: only the rect differs.
    const u = { x: 0.5, y: 0.5 };
    expect(uvToPixels(u, { x: 0, y: 0, width: 3840, height: 2160 })).toEqual({ x: 1920, y: 1080 });
    expect(uvToPixels(u, { x: 120, y: 84, width: 1280, height: 720 })).toEqual({ x: 760, y: 444 });
  });

  test("rounding is the caller's, not the conversion's", () => {
    // A redaction and an annotation are drawn at sub-pixel positions on
    // purpose; only something placing a decoded frame rounds.
    const px = uvRectToPixels({ x: 0.1, y: 0.1, width: 0.3, height: 0.3 },
                              { x: 0, y: 0, width: 101, height: 101 });
    expect(px.x).toBeCloseTo(10.1, 12);
    expect(roundRect(px)).toEqual({ x: 10, y: 10, width: 30, height: 30 });
  });
});

describe("two rounding rules, named apart — they disagree, and both are right", () => {
  const r = { x: 10.6, y: 0.4, width: 100.1, height: 10.4 };

  test("roundRect keeps the SIZE: for placing something of a known size", () => {
    expect(roundRect(r)).toEqual({ x: 11, y: 0, width: 100, height: 10 });
  });

  test("snapRectEdges keeps the EDGES: for a region someone selected", () => {
    expect(snapRectEdges(r)).toEqual({ x: 11, y: 0, width: 100, height: 11 });
  });

  test("they really differ — otherwise naming them apart is decoration", () => {
    // Until STC-314 these were two functions called `roundRect`, in two files,
    // with these two rules. The names agreed and the answers did not, which is
    // harder to see than the usual two-copies defect.
    expect(roundRect(r)).not.toEqual(snapRectEdges(r));
  });

  test("snapRectEdges preserves the far edge; roundRect can move it", () => {
    const snapped = snapRectEdges(r);
    expect(snapped.x + snapped.width).toBe(Math.round(r.x + r.width));
    const rounded = roundRect(r);
    expect(rounded.y + rounded.height).not.toBe(Math.round(r.y + r.height));
  });
});

describe("global points → display-local points", () => {
  const origin = { x: 1920, y: 0 };

  test("the display's own origin becomes (0, 0); units are unchanged", () => {
    expect(toDisplayLocal({ x: 1920, y: 0 }, origin)).toEqual({ x: 0, y: 0 });
    expect(toDisplayLocal({ x: 2100, y: 300 }, origin)).toEqual({ x: 180, y: 300 });
  });

  test("a rectangle keeps its SIZE — this conversion is a translation only", () => {
    const r = { x: 2100, y: 300, width: 640, height: 480 };
    expect(rectToDisplayLocal(r, origin)).toEqual({ x: 180, y: 300, width: 640, height: 480 });
  });

  test("a point on another display goes negative, and is not clamped", () => {
    expect(toDisplayLocal({ x: 100, y: 50 }, origin).x).toBe(-1820);
  });
});

describe("pxPerPoint — output pixels per display point", () => {
  test("read from the picture against the region it came from", () => {
    expect(pxPerPoint(2560, 1280)).toBe(2);
    expect(pxPerPoint(1280, 1280)).toBe(1);
  });

  test("no region to divide by is undefined, never a silent 1", () => {
    // The fallback belongs to the document (a shot with no crop is a whole
    // display, whose backingScale is the right answer) and not to the
    // conversion, which cannot know what the caller meant.
    expect(pxPerPoint(1280, 0)).toBeUndefined();
    expect(pxPerPoint(1280, -4)).toBeUndefined();
    expect(pxPerPoint(Number.NaN, 1280)).toBeUndefined();
  });
});

describe("regionPointToPixels — display-local points into a drawn region", () => {
  const content = { x: 120, y: 84 };
  const origin = { x: 400, y: 250 };  // the crop's origin in display-local points

  test("all three steps: into the region, points to pixels, into the canvas", () => {
    expect(regionPointToPixels({ x: 500, y: 300 }, origin, 2, content))
      .toEqual({ x: 120 + 200, y: 84 + 100 });
  });

  test("dropping the region origin offsets by the crop — a control that differs only there", () => {
    const right = regionPointToPixels({ x: 500, y: 300 }, origin, 2, content);
    const noOrigin = regionPointToPixels({ x: 500, y: 300 }, { x: 0, y: 0 }, 2, content);
    expect(noOrigin).not.toEqual(right);
    expect(noOrigin.x - right.x).toBe(origin.x * 2);
  });

  test("dropping the content origin offsets by the padding", () => {
    const right = regionPointToPixels({ x: 500, y: 300 }, origin, 2, content);
    const noContent = regionPointToPixels({ x: 500, y: 300 }, origin, 2, { x: 0, y: 0 });
    expect(right.x - noContent.x).toBe(content.x);
  });
});

describe("global points → output pixels — the one event-space conversion", () => {
  const display = { originX: 1920, originY: 0, pointWidth: 1512, pointHeight: 982 };

  test("sx and sy are kept apart: an export whose aspect differs stretches", () => {
    const m = displayToOutput(display, { width: 3024, height: 1964 });
    expect(m.sx).toBe(2);
    expect(m.sy).toBe(2);
    const stretched = displayToOutput(display, { width: 3024, height: 982 });
    expect(stretched.sx).toBe(2);
    expect(stretched.sy).toBe(1);
  });

  test("a point translates by the display origin, then scales", () => {
    const m = displayToOutput(display, { width: 3024, height: 1964 });
    expect(mapPoint(m, { x: 1920, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(mapPoint(m, { x: 2000, y: 100 })).toEqual({ x: 160, y: 200 });
  });

  test("a VELOCITY scales and does NOT translate", () => {
    // The whole reason mapVector exists. Subtracting the origin from a
    // velocity is wrong by the origin and looks right on every single-display
    // machine — which is every fixture in this repo — so the discriminating
    // case needs a display that is not at (0, 0).
    const m = displayToOutput(display, { width: 3024, height: 1964 });
    expect(mapVector(m, { x: 10, y: 5 })).toEqual({ x: 20, y: 10 });
    expect(mapPoint(m, { x: 10, y: 5 })).not.toEqual(mapVector(m, { x: 10, y: 5 }));
  });

  test("a display at the origin cannot tell the two apart — hence the case above", () => {
    const main = displayToOutput({ originX: 0, originY: 0, pointWidth: 100, pointHeight: 100 },
                                 { width: 200, height: 200 });
    expect(mapPoint(main, { x: 10, y: 5 })).toEqual(mapVector(main, { x: 10, y: 5 }));
  });

  test("inverse pair: unmapPoint(mapPoint(p)) === p", () => {
    const m = displayToOutput(display, { width: 3024, height: 1964 });
    for (const p of [{ x: 1920, y: 0 }, { x: 2500, y: 640 }, { x: 0, y: 0 }]) {
      const back = unmapPoint(m, mapPoint(m, p));
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
  });

  test("a cursor on another display maps outside the canvas, and is not moved", () => {
    const m = displayToOutput(display, { width: 3024, height: 1964 });
    expect(mapPoint(m, { x: 100, y: 100 }).x).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// The PiP, as a crop in UV
// ---------------------------------------------------------------------------

/**
 * The rule as it was written inline in render.ts before STC-314, kept here as
 * the control. The refactor's whole claim is that it changes no pixels.
 */
function legacyPipRect(pip: { widthPct: number; marginPx: number },
                       output: { width: number; height: number },
                       cam: { width: number; height: number }) {
  const width = Math.round(output.width * pip.widthPct);
  const height = Math.round((width * cam.height) / cam.width);
  return {
    x: output.width - width - pip.marginPx,
    y: output.height - height - pip.marginPx,
    width, height,
  };
}

/** What render() now does: UV over the output, back to pixels, rounded. */
function pipRect(pip: { widthPct: number; marginPx: number },
                 output: { width: number; height: number },
                 cam: { width: number; height: number }) {
  return roundRect(uvRectToPixels(fixedCornerPipUv(pip, output, cam), outputRect(output)));
}

describe("fixedCornerPipUv — the PiP is a crop in UV, not a corner in pixels", () => {
  const OUTPUTS = [
    { width: 3840, height: 2160 }, { width: 1920, height: 1080 },
    { width: 640, height: 360 }, { width: 2560, height: 1600 },
    { width: 1512, height: 982 }, { width: 1000, height: 1000 },
  ];
  const CAMERAS = [
    { width: 1280, height: 720 }, { width: 1920, height: 1080 },
    { width: 640, height: 480 }, { width: 1280, height: 960 },
    { width: 1024, height: 576 }, { width: 3840, height: 2160 },
  ];
  const PCTS = [0.125, 0.1, 0.2, 0.0625, 0.33, 0.17];
  const MARGINS = [0, 24, 48, 7];

  test("the sweep is pixel-identical to the rule it replaced", () => {
    let checked = 0;
    for (const output of OUTPUTS) {
      for (const cam of CAMERAS) {
        for (const widthPct of PCTS) {
          for (const marginPx of MARGINS) {
            const pip = { widthPct, marginPx };
            expect(pipRect(pip, output, cam)).toEqual(legacyPipRect(pip, output, cam));
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(OUTPUTS.length * CAMERAS.length * PCTS.length * MARGINS.length);
  });

  test("the UV rect really is normalised — bottom-right, and inside 0..1", () => {
    const uv = fixedCornerPipUv({ widthPct: 0.125, marginPx: 48 },
                                { width: 3840, height: 2160 }, { width: 1280, height: 720 });
    expect(uv.width).toBeCloseTo(0.125, 12);
    expect(uv.x + uv.width).toBeCloseTo(1 - 48 / 3840, 12);
    expect(uv.y + uv.height).toBeCloseTo(1 - 48 / 2160, 12);
    for (const v of [uv.x, uv.y, uv.width, uv.height]) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
  });

  test("the derivation ORDER is load-bearing, not a decorative comment", () => {
    // fixedCornerPipUv derives UV from the pixel rule, taking the height from
    // the ROUNDED width. Normalising the ideal rect and rounding once at the
    // end is the obvious alternative; this proves it is a DIFFERENT answer, so
    // the comment saying why is earning its place.
    const roundOnce = (pip: { widthPct: number; marginPx: number },
                       output: { width: number; height: number },
                       cam: { width: number; height: number }) => {
      const w = output.width * pip.widthPct;
      const h = (w * cam.height) / cam.width;
      return roundRect({ x: output.width - w - pip.marginPx,
                         y: output.height - h - pip.marginPx, width: w, height: h });
    };
    const disagreements = [];
    for (const output of OUTPUTS) {
      for (const cam of CAMERAS) {
        for (const widthPct of PCTS) {
          const pip = { widthPct, marginPx: 24 };
          if (JSON.stringify(roundOnce(pip, output, cam))
              !== JSON.stringify(legacyPipRect(pip, output, cam))) {
            disagreements.push({ output, cam, widthPct });
          }
        }
      }
    }
    expect(disagreements.length).toBeGreaterThan(0);
  });

  test("fixture: the committed PiP take's camera lands where it always has", () => {
    const cam = pipAnchors.camera;
    const output = { width: pipAnchors.capture.width, height: pipAnchors.capture.height };
    const pip = { widthPct: 0.25, marginPx: 16 };
    expect(pipRect(pip, output, cam)).toEqual(legacyPipRect(pip, output, cam));
    // 640-wide output at 25% is a 160px PiP; a 1280x720 camera makes it 90 tall.
    expect(pipRect(pip, output, cam)).toEqual({ x: 464, y: 254, width: 160, height: 90 });
  });
});
