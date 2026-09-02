import type { CursorShape } from "./types.js";

/**
 * The macOS pointer set as vector artwork, in cursor POINTS with the hotspot at
 * the origin. STC-239: this replaces the placeholder circle.
 *
 * Vector rather than bitmap on purpose. The compositor draws at whatever scale
 * the output demands (a 4K export of a 3008-point display draws the cursor at
 * 1.28 px per point, a preview at less), and a bitmap would have to be resampled
 * by the rasterizer — which is exactly the kind of backend-dependent pixel
 * output CLAUDE.md's rasterization trap is about. Paths drawn at scale are the
 * same operation in both sinks.
 *
 * Every shape is a black fill with a 1-point white outline, which is what the
 * system draws: stroke 2 points wide, centred on the edge, then fill on top so
 * the inner half of the stroke disappears under the black. Round joins keep an
 * acute tip (the arrow's is ~50°) from growing a miter spike.
 *
 * `CURSOR_SHAPES` is the list the events-2 schema's `shape` enum must equal —
 * cursor-art.test.ts holds the two together. A shape the schema admits but the
 * compositor cannot draw would be an event that silently draws the wrong
 * pointer, so the enum is exactly this list, and `artFor` is exhaustive.
 */

/** Path commands in cursor points: M/L (x, y), Q (cx, cy, x, y), Z. */
export type PathCommand =
  | ["M", number, number]
  | ["L", number, number]
  | ["Q", number, number, number, number]
  | ["Z"];

export interface CursorArt {
  /** Closed outline(s) in points, hotspot at (0, 0). */
  path: readonly PathCommand[];
}

/** Half the white outline's width, in points. The system's border is 1 point. */
export const OUTLINE_PT = 1;

/**
 * The click highlight's radius in points. The old placeholder drew it at twice
 * its 8-point circle; the value is kept so a take's highlight is the size it
 * was before the artwork changed.
 */
export const CLICK_HIGHLIGHT_PT = 16;

export const CURSOR_SHAPES: readonly CursorShape[] = ["arrow", "ibeam", "crosshair", "pointingHand"];

/** What a take shows before any cursor event, and what the helper's v1 events imply throughout. */
export const DEFAULT_CURSOR_SHAPE: CursorShape = "arrow";

function polygon(points: readonly (readonly [number, number])[]): PathCommand[] {
  const [first, ...rest] = points;
  if (!first) throw new Error("polygon needs at least one point");
  return [["M", first[0], first[1]], ...rest.map(([x, y]): PathCommand => ["L", x, y]), ["Z"]];
}

/** The standard arrow. Hotspot at the tip. ~13.5 x 19.3 points, as the system draws it at 1x. */
const ARROW: CursorArt = {
  path: polygon([
    [0, 0], [0, 16.5], [4.3, 12.6], [7.1, 19.3], [10.7, 17.8], [7.9, 11.3], [13.5, 11.3],
  ]),
};

/** The text I-beam. Hotspot at the centre of the stem. */
const IBEAM: CursorArt = {
  path: polygon([
    [-3.5, -9], [3.5, -9], [3.5, -7.5], [0.75, -7.5], [0.75, 7.5], [3.5, 7.5], [3.5, 9],
    [-3.5, 9], [-3.5, 7.5], [-0.75, 7.5], [-0.75, -7.5], [-3.5, -7.5],
  ]),
};

/** The crosshair. Hotspot at the centre. */
const CROSSHAIR: CursorArt = {
  path: polygon([
    [-0.5, -8], [0.5, -8], [0.5, -0.5], [8, -0.5], [8, 0.5], [0.5, 0.5], [0.5, 8], [-0.5, 8],
    [-0.5, 0.5], [-8, 0.5], [-8, -0.5], [-0.5, -0.5],
  ]),
};

/**
 * The pointing hand (links). Hotspot at the tip of the index finger, which is
 * where the system puts it. Outline traced clockwise from the fingertip:
 * index finger, three folded fingers as bumps, palm, thumb.
 */
const POINTING_HAND: CursorArt = {
  path: [
    ["M", -2, 2],
    ["Q", -2, 0, 0, 0],
    ["Q", 2, 0, 2, 2],
    ["L", 2, 9.5],
    ["Q", 3.6, 7.6, 5.4, 9.8],
    ["Q", 7.2, 8.2, 8.8, 10.4],
    ["Q", 10.6, 9.2, 11.8, 11.6],
    ["L", 11.8, 16],
    ["Q", 11.8, 21, 7.5, 21],
    ["L", 1.5, 21],
    ["Q", -2.5, 21, -4, 18],
    ["L", -6, 14],
    ["Q", -7, 12, -5, 11.5],
    ["Q", -3.5, 11.5, -2, 13],
    ["Z"],
  ],
};

export function artFor(shape: CursorShape): CursorArt {
  switch (shape) {
    case "arrow": return ARROW;
    case "ibeam": return IBEAM;
    case "crosshair": return CROSSHAIR;
    case "pointingHand": return POINTING_HAND;
    default: {
      // Exhaustiveness: a shape added to the type without artwork is a compile error.
      const never: never = shape;
      throw new Error(`no cursor artwork for shape ${String(never)}`);
    }
  }
}

/**
 * The slice of CanvasRenderingContext2D the artwork touches. Structural, so the
 * compositor passes its real context and a unit test can pass a recorder —
 * Node has no canvas, and the two sinks' agreement is the browser gates' job.
 */
export interface CursorCanvas {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineJoin: CanvasLineJoin;
  lineCap: CanvasLineCap;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
}

export function tracePath(ctx: CursorCanvas, path: readonly PathCommand[]): void {
  for (const c of path) {
    switch (c[0]) {
      case "M": ctx.moveTo(c[1], c[2]); break;
      case "L": ctx.lineTo(c[1], c[2]); break;
      case "Q": ctx.quadraticCurveTo(c[1], c[2], c[3], c[4]); break;
      case "Z": ctx.closePath(); break;
    }
  }
}

/**
 * Draw `shape` with its hotspot at output pixel (x, y), `pxPerPoint` output
 * pixels per cursor point. The transform's scale lands here as a context
 * transform, so the geometry and the outline width both scale together and no
 * caller has to remember to multiply the line width.
 */
export function drawCursor(ctx: CursorCanvas, shape: CursorShape, x: number, y: number, pxPerPoint: number): void {
  const art = artFor(shape);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(pxPerPoint, pxPerPoint);
  ctx.beginPath();
  tracePath(ctx, art.path);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = OUTLINE_PT * 2;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
  ctx.fillStyle = "#000000";
  ctx.fill();
  ctx.restore();
}
