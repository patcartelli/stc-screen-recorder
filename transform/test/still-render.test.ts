import { describe, test, expect } from "vitest";
import { recorder } from "./_canvas-recorder.js";
import { renderStill, gradientLine, shadowParkDistance, type StillRenderContext } from "../src/still-render.js";
import { layoutStill, PRESET_SHADOW } from "../src/still-decorate.js";
import { parseShot, type Shot } from "../src/shot.js";

/**
 * What the decorated still DRAWS, and in what order (STC-291).
 *
 * Node has no canvas, so what can be pinned here is the sequence of operations
 * and the numbers handed to them — which is exactly where this file's bugs
 * would live: a shadow drawn over the window instead of under it, shadow
 * settings leaking onto the frame, a redaction a background could soften. The
 * pixels those operations produce are the browser gate's job, and the two are
 * deliberately different questions.
 */

const ctxOf = () => {
  const { ctx, ops } = recorder();
  return { ctx: ctx as unknown as StillRenderContext, ops };
};

const FRAME = "<frame>";
const BACKDROP = "<backdrop>";

const windowShot = (decoration: Record<string, unknown>): Shot => parseShot({
  version: 1,
  kind: "window",
  capturedAtNs: "1000000000",
  timebase: { numer: 125, denom: 3 },
  display: { id: 1, pointWidth: 1920, pointHeight: 1080, pixelWidth: 3840, pixelHeight: 2160,
             backingScale: 2, originX: 0, originY: 0 },
  window: { id: 7, bounds: { x: 200, y: 120, width: 800, height: 600 } },
  frame: { file: "frame.png", width: 1600, height: 1200, alpha: true },
  decoration,
});

const regionShot = (decoration: Record<string, unknown>): Shot => parseShot({
  version: 1,
  kind: "display-crop",
  capturedAtNs: "1000000000",
  timebase: { numer: 125, denom: 3 },
  display: { id: 1, pointWidth: 1920, pointHeight: 1080, pixelWidth: 3840, pixelHeight: 2160,
             backingScale: 2, originX: 0, originY: 0 },
  crop: { x: 100, y: 80, width: 640, height: 360 },
  frame: { file: "frame.png", width: 1280, height: 720, alpha: false },
  decoration,
});

const WINDOW_ONLY = { mode: "window-only", canvas: "natural", cursor: false, redactions: [] };
const WINDOW_SHADOW = {
  mode: "window-shadow", canvas: "natural", cursor: false, redactions: [],
  paddingPct: 0.06, shadow: { ...PRESET_SHADOW },
};
const WITH_BACKGROUND = {
  mode: "window-shadow-background", canvas: "natural", cursor: false, redactions: [],
  paddingPct: 0.09, shadow: { ...PRESET_SHADOW },
  background: { kind: "linear", colors: ["#e9edf2", "#cfd6e0"], angleDeg: 135 },
};

/** Index of the first op matching, or -1. */
const at = (ops: string[], re: RegExp) => ops.findIndex((o) => re.test(o));
const drawImages = (ops: string[]) => ops.filter((o) => o.startsWith("drawImage("));

describe("gradientLine", () => {
  test("0 degrees runs bottom to top, CSS's convention", () => {
    const l = gradientLine(100, 100, 0);
    expect(l.x0).toBeCloseTo(50, 6);
    expect(l.y0).toBeCloseTo(100, 6);
    expect(l.y1).toBeCloseTo(0, 6);
  });

  test("90 degrees runs left to right", () => {
    const l = gradientLine(100, 100, 90);
    expect(l.x0).toBeCloseTo(0, 6);
    expect(l.x1).toBeCloseTo(100, 6);
    expect(l.y0).toBeCloseTo(50, 6);
  });

  test("the line spans the whole box, so the end stops reach the corners", () => {
    // At 45 degrees across a square the projection is the diagonal's length.
    const l = gradientLine(100, 100, 45);
    expect(Math.hypot(l.x1 - l.x0, l.y1 - l.y0)).toBeCloseTo(Math.sqrt(2) * 100, 6);
  });
});

