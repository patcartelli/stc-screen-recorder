import type { Redaction } from "./shot.js";
import type { Point, Size } from "./spaces.js";
import { pixelsToUvRect } from "./spaces.js";

/**
 * Redaction's decisions (STC-297): what colour a fill is, and what a drag means.
 *
 * The same split every other still module keeps — this decides, `still-render.ts`
 * draws, and `app/src/thumbnail-renderer.ts` supplies the pointer. Nothing here
 * touches a canvas, so the whole of it is exercised by
 * `transform/test/still-redact.test.ts` without a browser.
 *
 * ## v1 is solid fill, and that is a security decision rather than a taste one
 *
 * The ticket's reasoning, kept here because it is the thing most likely to be
 * "improved" later: blur and pixelate both LOOK safe while being recoverable —
 * a light gaussian over 8pt text can be undone, and mosaic over a known font is
 * worse. A solid fill is the only treatment that is obviously irreversible to
 * the person sharing AND to the person receiving. Blur comes back only with an
 * adversarial test attached (sharpen, upscale, assert nothing is legible).
 *
 * ## Near-black is not "95% black"
 *
 * The ticket forbids partial alpha in as many words, and this does not use any:
 * every fill is drawn at alpha 1, so the covered pixels are REPLACED, not
 * shaded. What is "near" about near-black is the COLOUR, not the opacity — a
 * pure `#000` rectangle on a light screenshot reads as a rendering failure or a
 * missing image, while a hair off black reads as ink someone chose to put
 * there. Irreversibility is a property of the alpha; legibility as a deliberate
 * act is a property of the hue. They do not trade against each other.
 */

/** Near-black, for a fill sitting on light content. */
export const REDACTION_FILL_ON_LIGHT = "#0b0b0c";
/** Near-white, for a fill sitting on dark content. */
export const REDACTION_FILL_ON_DARK = "#f2f2f3";

/**
 * Mean luminance at or above this reads as "light content", so the fill goes
 * dark. Exactly 0.5 counts as light: a mid-grey is more often a light UI's
 * chrome than a dark one's, and the tie has to fall somewhere stated.
 */
export const REDACTION_LUMINANCE_THRESHOLD = 0.5;

/**
 * The smallest drag that counts as a region, in CAPTURE pixels.
 *
 * A bare click is not a redaction — it is how someone dismisses a menu or
 * checks that the panel has focus, the same rule `selection.ts` applies to the
 * overlay's marquee. Callers dragging on a scaled-down preview should pass
 * their own minimum in capture pixels (a few preview pixels' worth), because
 * four capture pixels of a 4K shot is a fraction of one preview pixel and
 * would let a click through.
 */
export const MIN_REDACTION_PX = 4;

export type { Point, Size } from "./spaces.js";

/**
 * Mean relative luminance of an RGBA buffer, 0..1, weighted by alpha.
 *
 * Rec. 709 coefficients on the GAMMA-ENCODED values rather than linearised
 * ones, deliberately: the answer this feeds is a binary "is the content under
 * this box light or dark", and the extra pass to linearise buys nothing a
 * threshold can see. It is the same weighted sum every "is this background
 * light?" check uses.
 *
 * Alpha WEIGHTS rather than being ignored, which matters for the transparent
 * modes: a window capture's rounded corner is `rgba(0,0,0,0)`, and counting
 * those as black would drag a region near a corner toward "dark content" and
 * put a near-white box on a light window. A region that is entirely
 * transparent has no content to judge, and reports 1 — light — so it takes the
 * near-black fill, which is the one that reads as deliberate against the
 * checkerboard a transparent PNG is usually shown on.
 */
export function meanLuminance(rgba: ArrayLike<number>): number {
  let sum = 0;
  let weight = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const a = (rgba[i + 3] as number) / 255;
    if (a === 0) continue;
    const l = (0.2126 * (rgba[i] as number)
             + 0.7152 * (rgba[i + 1] as number)
             + 0.0722 * (rgba[i + 2] as number)) / 255;
    sum += l * a;
    weight += a;
  }
  return weight === 0 ? 1 : sum / weight;
}

/** The fill for content of a given mean luminance. */
export function fillForLuminance(luminance: number): string {
  return luminance >= REDACTION_LUMINANCE_THRESHOLD
    ? REDACTION_FILL_ON_LIGHT : REDACTION_FILL_ON_DARK;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Two drag points in CAPTURE pixels → a normalised region, or undefined for a
 * drag too small to be one.
 *
 * Normalised (0..1 of the frame) because that is what `shot.json` stores and
 * what makes the ticket's "fill regions move with the content when the crop
 * changes, not with the canvas" true by construction rather than by
 * arithmetic: `layoutStill` multiplies these by the CONTENT rect, so padding,
 * a canvas preset and an output scale all move the box with the picture.
 *
 * A drag that leaves the capture CLAMPS rather than being refused — dragging
 * off the edge to cover something at the margin is the normal way to redact
 * something at the margin, and refusing it would be the panel declining to do
 * the obvious thing.
 */
export function normaliseRegion(a: Point, b: Point, frame: Size,
                                minPx = MIN_REDACTION_PX): Redaction | undefined {
  if (frame.width <= 0 || frame.height <= 0) return undefined;
  const x0 = clamp(Math.min(a.x, b.x), 0, frame.width);
  const x1 = clamp(Math.max(a.x, b.x), 0, frame.width);
  const y0 = clamp(Math.min(a.y, b.y), 0, frame.height);
  const y1 = clamp(Math.max(a.y, b.y), 0, frame.height);
  if (x1 - x0 < minPx || y1 - y0 < minPx) return undefined;
  // Capture pixels -> UV over the capture. The clamp above is policy; the
  // division is spaces.ts's (STC-314), so this cannot drift from the
  // conversion that reads the region back out.
  return pixelsToUvRect(
    { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
    { x: 0, y: 0, width: frame.width, height: frame.height },
  );
}

/**
 * Undo the last region. A whole editing model is not needed at this size (the
 * ticket says so); what is needed is that a mis-drag costs one gesture rather
 * than the shot.
 */
export function undoLast(regions: readonly Redaction[]): Redaction[] {
  return regions.slice(0, -1);
}
