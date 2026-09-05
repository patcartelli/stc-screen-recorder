import { layoutStill, decorationForMode } from "@transform/still-decorate";
import { renderStill } from "@transform/still-render";
import { parseShot, type DecorationMode, type Shot } from "@transform/shot";
import { mark } from "./mark.js";

/**
 * The still gate's page (STC-291).
 *
 * ## Why the capture is synthesised here
 *
 * The gate asserts things about alpha at a window's rounded corner, and about
 * a shadow falling to zero. Both need to know exactly where the window's shape
 * ends — so the "capture" is drawn here as a rounded rectangle of a known
 * radius and a known colour, rather than loaded from a committed PNG whose
 * corner geometry nobody could state. It is the same premultiplied,
 * alpha-carrying image a real window capture is; it is simply one whose edges
 * the assertions can name.
 *
 * ## Why there are no golden images
 *
 * Gradients, blurred shadows and antialiased curves are Skia's output, and
 * CLAUDE.md records that this project's pre-encode hashes already differ
 * between rasterisation backends for far simpler drawing. A committed golden
 * would be a stored constant across engines, which the codebase does not
 * control, and it would go red on a Chromium bump rather than on a regression.
 * So the gate asserts PROPERTIES that hold in any correct rasteriser — alpha is
 * zero outside the shape, the fringe is not dark, the shadow decreases
 * outward — plus determinism between two renders inside this one browser.
 */

const FILL = { r: 0x2f, g: 0x6d, b: 0xd8 };
export const CORNER_RADIUS = 24;
const FRAME_W = 480;
const FRAME_H = 320;

/** A window capture: opaque rounded rectangle, transparent outside it. */
function makeCapture(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = FRAME_W;
  c.height = FRAME_H;
  const ctx = c.getContext("2d", { alpha: true })!;
  ctx.clearRect(0, 0, FRAME_W, FRAME_H);
  ctx.fillStyle = `rgb(${FILL.r}, ${FILL.g}, ${FILL.b})`;
  ctx.beginPath();
  // roundRect is the shape a real window has; drawn once, so both the capture
  // and every assertion about it agree on where the curve is.
  ctx.roundRect(0, 0, FRAME_W, FRAME_H, CORNER_RADIUS);
  ctx.fill();
  return c;
}

function shotFor(mode: DecorationMode, canvasPreset = "natural"): Shot {
  const dec = decorationForMode(mode, { canvas: canvasPreset as never });
  const base: Record<string, unknown> = {
    version: 1,
    capturedAtNs: "1000000000",
    timebase: { numer: 125, denom: 3 },
    display: {
      id: 1, pointWidth: 1920, pointHeight: 1080, pixelWidth: 1920, pixelHeight: 1080,
      backingScale: 1, originX: 0, originY: 0,
    },
    decoration: JSON.parse(JSON.stringify(dec)),
  };
  if (mode === "selected-area") {
    base.kind = "display-crop";
    base.crop = { x: 40, y: 30, width: FRAME_W, height: FRAME_H };
    base.frame = { file: "frame.png", width: FRAME_W, height: FRAME_H, alpha: false };
  } else {
    base.kind = "window";
    base.window = { id: 7, app: "Probe", title: "Window",
                    bounds: { x: 40, y: 30, width: FRAME_W, height: FRAME_H } };
    base.frame = { file: "frame.png", width: FRAME_W, height: FRAME_H, alpha: true };
  }
  return parseShot(base);
}

interface Px { r: number; g: number; b: number; a: number }
const pixelAt = (d: ImageData, x: number, y: number): Px => {
  const i = (Math.round(y) * d.width + Math.round(x)) * 4;
  return { r: d.data[i]!, g: d.data[i + 1]!, b: d.data[i + 2]!, a: d.data[i + 3]! };
};

/** FNV-1a over the RGBA, so two renders can be compared without shipping pixels. */
function hash(d: ImageData): string {
  let h = 0xcbf29ce4_8422_2325n;
  const prime = 0x0000_0100_0000_01b3n;
  const mask = 0xffff_ffff_ffff_ffffn;
  for (let i = 0; i < d.data.length; i++) {
    h = ((h ^ BigInt(d.data[i]!)) * prime) & mask;
  }
  return h.toString(16);
}

export interface StillProbe {
  mode: string;
  canvas: { width: number; height: number };
  content: { x: number; y: number; width: number; height: number };
  alpha: boolean;
  hash: string;
  /** Deep inside the window: must be the fill, fully opaque. */
  interior: Px;
  /** Outside the rounded corner but inside the content rect. */
  outsideCorner: Px;
  /** The canvas's very corner. */
  canvasCorner: Px;
  /**
   * Partially transparent pixels on the corner curve, with their colour
   * un-premultiplied by the browser on read. A dark fringe shows up here as
   * RGB pulled toward black while alpha is mid-range.
   */
  fringe: Px[];
  /** Alpha sampled straight down from the window's bottom edge, outward. */
  shadowRay: number[];
  /** Every pixel opaque? The test for "a background covers everything". */
  fullyOpaque: boolean;
}