describe("selected-area", () => {
  test("draws the capture and nothing else", () => {
    const layout = layoutStill(regionShot(
      { mode: "selected-area", canvas: "natural", cursor: false, redactions: [] }));
    const { ctx, ops } = ctxOf();
    renderStill(ctx, { frame: FRAME }, layout);

    expect(ops[0]).toBe("clearRect(0,0,1280,720)");
    expect(drawImages(ops)).toEqual(["drawImage(<frame>,0,0,1280,720)"]);
    expect(ops.some((o) => o.startsWith("shadowColor="))).toBe(false);
    expect(ops.some((o) => o.startsWith("fillRect("))).toBe(false);
  });
});

describe("window-only", () => {
  test("draws the capture with no shadow pass, keeping the alpha it arrived with", () => {
    const layout = layoutStill(windowShot(WINDOW_ONLY));
    const { ctx, ops } = ctxOf();
    renderStill(ctx, { frame: FRAME }, layout);

    expect(drawImages(ops)).toEqual(["drawImage(<frame>,0,0,1600,1200)"]);
    expect(ops.some((o) => o.startsWith("shadowColor="))).toBe(false);
  });

  test("nothing is painted over the whole canvas, so the corners stay transparent", () => {
    // A fillRect covering the canvas is exactly how a "transparent" mode ends
    // up with an opaque background nobody asked for.
    const layout = layoutStill(windowShot(WINDOW_ONLY));
    const { ctx, ops } = ctxOf();
    renderStill(ctx, { frame: FRAME }, layout);
    expect(ops.filter((o) => o.startsWith("fillRect("))).toEqual([]);
  });
});

describe("the shadow pass", () => {
  test("parks the casting image off-canvas and brings back only its shadow", () => {
    const layout = layoutStill(windowShot(WINDOW_SHADOW));
    const park = shadowParkDistance(layout);
    const { ctx, ops } = ctxOf();
    renderStill(ctx, { frame: FRAME }, layout);

    const s = layout.shadow!;
    // The casting draw is off to the left by `park`...
    const casting = drawImages(ops)[0]!;
    const castX = Number(casting.split(",")[1]);
    expect(castX).toBe(layout.content.x - park - s.spread);
    expect(castX + layout.content.width).toBeLessThan(0);
    // ...and the shadow offset brings the shadow back to where it belongs.
    expect(ops).toContain(`shadowOffsetX=${s.offsetX + park}`);
    expect(ops).toContain(`shadowOffsetY=${s.offsetY}`);
    expect(ops).toContain(`shadowBlur=${s.blur}`);
    expect(ops).toContain(`shadowColor=rgba(0, 0, 0, ${s.opacity})`);
  });

  test("the park distance clears the canvas, the blur and the spread", () => {
    const layout = layoutStill(windowShot({
      ...WINDOW_SHADOW,
      shadow: { offsetX: 40, offsetY: 0, blur: 200, spread: 30, opacity: 0.5 },
    }));
    const park = shadowParkDistance(layout);
    const s = layout.shadow!;
    expect(park).toBeGreaterThan(layout.canvas.width + s.blur + s.spread + Math.abs(s.offsetX));
  });

  test("runs BEFORE the capture, so the shadow is under the window and not over it", () => {
    const layout = layoutStill(windowShot(WINDOW_SHADOW));
    const { ctx, ops } = ctxOf();
    renderStill(ctx, { frame: FRAME }, layout);
    const images = drawImages(ops);
    expect(images).toHaveLength(2);
    // The second draw is the real one, at the content rect, at natural size.
    expect(images[1]).toBe(
      `drawImage(<frame>,${layout.content.x},${layout.content.y},1600,1200)`);
  });

  test("is wrapped in save/restore, so its settings cannot leak onto the capture", () => {
    // A shadowBlur still set when the frame is drawn would give the window a
    // second, doubled shadow — and one that moves with it.
    const layout = layoutStill(windowShot(WINDOW_SHADOW));
    const { ctx, ops } = ctxOf();
    renderStill(ctx, { frame: FRAME }, layout);
    const save = at(ops, /^save\(\)$/);
    const restore = at(ops, /^restore\(\)$/);
    const shadowSet = at(ops, /^shadowColor=/);
    const realDraw = ops.lastIndexOf(
      `drawImage(<frame>,${layout.content.x},${layout.content.y},1600,1200)`);
    expect(save).toBeLessThan(shadowSet);
    expect(shadowSet).toBeLessThan(restore);
    expect(restore).toBeLessThan(realDraw);
  });

  test("spread grows the casting shape only — the capture is still natural size", () => {
    const layout = layoutStill(windowShot({
      ...WINDOW_SHADOW,
      shadow: { offsetX: 0, offsetY: 10, blur: 20, spread: 12, opacity: 0.3 },
    }));
    const { ctx, ops } = ctxOf();
    renderStill(ctx, { frame: FRAME }, layout);
    const [casting, real] = drawImages(ops);
    const spreadPx = layout.shadow!.spread;
    expect(casting).toContain(`${1600 + spreadPx * 2},${1200 + spreadPx * 2}`);
    expect(real).toContain("1600,1200");
  });

  test("no frame means no shadow pass rather than a shadow of nothing", () => {
    const layout = layoutStill(windowShot(WINDOW_SHADOW));
    const { ctx, ops } = ctxOf();
    renderStill(ctx, { frame: null }, layout);
    expect(drawImages(ops)).toEqual([]);
    expect(ops.some((o) => o.startsWith("shadowColor="))).toBe(false);
  });
});

