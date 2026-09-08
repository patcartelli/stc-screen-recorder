/**
 * Annotation — arrow, box, text (STC-295). The decisions, with no canvas.
 *
 * ## What an annotation is
 *
 * Three things, and deliberately only three: point at the thing, box the
 * thing, name the thing. The ticket's own framing is that *"the value is that
 * three things are fast, not that thirty are possible"*, so there is one accent
 * colour and a few weights rather than a palette — numbered badges, callouts,
 * freehand and stamps are named as out of scope and each is easy to add later.
 *
 * ## Coordinates are normalised to the CAPTURE
 *
 * Exactly like `decoration.redactions` (STC-297), and for the same reason:
 * `layoutStill` maps them onto the CONTENT rect, so an annotation moves with
 * the picture when the padding, the canvas preset or the output scale changes,
 * rather than staying where it was on a canvas that has resized underneath it.
 * That is the ticket's second acceptance criterion, and it is structural here
 * rather than something the render pass has to remember.
 *
 * ## Sizes are in POINTS, not pixels and not fractions
 *
 * A stroke weight is a real width at the capture's own scale, resolved through
 * `pxPerPoint` the way the shadow already is — so a 1x and a 2x capture of the
 * same window get an arrow of the same apparent thickness. A FRACTION would be
 * wrong in the other direction: an arrow on a small crop would be spindly and
 * one on a large crop clumsy, for the same document.
 *
 * ## There is no outline, and that is the halo answer
 *
 * The obvious way to make markup legible on any background is a contrasting
 * outline under the stroke. It is also exactly how a halo appears where an
 * arrow crosses the window edge into transparent pixels: the outline's own
 * antialiased edge blends toward whatever is behind it, and behind it is
 * nothing. One flat colour, `source-over`, no outline and no shadow — the
 * fourth acceptance criterion is then a property of the drawing rather than
 * something to test for and patch.
 */

export interface Point { x: number; y: number }
export interface NormRect { x: number; y: number; width: number; height: number }

/** A few weights, not a slider. Points at the capture's scale. */
export type AnnotationWeight = "thin" | "regular" | "bold";
export type AnnotationTextSize = "small" | "regular" | "large";
export type BoxShape = "rect" | "ellipse";

export interface ArrowAnnotation {
  kind: "arrow";
  /** Normalised to the capture. The head is at `to` — an arrow points AT something. */
  from: Point;
  to: Point;
  weight: AnnotationWeight;
}

export interface BoxAnnotation {
  kind: "box";
  shape: BoxShape;
  /** Normalised to the capture. An outline, never a fill — a fill is redaction. */
  rect: NormRect;
  weight: AnnotationWeight;
}

export interface TextAnnotation {
  kind: "text";
  /** Normalised to the capture: the text's top-left. */
  at: Point;
  text: string;
  size: AnnotationTextSize;
}

export type Annotation = ArrowAnnotation | BoxAnnotation | TextAnnotation;

/**
 * The one accent colour.
 *
 * A saturated red-orange, which is what every markup tool converges on for the
 * same reason: it is the hue least likely to occur in chrome, text or a
 * screenshot's own UI, so it reads as "added" rather than as part of the
 * picture. Deliberately not stored per annotation — a colour field nothing
 * writes and nothing reads is a claim no test can check
 * (`docs/STC-300-FORMAT-AUDIT.md` §9), and a picker is a different ticket.
 */
export const ANNOTATION_ACCENT = "#e8452c";

/** Stroke widths in points at the capture's scale. */
export const ANNOTATION_WEIGHTS: Readonly<Record<AnnotationWeight, number>> = {
  thin: 2,
  regular: 3.5,
  bold: 6,
};

/** Text sizes in points at the capture's scale. */
export const ANNOTATION_TEXT_SIZES: Readonly<Record<AnnotationTextSize, number>> = {
  small: 13,
  regular: 18,
  large: 26,
};

/**
 * The font, in ONE place.
 *
 * The third acceptance criterion is *"text renders identically in preview and
 * export — same font, same rasterisation path"*, and the way that stays true is
 * that there is one string and one `renderStill`. Both the panel's preview and
 * the export composite call the same function in the same renderer process, so
 * "the same rasterisation path" is structural; the font being a second copy
 * somewhere is the only way they could still diverge, and this repo has fixed
 * that same "one value, two copies" defect five times.
 *
 * System UI rather than a bundled face: a still is a picture of this Mac, and
 * markup on it should look native to the same machine. The cost is stated —
 * this is NOT a determinism claim across machines, only across the two paths on
 * one machine, which is what the criterion asks for.
 */
export const ANNOTATION_FONT_STACK = '-apple-system, system-ui, "Segoe UI", sans-serif';

/** `600` — markup should read as a label, not as body text borrowed from the page. */
export const ANNOTATION_FONT_WEIGHT = 600;

/**
 * Line spacing as a multiple of the size, for a label with a newline in it.
 *
 * A constant rather than a `measureText` call, deliberately: text metrics are
 * the one part of this that a different rasteriser can answer differently, and
 * the acceptance criterion is that preview and export agree. Neither measures,
 * so neither can disagree.
 */
export const ANNOTATION_LINE_HEIGHT = 1.25;

