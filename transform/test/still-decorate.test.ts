import { describe, test, expect } from "vitest";
import {
  layoutStill, canvasSize, paddingPixels, cursorLayout, decorationForMode,
  PRESET_PADDING_PCT, PRESET_SHADOW, shadowReachPixels,
} from "../src/still-decorate.js";
import { parseShot, DECORATION_MODES, type Shot } from "../src/shot.js";

/**
 * The decorated still's layout (STC-291), without a rasteriser.
 *
 * Everything here is arithmetic over `shot.json`, which is most of what the
 * ticket's acceptance list is actually about: padding that holds across scale
 * factors, canvas presets that centre without cropping, a shadow expressed in
 * the output's pixels rather than the document's points, and a pointer landing
 * where it was recorded. What is left for the browser gate is only the part
 * that is genuinely about pixels — alpha at a corner, a shadow falling to
 * zero — and `docs/STC-291-RUNBOOK.md` says which is which.
 */

/** A 2x window capture: 800x600 points of window, 1600x1200 pixels of frame. */
const windowShot = (over: Record<string, unknown> = {}): Shot => parseShot({
  version: 1,
  kind: "window",
  capturedAtNs: "1000000000",
  timebase: { numer: 125, denom: 3 },
  display: { id: 1, pointWidth: 1920, pointHeight: 1080, pixelWidth: 3840, pixelHeight: 2160,
             backingScale: 2, originX: 0, originY: 0 },
  window: { id: 7, app: "Notes", title: "Draft",
            bounds: { x: 200, y: 120, width: 800, height: 600 } },
  frame: { file: "frame.png", width: 1600, height: 1200, alpha: true },
  decoration: { mode: "window-only", canvas: "natural", cursor: false, redactions: [] },
  ...over,
});

/** A 2x region capture: 640x360 points, 1280x720 pixels, opaque. */
const regionShot = (over: Record<string, unknown> = {}): Shot => parseShot({
  version: 1,
  kind: "display-crop",
  capturedAtNs: "1000000000",
  timebase: { numer: 125, denom: 3 },
  display: { id: 1, pointWidth: 1920, pointHeight: 1080, pixelWidth: 3840, pixelHeight: 2160,
             backingScale: 2, originX: 0, originY: 0 },
  crop: { x: 100, y: 80, width: 640, height: 360 },
  frame: { file: "frame.png", width: 1280, height: 720, alpha: false },
  decoration: { mode: "selected-area", canvas: "natural", cursor: false, redactions: [] },
  ...over,
});

describe("padding", () => {
  test("is a fraction of the SHORT edge, so it holds across scale factors", () => {
    // The same 10% on a 1x and a 2x capture of the same region must frame it
    // identically once each is viewed at its own scale.
    expect(paddingPixels({ width: 1000, height: 500 }, 0.1)).toBe(50);
    expect(paddingPixels({ width: 2000, height: 1000 }, 0.1)).toBe(100);
    // Tall as well as wide: the short edge is the short edge either way.
    expect(paddingPixels({ width: 500, height: 1000 }, 0.1)).toBe(50);
  });

  test("absent or zero is no padding, when there is no shadow to hold", () => {
    expect(paddingPixels({ width: 1000, height: 500 }, undefined)).toBe(0);
    expect(paddingPixels({ width: 1000, height: 500 }, 0)).toBe(0);
  });

  test("a shadow raises the floor; a larger percentage still wins", () => {
    const shadow = { offsetX: 0, offsetY: 10, blur: 20, spread: 0, opacity: 0.3 };
    const reach = shadowReachPixels(shadow);
    expect(paddingPixels({ width: 400, height: 300 }, 0, shadow)).toBe(Math.round(reach));
    // 30% of the short edge is 90, comfortably above the shadow's 40.
    expect(paddingPixels({ width: 400, height: 300 }, 0.3, shadow)).toBe(90);
  });
});