describe("backgrounds", () => {
  test("a gradient gets one stop per colour, spread across the line", () => {
    const layout = layoutStill(windowShot(WITH_BACKGROUND));
    const { ctx, ops } = ctxOf();
    renderStill(ctx, { frame: FRAME }, layout);

    expect(ops.some((o) => o.startsWith("createLinearGradient("))).toBe(true);
    expect(ops).toContain("addColorStop(0,#e9edf2)");
    expect(ops).toContain("addColorStop(1,#cfd6e0)");
    expect(ops).toContain(`fillRect(0,0,${layout.canvas.width},${layout.canvas.height})`);
  });

  test("is painted first, under the shadow and the capture", () => {
    const layout = layoutStill(windowShot(WITH_BACKGROUND));
    const { ctx, ops } = ctxOf();
    renderStill(ctx, { frame: FRAME }, layout);
    const fill = at(ops, /^fillRect\(0,0,/);
    const shadow = at(ops, /^shadowColor=/);
    expect(fill).toBeGreaterThan(0);          // after clearRect
    expect(fill).toBeLessThan(shadow);
  });

  test("a solid background is a fill, with no gradient built at all", () => {
    const layout = layoutStill(windowShot({
      ...WITH_BACKGROUND, background: { kind: "solid", colors: ["#101014"] },
    }));
    const { ctx, ops } = ctxOf();
    renderStill(ctx, { frame: FRAME }, layout);
    expect(ops).toContain("fillStyle=#101014");
    expect(ops.some((o) => o.startsWith("createLinearGradient("))).toBe(false);
  });

  test("a radial background is built from the centre outward", () => {
    const layout = layoutStill(windowShot({
      ...WITH_BACKGROUND,
      background: { kind: "radial", colors: ["#ffffff", "#000000"] },
    }));
    const { ctx, ops } = ctxOf();
    renderStill(ctx, { frame: FRAME }, layout);
    const { width, height } = layout.canvas;
    expect(ops).toContain(
      `createRadialGradient(${width / 2},${height / 2},0,${width / 2},${height / 2},${Math.hypot(width, height) / 2})`);
  });

  test("an image background is drawn over the whole canvas when one is supplied", () => {
    const layout = layoutStill(windowShot({
      ...WITH_BACKGROUND, background: { kind: "image", file: "bg.png", colors: ["#222222"] },
    }));
    const { ctx, ops } = ctxOf();
    renderStill(ctx, { frame: FRAME, background: BACKDROP }, layout);
    expect(drawImages(ops)[0]).toBe(
      `drawImage(<backdrop>,0,0,${layout.canvas.width},${layout.canvas.height})`);
  });

  test("wallpaper with nothing supplied falls back to a colour, not to transparency", () => {
    // Nothing sources the desktop picture yet. A mode that promises a
    // background has to produce one, or the shot silently comes out with a
    // transparent hole where the design said there was a backdrop.
    const layout = layoutStill(windowShot({
      ...WITH_BACKGROUND, background: { kind: "wallpaper", colors: ["#334455"] },
    }));
    const { ctx, ops } = ctxOf();
    renderStill(ctx, { frame: FRAME }, layout);
    expect(ops).toContain("fillStyle=#334455");
    expect(ops).toContain(`fillRect(0,0,${layout.canvas.width},${layout.canvas.height})`);
  });
});

describe("redactions", () => {
  test("are filled solid, over the capture", () => {
    const layout = layoutStill(regionShot({
      mode: "selected-area", canvas: "natural", cursor: false,
      redactions: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.05 }],
    }));
    const { ctx, ops } = ctxOf();
    renderStill(ctx, { frame: FRAME }, layout);
    const r = layout.redactions[0]!;
    const fill = ops.indexOf(`fillRect(${r.x},${r.y},${r.width},${r.height})`);
    const draw = ops.indexOf("drawImage(<frame>,0,0,1280,720)");
    expect(fill).toBeGreaterThan(draw);
    expect(ops).toContain("fillStyle=#000000");
  });

  test("nothing is drawn after them that could soften them", () => {
    // Irreversible is the point (STC-297): a shadow or a gradient over a fill
    // would make the covered pixels not quite uniform.
    const layout = layoutStill(windowShot({
      ...WITH_BACKGROUND,
      redactions: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }],
    }));
    const { ctx, ops } = ctxOf();
    renderStill(ctx, { frame: FRAME }, layout);
    const r = layout.redactions[0]!;
    const fill = ops.indexOf(`fillRect(${r.x},${r.y},${r.width},${r.height})`);
    expect(fill).toBeGreaterThan(0);
    expect(ops.slice(fill + 1).some((o) => o.startsWith("drawImage("))).toBe(false);
  });
});