function render(mode: DecorationMode, canvasPreset: string): { probe: StillProbe; data: ImageData } {
  const shot = shotFor(mode, canvasPreset);
  const layout = layoutStill(shot);
  const cv = document.createElement("canvas");
  cv.width = layout.canvas.width;
  cv.height = layout.canvas.height;
  // alpha: true always — a context without it composites modes 2 and 3 onto
  // opaque black, which is the exact failure the gate exists to catch, and it
  // would catch it as "everything is opaque" rather than as a context mistake.
  const ctx = cv.getContext("2d", { alpha: true, willReadFrequently: true })!;
  renderStill(ctx as never, { frame: makeCapture() }, layout);

  const data = ctx.getImageData(0, 0, cv.width, cv.height);
  const { content } = layout;

  // Just outside the corner curve: the centre of the arc is inset by the
  // radius, so a point one pixel diagonally beyond it is outside the shape.
  const inset = CORNER_RADIUS - Math.SQRT1_2 * CORNER_RADIUS;
  const outsideCorner = pixelAt(data, content.x + inset / 2, content.y + inset / 2);

  const fringe: Px[] = [];
  for (let t = 0; t <= 20; t++) {
    const ang = (Math.PI / 2) * (t / 20) + Math.PI;
    const cx = content.x + CORNER_RADIUS, cy = content.y + CORNER_RADIUS;
    const p = pixelAt(data, cx + Math.cos(ang) * CORNER_RADIUS, cy + Math.sin(ang) * CORNER_RADIUS);
    if (p.a > 8 && p.a < 248) fringe.push(p);
  }

  const shadowRay: number[] = [];
  const rayX = content.x + content.width / 2;
  for (let dy = 0; dy < Math.max(1, layout.canvas.height - (content.y + content.height)); dy += 2) {
    shadowRay.push(pixelAt(data, rayX, content.y + content.height + dy).a);
  }

  let fullyOpaque = true;
  for (let i = 3; i < data.data.length; i += 4) {
    if (data.data[i] !== 255) { fullyOpaque = false; break; }
  }

  return {
    data,
    probe: {
      mode, canvas: layout.canvas, content, alpha: layout.alpha, hash: hash(data),
      interior: pixelAt(data, content.x + content.width / 2, content.y + content.height / 2),
      outsideCorner,
      canvasCorner: pixelAt(data, 0, 0),
      fringe, shadowRay, fullyOpaque,
    },
  };
}

/**
 * Render one REAL shot, for a human to look at (`scripts/decorate-one.mjs`).
 *
 * Not used by the gate, and deliberately in the same page: the gate proves
 * properties and only a person can say whether the result looks like a product
 * shot, so the two want the exact same code path and no second harness to
 * drift from it.
 */
async function decorateReal(shotDoc: unknown, frameSrc: string,
                            mode: string | undefined): Promise<string> {
  const raw = shotDoc as Record<string, unknown>;
  const existing = (raw.decoration ?? {}) as Record<string, unknown>;
  // Switching mode takes THAT mode's preset. Only the choices that are not a
  // mode's business are carried over — inheriting the old mode's padding and
  // shadow would make "show me window-shadow" show the previous mode wearing a
  // new label, which is the opposite of what the tool is for.
  const doc = mode
    ? { ...raw, decoration: JSON.parse(JSON.stringify(
        decorationForMode(mode as DecorationMode, {
          canvas: existing.canvas as never,
          cursor: existing.cursor as never,
          redactions: existing.redactions as never,
        }))) }
    : raw;
  const shot = parseShot(doc);
  const img = new Image();
  img.src = frameSrc;
  await img.decode();

  const layout = layoutStill(shot);
  const cv = document.createElement("canvas");
  cv.width = layout.canvas.width;
  cv.height = layout.canvas.height;
  const ctx = cv.getContext("2d", { alpha: true })!;
  renderStill(ctx as never, { frame: img }, layout);
  return cv.toDataURL("image/png");
}

declare global {
  interface Window {
    __decorate(shot: unknown, frameSrc: string, mode?: string): Promise<string>;
    __stillGate(): Promise<{
      probes: StillProbe[];
      /** The same mode rendered twice: the hashes must agree. */
      repeat: { first: string; second: string };
      fill: { r: number; g: number; b: number };
      cornerRadius: number;
    }>;
    __ready: boolean;
  }
}

window.__decorate = decorateReal;

window.__stillGate = async () => {
  mark("still gate: rendering");
  const probes: StillProbe[] = [];
  for (const mode of ["selected-area", "window-only", "window-shadow",
                      "window-shadow-background", "window-shadow-custom-background"] as const) {
    probes.push(render(mode, "natural").probe);
  }
  // Canvas presets, on the mode where the geometry is easiest to state.
  for (const preset of ["16:9", "4:3", "1:1"]) {
    const p = render("window-only", preset).probe;
    p.mode = `window-only@${preset}`;
    probes.push(p);
  }
  mark("still gate: rendered");

  const a = render("window-shadow-background", "natural").probe.hash;
  const b = render("window-shadow-background", "natural").probe.hash;
  return { probes, repeat: { first: a, second: b }, fill: FILL, cornerRadius: CORNER_RADIUS };
};

window.__ready = true;
mark("still gate: ready");