describe("canvas presets", () => {
  const content = { width: 1600, height: 1200 };   // 4:3

  test("natural is the capture plus padding on every side", () => {
    expect(canvasSize(content, 100, "natural")).toEqual({ width: 1800, height: 1400 });
  });

  test("a preset only ever GROWS — the capture is never cropped to fit", () => {
    for (const preset of ["16:9", "4:3", "1:1"]) {
      const c = canvasSize(content, 0, preset);
      expect(c.width, preset).toBeGreaterThanOrEqual(content.width);
      expect(c.height, preset).toBeGreaterThanOrEqual(content.height);
    }
  });

  test("16:9 widens a 4:3 capture rather than trimming its height", () => {
    const c = canvasSize(content, 0, "16:9");
    expect(c.height).toBe(1200);
    expect(c.width).toBe(Math.round(1200 * 16 / 9));
  });

  test("1:1 grows the short side of a wide capture", () => {
    const c = canvasSize({ width: 1600, height: 900 }, 0, "1:1");
    expect(c).toEqual({ width: 1600, height: 1600 });
  });

  test("a capture already at the ratio is left exactly alone", () => {
    expect(canvasSize({ width: 1600, height: 900 }, 0, "16:9")).toEqual({ width: 1600, height: 900 });
  });

  test("the preset applies to the PADDED box, not the bare capture", () => {
    // 1600x1200 + 100 padding = 1800x1400; 1:1 must reach 1800, not 1600.
    expect(canvasSize(content, 100, "1:1")).toEqual({ width: 1800, height: 1800 });
  });
});

describe("the layout", () => {
  test("selected-area is the bare capture: no padding, no shadow, no background", () => {
    const l = layoutStill(regionShot());
    expect(l.canvas).toEqual({ width: 1280, height: 720 });
    expect(l.content).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
    expect(l.shadow).toBeUndefined();
    expect(l.background).toBeUndefined();
    // An opaque crop has nothing to be transparent about.
    expect(l.alpha).toBe(false);
  });

  test("window-only keeps alpha and adds nothing", () => {
    const l = layoutStill(windowShot());
    expect(l.canvas).toEqual({ width: 1600, height: 1200 });
    expect(l.shadow).toBeUndefined();
    expect(l.alpha).toBe(true);
  });

  test("window-shadow keeps alpha — the shadow falls onto whatever is behind it", () => {
    const l = layoutStill(windowShot({
      decoration: { mode: "window-shadow", canvas: "natural", cursor: false, redactions: [],
                    paddingPct: 0.06, shadow: { ...PRESET_SHADOW } },
    }));
    expect(l.alpha).toBe(true);
    expect(l.shadow).toBeDefined();
    // Padding leaves room for the shadow to fall without being clipped.
    expect(l.canvas.width).toBeGreaterThan(1600);
    expect(l.content.x).toBeGreaterThan(0);
  });

  test("a background ends the transparency, because it fills every pixel", () => {
    const l = layoutStill(windowShot({
      decoration: { mode: "window-shadow-background", canvas: "natural", cursor: false,
                    redactions: [], paddingPct: 0.09, shadow: { ...PRESET_SHADOW },
                    background: { kind: "solid", colors: ["#101014"] } },
    }));
    expect(l.alpha).toBe(false);
    expect(l.background).toEqual({ kind: "solid", colors: ["#101014"] });
  });

  test("the capture is centred and never scaled", () => {
    const l = layoutStill(windowShot({
      decoration: { mode: "window-shadow-background", canvas: "1:1", cursor: false,
                    redactions: [], paddingPct: 0.1, shadow: { ...PRESET_SHADOW },
                    background: { kind: "solid", colors: ["#ffffff"] } },
    }));
    expect(l.canvas.width).toBe(l.canvas.height);
    expect(l.content.width).toBe(1600);
    expect(l.content.height).toBe(1200);
    expect(l.content.x).toBe(Math.round((l.canvas.width - 1600) / 2));
    expect(l.content.y).toBe(Math.round((l.canvas.height - 1200) / 2));
  });

  test("the content rect lands on whole pixels, so the frame is never resampled", () => {
    // An odd canvas/content difference is where a half-pixel offset would come
    // from, and a resampled premultiplied edge is the corner fringe.
    const l = layoutStill(windowShot({
      frame: { file: "frame.png", width: 1601, height: 1200, alpha: true },
      decoration: { mode: "window-shadow-background", canvas: "16:9", cursor: false,
                    redactions: [], paddingPct: 0.07, shadow: { ...PRESET_SHADOW },
                    background: { kind: "solid", colors: ["#ffffff"] } },
    }));
    expect(Number.isInteger(l.content.x)).toBe(true);
    expect(Number.isInteger(l.content.y)).toBe(true);
  });

  test("the shadow is converted from the document's POINTS to output pixels", () => {
    const l = layoutStill(windowShot({
      decoration: { mode: "window-shadow", canvas: "natural", cursor: false, redactions: [],
                    paddingPct: 0.06,
                    shadow: { offsetX: 3, offsetY: 9, blur: 24, spread: 2, opacity: 0.4 } },
    }));
    // The frame is 1600px for 800pt of window, so 2 px per point.
    expect(l.shadow).toEqual({ offsetX: 6, offsetY: 18, blur: 48, spread: 4, opacity: 0.4 });
  });

  test("scale comes from the frame against its own region, not from the display block", () => {
    // A display that claims 2x while this particular frame is 1x — which is
    // what a downscaled or a non-Retina-mirrored capture looks like.
    const l = layoutStill(windowShot({
      frame: { file: "frame.png", width: 800, height: 600, alpha: true },
      decoration: { mode: "window-shadow", canvas: "natural", cursor: false, redactions: [],
                    paddingPct: 0, shadow: { offsetX: 0, offsetY: 10, blur: 20, spread: 0, opacity: 0.3 } },
    }));
    expect(l.shadow?.blur).toBe(20);
  });

  test("redactions are normalised to the capture, so they move with the content", () => {
    const l = layoutStill(regionShot({
      decoration: { mode: "selected-area", canvas: "1:1", cursor: false, paddingPct: 0.05,
                    redactions: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.05 }] },
    }));
    const r = l.redactions[0]!;
    expect(r.x).toBeCloseTo(l.content.x + 0.1 * 1280, 6);
    expect(r.y).toBeCloseTo(l.content.y + 0.2 * 720, 6);
    expect(r.width).toBeCloseTo(0.3 * 1280, 6);
  });

  test("every mode a document may carry produces a layout", () => {
    // Total by construction: parseShot's whole accepted range, not a sample.
    for (const mode of DECORATION_MODES) {
      const shot = mode === "selected-area"
        ? regionShot({ decoration: { mode, canvas: "natural", cursor: false, redactions: [] } })
        : windowShot({
            decoration: { mode, canvas: "natural", cursor: false, redactions: [],
                          paddingPct: PRESET_PADDING_PCT[mode],
                          shadow: { ...PRESET_SHADOW },
                          background: { kind: "solid", colors: ["#ffffff"] } },
          });
      const l = layoutStill(shot);
      expect(l.canvas.width, mode).toBeGreaterThan(0);
      expect(l.canvas.height, mode).toBeGreaterThan(0);
    }
  });

  test("the same document always gives the same layout", () => {
    const shot = windowShot({
      decoration: { mode: "window-shadow-background", canvas: "16:9", cursor: true,
                    redactions: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }],
                    paddingPct: 0.08, shadow: { ...PRESET_SHADOW },
                    background: { kind: "linear", colors: ["#ffffff", "#000000"], angleDeg: 45 } },
      cursor: { x: 400, y: 300, shape: "arrow" },
    });
    expect(layoutStill(shot)).toEqual(layoutStill(shot));
  });
});