describe("the cursor", () => {
  test("is drawn last, over everything", () => {
    const layout = layoutStill(windowShot({
      ...WITH_BACKGROUND, cursor: true,
    } as Record<string, unknown>));
    // The shot above has no recorded pointer, so add one via a fresh document.
    const withPointer = parseShot({
      ...JSON.parse(JSON.stringify(windowShot({ ...WITH_BACKGROUND, cursor: true }))),
      cursor: { x: 400, y: 320, shape: "arrow" },
    });
    const l = layoutStill(withPointer);
    expect(l.cursor).toBeDefined();
    const { ctx, ops } = ctxOf();
    renderStill(ctx, { frame: FRAME }, l);
    const lastDraw = ops.map((o) => o.startsWith("drawImage(")).lastIndexOf(true);
    // cursor-art traces a path; any of its ops must come after the last image.
    const pathAt = ops.findIndex((o, i) => i > lastDraw && o === "beginPath()");
    expect(pathAt).toBeGreaterThan(lastDraw);
    expect(layout.canvas.width).toBeGreaterThan(0);
  });

  test("is absent from the operations when the decoration does not ask for it", () => {
    const l = layoutStill(windowShot(WITH_BACKGROUND));
    const { ctx, ops } = ctxOf();
    renderStill(ctx, { frame: FRAME }, l);
    expect(ops.some((o) => o === "beginPath()")).toBe(false);
  });
});

describe("determinism", () => {
  test("the same layout issues exactly the same operations", () => {
    // The acceptance list's "render() stays pure", at the layer where it can
    // be checked without a rasteriser. Whether the same operations then give
    // the same PIXELS is the browser gate's question, deliberately separate.
    const l = layoutStill(windowShot({
      ...WITH_BACKGROUND,
      redactions: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }],
    }));
    const a = ctxOf(); renderStill(a.ctx, { frame: FRAME }, l);
    const b = ctxOf(); renderStill(b.ctx, { frame: FRAME }, l);
    expect(a.ops).toEqual(b.ops);
    expect(a.ops.length).toBeGreaterThan(5);
  });
});
