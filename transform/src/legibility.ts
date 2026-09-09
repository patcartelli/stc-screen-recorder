import { EMBED_CSS_WIDTH } from "./output-size.js";

/**
 * Will the viewer be able to read it? (STC-318)
 *
 * The take is 4K. The demo is watched in a column a fraction of that wide.
 * Several vendors in this category name that as the real quality problem in
 * their own writeups and none of them act on it, so this is a pure function
 * over four numbers rather than OCR or a pixel measurement.
 *
 * ## THE OUTPUT WIDTH CANCELS, and that is the whole finding
 *
 * Work it through in `spaces.ts`'s vocabulary. Text of `T` points on the
 * recorded display occupies `T * sx` OUTPUT pixels, where `sx` is
 * `output.width / display.pointWidth` (`displayToOutput`). The video is then
 * shown in a container `E` CSS pixels wide, so each output pixel is
 * `E / output.width` CSS pixels. Multiply:
 *
 *     textPx = T * (output.width / display.pointWidth) * (E / output.width)
 *            = T * E / display.pointWidth
 *
 * `output.width` appears once above the line and once below it. **Exporting
 * smaller does not make the text bigger**, and exporting at 4K does not make
 * it smaller — the choice STC-335 exposes is about file weight and about how
 * much detail survives resampling, and it has NO effect on apparent size. That
 * is worth stating loudly because the opposite is the intuitive belief, and
 * acting on it would be a whole afternoon spent re-exporting for nothing.
 *
 * ## The ticket's signature could not answer this
 *
 * STC-318 specifies `legibility(project, embedWidthPx, zoomFactor)`, and its
 * worked example — *"13pt system text in a 1920-wide export embedded at 720px
 * renders at ~4.9px"* — is `T * E / output.width`. That agrees with the
 * formula above only when `output.width === display.pointWidth`, which is true
 * on a 1x display and false on every Mac made in the last decade: a 1728-point
 * retina display captures at 3456, and the ticket's version would report
 * **2.7px where the truth is 5.4px** — half, and on the wrong side of every
 * threshold.
 *
 * So the display's width IN POINTS is the input, and it lives in
 * `anchors.display`, not in the project. This function takes it directly. That
 * is the third ticket in this repo scoped from a premise that had to be
 * checked against the data (STC-314's "crop-UV does not exist", STC-325's
 * "events.json already carries keystrokes"), and all three were found the same
 * way, in about a minute, by deriving the thing rather than accepting it.
 *
 * ## What deliberately does NOT appear
 *
 * **`backingScale`.** Points already account for it — that is what a point is.
 * A retina capture has twice the pixels and the same number of points, and the
 * text is the same apparent size. It feels like it should matter and it does
 * not, which is exactly why the field is named here rather than left out
 * silently.
 *
 * **The viewer's own device pixel ratio.** A retina viewer renders 1232 CSS
 * pixels across 2464 device pixels: the text is physically the same size and
 * merely sharper. CSS pixels are the unit a human's reading threshold is
 * expressed in, so that is the unit here.
 */

/**
 * Below this, text is not reliably readable — the ticket's number.
 *
 * ONE level, deliberately. The gates' warn/fail split can come later if it
 * earns it; two thresholds now would be two numbers nobody has calibrated
 * instead of one.
 */
export const LEGIBILITY_WARN_PX = 9;

/** macOS system text. A web app at 14-16 CSS px is a different take, which is why this is per-take. */
export const DEFAULT_TEXT_PT = 13;

export interface Legibility {
  /** Apparent text height on the viewer's screen, in CSS pixels. */
  textPx: number;
  verdict: "ok" | "warn";
  /** Echoed back so a caller rendering the sentence needs no second source. */
  textPt: number;
  embedWidthPx: number;
  zoomFactor: number;
}

/** Just the display geometry this needs — not the whole anchors document. */
export interface DisplayPoints { pointWidth: number }

/**
 * `zoomFactor` is the RECIPROCAL of the crop's UV width, and 1 means no zoom.
 *
 * A crop half the frame wide shows half the content across the same container,
 * so everything in it is twice as big: factor 2. Stage 1 leaves the crop at the
 * full frame (STC-325), so every caller passes 1 today and this argument is the
 * seam STC-326 fills — the same shape `zoomCrop`'s `target` is.
 */
export function zoomFactorForCrop(cropUvWidth: number): number {
  return cropUvWidth > 0 ? 1 / cropUvWidth : 1;
}

export function legibility(
  display: DisplayPoints,
  textPt: number,
  embedWidthPx: number,
  zoomFactor = 1,
): Legibility {
  // Guarded rather than trusted: a malformed anchors document should give a
  // useless answer loudly (0, which warns) rather than Infinity or NaN, which
  // would render as "at 1232px, 13pt text renders at NaNpx" and read as a bug
  // in the sentence rather than in the data.
  const pointWidth = display.pointWidth > 0 ? display.pointWidth : 0;
  const textPx = pointWidth === 0
    ? 0
    : (textPt * embedWidthPx * zoomFactor) / pointWidth;
  return {
    textPx,
    verdict: textPx < LEGIBILITY_WARN_PX ? "warn" : "ok",
    textPt, embedWidthPx, zoomFactor,
  };
}

/**
 * The one sentence the UI shows. Here rather than in the renderer because it
 * is the same "one value, two copies" hazard as every filename in this repo —
 * and because the rounding is part of the claim: 9.04 shown as "9" beside a
 * threshold of 9 would look like a contradiction.
 */
export function legibilitySentence(l: Legibility): string {
  const px = l.textPx.toFixed(1);
  const zoom = l.zoomFactor === 1 ? "" : ` at ${l.zoomFactor.toFixed(1)}× zoom`;
  return `At ${l.embedWidthPx}px${zoom}, ${l.textPt}pt text renders at ${px}px`
    + (l.verdict === "warn" ? ` — below ${LEGIBILITY_WARN_PX}px, hard to read` : "");
}

export interface EmbedTarget { id: string; label: string; widthPx: number }

/**
 * Where a demo actually embeds, in CSS pixels.
 *
 * **Only one of the ticket's three is here, and that is a refusal rather than
 * an omission.** STC-318 asks for the case-study prose column and the
 * full-bleed hero as well, each marked *measure* — and they can only be
 * measured by someone who can see the site's Astro layout, which this
 * repository cannot. Inventing 680 and 1440 would produce a preset list that
 * looked authoritative and answered a different question than the one asked,
 * which is precisely what STC-242's provisional embed template was gated on
 * and what #115 then found to be wrong when someone finally looked.
 *
 * The free width covers every case meanwhile, and the gap is stated in the
 * ticket rather than filled with a guess.
 *
 * `/lab`'s width is IMPORTED from `output-size.ts`, never restated: it is the
 * same measurement driving the export presets, and a second copy is the defect
 * this repo has fixed six times.
 */
export const EMBED_TARGETS: readonly EmbedTarget[] = [
  { id: "lab", label: "Site /lab page", widthPx: EMBED_CSS_WIDTH },
];