describe("the cursor", () => {
  const content = { x: 100, y: 50, width: 1600, height: 1200 };

  test("is placed from display-local points, through the crop and the scale", () => {
    // Crop starts at (100, 80); pointer at (420, 300) is 320x220 points in,
    // which at 2 px/pt is 640x440 pixels from the content's origin.
    const shot = regionShot({ cursor: { x: 420, y: 300, shape: "arrow" } });
    const c = cursorLayout(shot, content, 2);
    expect(c?.x).toBe(100 + 640);
    expect(c?.y).toBe(50 + 440);
  });

  test("a window shot measures from the window's own bounds", () => {
    // Window at (200, 120); pointer at (400, 320) is 200x200 points in.
    const shot = windowShot({ cursor: { x: 400, y: 320, shape: "ibeam" } });
    const c = cursorLayout(shot, content, 2);
    expect(c?.x).toBe(100 + 400);
    expect(c?.y).toBe(50 + 400);
    expect(c?.shape).toBe("ibeam");
  });

  test("a pointer outside the captured area is absent, not clamped to the edge", () => {
    // Crop is 640x360 points from (100, 80); (5000, 80) is far to the right.
    const shot = regionShot({ cursor: { x: 5000, y: 80, shape: "arrow" } });
    expect(cursorLayout(shot, content, 2)).toBeUndefined();
  });

  test("is only in the layout when the decoration asks for it", () => {
    const withCursor = regionShot({
      cursor: { x: 420, y: 300, shape: "arrow" },
      decoration: { mode: "selected-area", canvas: "natural", cursor: true, redactions: [] },
    });
    const without = regionShot({
      cursor: { x: 420, y: 300, shape: "arrow" },
      decoration: { mode: "selected-area", canvas: "natural", cursor: false, redactions: [] },
    });
    expect(layoutStill(withCursor).cursor).toBeDefined();
    expect(layoutStill(without).cursor).toBeUndefined();
  });

  test("a shot with no recorded pointer has none to draw", () => {
    const shot = regionShot({
      decoration: { mode: "selected-area", canvas: "natural", cursor: true, redactions: [] },
    });
    expect(layoutStill(shot).cursor).toBeUndefined();
  });
});

