import type { Handle, Point, Rect } from "./selection.js";

/**
 * The overlay's handle geometry, split out of `overlay.ts` purely so it can be
 * tested without a screen — same reason `library-items.ts` sits apart from
 * `library.ts` and `thumbnail.ts` from `thumbnail-window.ts`. `handlePoint` and
 * `handleAt` touch only `Rect`/`Point`/`Handle`, never the DOM, but they lived
 * in a module with top-level `document` calls, which makes that module
 * unimportable outside a browser — so nothing here was ever unit tested.
 * `app/test/overlay-hittest.test.ts` is the first thing that exercises them.
 */

export const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
/** How near a handle a press has to land. Generous: these are small targets. */
export const HANDLE_GRAB_PADDING = 8;

/** Handle positions for a marquee, in the same coordinate space as `r`. */
export function handlePoint(r: Rect, h: Handle): Point {
  const midX = r.x + r.width / 2, midY = r.y + r.height / 2;
  const right = r.x + r.width, bottom = r.y + r.height;
  switch (h) {
    case "nw": return { x: r.x, y: r.y };
    case "n": return { x: midX, y: r.y };
    case "ne": return { x: right, y: r.y };
    case "e": return { x: right, y: midY };
    case "se": return { x: right, y: bottom };
    case "s": return { x: midX, y: bottom };
    case "sw": return { x: r.x, y: bottom };
    case "w": return { x: r.x, y: midY };
  }
}

/**
 * Which handle a press is grabbing, if any. Nearest wins rather than first, so
 * the corners keep their own targets where two hit boxes overlap on a marquee
 * small enough for that to happen.
 *
 * On an EXACT tie (equidistant from two or more handles — reachable now that
 * `resizeRect` floors a marquee at `MIN_SELECTION_POINTS` rather than letting
 * it collapse: a press at the centre of a floored 4×4 selection is exactly
 * `HANDLE_GRAB_PADDING`-independent-of-direction from all eight), `<=` means
 * the LAST handle checked in `HANDLES` order wins, not the geometrically
 * nearest — there is no principled tiebreak when the distances are literally
 * equal, so this is an arbitrary but deterministic choice rather than a bug.
 * `overlay-hittest.test.ts` pins it so a reordering of `HANDLES` cannot change
 * which handle a tied press grabs without someone noticing.
 */
export function handleAt(local: Rect, p: Point): Handle | undefined {
  let best: Handle | undefined;
  let bestDist = HANDLE_GRAB_PADDING;
  for (const h of HANDLES) {
    const c = handlePoint(local, h);
    const d = Math.max(Math.abs(c.x - p.x), Math.abs(c.y - p.y));
    if (d <= bestDist) { best = h; bestDist = d; }
  }
  return best;
}