export function annotationFont(sizePx: number): string {
  return `${ANNOTATION_FONT_WEIGHT} ${sizePx}px ${ANNOTATION_FONT_STACK}`;
}

/**
 * The arrow head, as a fraction of the stroke width.
 *
 * Tied to the WEIGHT rather than to the arrow's length, so a long arrow and a
 * short one look like the same pen. An arrow shorter than its own head would
 * be all head, so `arrowGeometry` shrinks the head to fit rather than letting
 * it overshoot the tail.
 */
export const ARROW_HEAD_LENGTH_RATIO = 4.2;
export const ARROW_HEAD_WIDTH_RATIO = 3.2;

/**
 * A drag becomes an arrow, or nothing at all.
 *
 * The floor is on the arrow's LENGTH rather than on a bounding box, because a
 * perfectly horizontal drag has zero height and is a perfectly good arrow —
 * `normaliseRegion`'s min-width-and-height rule would refuse it. Points are
 * clamped into the capture so a drag that leaves the preview still lands
 * somewhere renderable.
 */
export const MIN_ARROW_PX = 12;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export interface PixelSize { width: number; height: number }

export function normaliseArrow(from: Point, to: Point, frame: PixelSize,
                               minPx = MIN_ARROW_PX): ArrowAnnotation | undefined {
  if (!(frame.width > 0) || !(frame.height > 0)) return undefined;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.hypot(dx, dy) < minPx) return undefined;
  return {
    kind: "arrow",
    from: { x: clamp01(from.x / frame.width), y: clamp01(from.y / frame.height) },
    to: { x: clamp01(to.x / frame.width), y: clamp01(to.y / frame.height) },
    weight: "regular",
  };
}

/** The smallest box worth drawing. Below this a drag was a click. */
export const MIN_BOX_PX = 8;

export function normaliseBox(a: Point, b: Point, frame: PixelSize, shape: BoxShape = "rect",
                             minPx = MIN_BOX_PX): BoxAnnotation | undefined {
  if (!(frame.width > 0) || !(frame.height > 0)) return undefined;
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  if (x1 - x0 < minPx || y1 - y0 < minPx) return undefined;
  const x = clamp01(x0 / frame.width);
  const y = clamp01(y0 / frame.height);
  return {
    kind: "box", shape, weight: "regular",
    rect: {
      x, y,
      width: clamp01(x1 / frame.width) - x,
      height: clamp01(y1 / frame.height) - y,
    },
  };
}

/** Longer than this and it is a paragraph, which is a document, not a label. */
export const MAX_ANNOTATION_TEXT = 200;

/**
 * A label, or nothing.
 *
 * Empty text is not an annotation — it is an invisible object that can still be
 * selected and moved, which is the kind of thing that makes a canvas feel
 * haunted. Newlines are kept: a two-line label is reasonable and the renderer
 * lays them out.
 */
export function makeText(at: Point, text: string, frame: PixelSize,
                         size: AnnotationTextSize = "regular"): TextAnnotation | undefined {
  const trimmed = text.trim();
  if (!trimmed || !(frame.width > 0) || !(frame.height > 0)) return undefined;
  return {
    kind: "text",
    at: { x: clamp01(at.x / frame.width), y: clamp01(at.y / frame.height) },
    text: trimmed.slice(0, MAX_ANNOTATION_TEXT),
    size,
  };
}

/** Last in, first out — the same rule redaction's undo already follows. */
export function undoLastAnnotation(list: readonly Annotation[]): Annotation[] {
  return list.slice(0, Math.max(0, list.length - 1));
}

export interface ArrowGeometry {
  /** The shaft, stopping short of the head so the join is not a blob. */
  shaft: { from: Point; to: Point };
  /** The head as a triangle, tip first. */
  head: [Point, Point, Point];
}

/**
 * Where an arrow's parts go, in output pixels.
 *
 * Shared rather than done inside the draw call, so a future hit-test and the
 * renderer cannot disagree about where the arrow actually is — and so the
 * shape is checkable without a canvas.
 *
 * The shaft stops at the head's base. Drawing the full shaft and then the head
 * on top looks identical while the stroke is opaque and shows a seam the moment
 * anything is drawn at less than full alpha, which is the sort of thing that is
 * discovered late and blamed on the encoder.
 */
export function arrowGeometry(from: Point, to: Point, strokePx: number): ArrowGeometry {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) {
    return { shaft: { from, to }, head: [to, to, to] };
  }
  const ux = dx / len, uy = dy / len;
  // Never longer than half the arrow: a short arrow is mostly head, but an
  // arrow whose head overruns its own tail is a triangle pointing backwards.
  const headLen = Math.min(strokePx * ARROW_HEAD_LENGTH_RATIO, len / 2);
  const headHalf = (headLen / ARROW_HEAD_LENGTH_RATIO) * ARROW_HEAD_WIDTH_RATIO / 2;
  const base = { x: to.x - ux * headLen, y: to.y - uy * headLen };
  // Perpendicular, for the head's two back corners.
  const px = -uy, py = ux;
  return {
    shaft: { from, to: base },
    head: [
      { x: to.x, y: to.y },
      { x: base.x + px * headHalf, y: base.y + py * headHalf },
      { x: base.x - px * headHalf, y: base.y - py * headHalf },
    ],
  };
}