describe("the presets", () => {
  test("each mode gets a decoration parseShot accepts", () => {
    for (const mode of DECORATION_MODES) {
      const dec = decorationForMode(mode);
      const base = mode === "selected-area" ? regionShot() : windowShot();
      expect(() => parseShot({
        ...JSON.parse(JSON.stringify(base)),
        decoration: JSON.parse(JSON.stringify(dec)),
      }), mode).not.toThrow();
    }
  });

  test("only the modes that name a shadow or a background get one", () => {
    expect(decorationForMode("selected-area").shadow).toBeUndefined();
    expect(decorationForMode("window-only").shadow).toBeUndefined();
    expect(decorationForMode("window-shadow").shadow).toBeDefined();
    expect(decorationForMode("window-shadow").background).toBeUndefined();
    expect(decorationForMode("window-shadow-background").background).toBeDefined();
  });

  test("a document's own values win over the preset", () => {
    const mine = { offsetX: 1, offsetY: 2, blur: 3, spread: 4, opacity: 0.5 };
    expect(decorationForMode("window-shadow", { shadow: mine }).shadow).toEqual(mine);
    expect(decorationForMode("window-shadow", { paddingPct: 0.5 }).paddingPct).toBe(0.5);
  });

  test("a field a mode does not want is still carried when the document set it", () => {
    // The presets are what a fresh capture gets, not a filter on what a
    // hand-edited document may say.
    const mine = { offsetX: 1, offsetY: 2, blur: 3, spread: 4, opacity: 0.5 };
    expect(decorationForMode("window-only", { shadow: mine }).shadow).toEqual(mine);
  });

  test("the padded modes leave room for their own shadow, at any capture size", () => {
    // The still gate caught this for real: the preset padding is a percentage
    // of the capture and the preset shadow is in points, so on a SMALL capture
    // the percentage lost and the shadow was clipped into a hard grey band at
    // the canvas edge. A big capture hid it, which is why the sizes below span
    // two orders of magnitude rather than sampling one comfortable one.
    for (const mode of ["window-shadow", "window-shadow-background"] as const) {
      for (const [w, h] of [[240, 160], [480, 320], [1600, 1200], [6016, 3384]]) {
        const dec = decorationForMode(mode);
        const shot = windowShot({
          frame: { file: "frame.png", width: w, height: h, alpha: true },
          decoration: JSON.parse(JSON.stringify(dec)),
        });
        const l = layoutStill(shot);
        const padding = l.content.y;
        const reach = shadowReachPixels(l.shadow);
        expect(padding, `${mode} at ${w}x${h}: padding ${padding} < shadow reach ${reach}`)
          .toBeGreaterThanOrEqual(Math.round(reach));
      }
    }
  });

  test("padding is never less than the shadow needs, whatever the document asks for", () => {
    // Mutation guard for the fix above: a document may set paddingPct to zero
    // and still must not clip its own shadow.
    const shot = windowShot({
      frame: { file: "frame.png", width: 400, height: 300, alpha: true },
      decoration: { mode: "window-shadow", canvas: "natural", cursor: false, redactions: [],
                    paddingPct: 0, shadow: { offsetX: 0, offsetY: 20, blur: 40, spread: 0, opacity: 0.3 } },
    });
    const l = layoutStill(shot);
    expect(l.content.y).toBeGreaterThanOrEqual(Math.round(shadowReachPixels(l.shadow)));
  });

  test("a mode with no shadow is not padded by one", () => {
    // The floor must come from the shadow that exists, not from a constant.
    const l = layoutStill(windowShot({
      decoration: { mode: "window-only", canvas: "natural", cursor: false, redactions: [],
                    paddingPct: 0 },
    }));
    expect(l.content).toEqual({ x: 0, y: 0, width: 1600, height: 1200 });
  });
});
