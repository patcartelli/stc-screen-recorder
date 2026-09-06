import type {
  Background, Decoration, DecorationMode, Rect, Shadow, Shot,
} from "./shot.js";
import type { CursorShape } from "./types.js";

/**
 * Where everything goes in a decorated still (STC-291), decided without a
 * canvas.
 *
 * The same split the rest of this project uses: this module works out the
 * output size, where the capture sits inside it, how big the shadow is and
 * where the pointer lands — all of it arithmetic over `shot.json` — and
 * `still-render.ts` does nothing but draw the answer. That is what lets the
 * layout be exercised on a machine with no browser, and it is why the pixel
 * gate has so little left to check: only the things that are genuinely about
 * rasterisation, like whether the alpha at a corner is clean.
 *
 * ## The window's corners are not synthesised
 *
 * A window capture arrives WITH its real rounded corners, as alpha, because
 * the helper captures it through `desktopIndependentWindow` (STC-289). So
 * nothing here rounds anything: the shape is the frame's own alpha, and the
 * shadow is cast from that same alpha rather than from a rounded rectangle
 * this module guessed at. That is the whole reason window mode is not a crop,
 * and re-deriving a radius would throw away the fidelity it was built for.
 *
 * ## Nothing is scaled
 *
 * The capture is drawn at its natural pixel size, always. Canvas presets grow
 * the canvas around it; padding grows the canvas around it; the frame itself
 * is never resampled. Resampling a premultiplied image with a hard alpha edge
 * is exactly how a dark fringe appears at a window's corner, and the cheapest
 * way not to have one is not to resample.
 */

export interface Size { width: number; height: number }

/** A resolved shadow, in OUTPUT PIXELS rather than the document's points. */
export interface ShadowLayout {
  offsetX: number;
  offsetY: number;
  blur: number;
  /**
   * How far the shadow-casting silhouette is grown beyond the window, in
   * pixels. Canvas 2D has no spread, so `still-render.ts` implements it by
   * scaling the silhouette; the geometry of that scale is decided here.
   */
  spread: number;
  opacity: number;
}

export interface CursorLayout {
  x: number;
  y: number;
  shape: CursorShape;
  /** Output pixels per point, so the artwork is drawn at the capture's scale. */
  pxPerPoint: number;
}

export interface StillLayout {
  /** The output image. */
  canvas: Size;
  /** Where the capture is drawn, at its natural pixel size. */
  content: Rect;
  /**
   * Whether the output carries meaningful alpha. False for `selected-area`
   * and for any mode with an opaque background behind the whole canvas; true
   * for `window-only` and `window-shadow`, which are meant to be dropped onto
   * whatever the destination has. The caller needs this to choose its context
   * and its encoder.
   */
  alpha: boolean;
  /** Absent for `selected-area` and `window-only`. */
  shadow?: ShadowLayout;
  /** Absent when the canvas is left transparent. */
  background?: Background;
  /** Absent unless `decoration.cursor` and the shot recorded one. */
  cursor?: CursorLayout;
  /** Solid fills over the capture, already in output pixels. */
  redactions: Rect[];
}

/**
 * The five presets (STC-291, "v1 has no editor").
 *
 * **These values are reasoned, not made.** The ticket is explicit that they
 * should be chosen by producing real portfolio figures and looking at them,
 * which is not something that can be done from a machine with no screen. They
 * are deliberately conservative — a shadow that is present but not theatrical,
 * padding that frames without swallowing — and they are the one thing in this
 * file expected to change once someone has made a figure. Every parameter is
 * real and lives in `shot.json`; none is exposed individually until the still
 * editor exists (STC-300).
 */
export const PRESET_PADDING_PCT: Readonly<Record<DecorationMode, number>> = {
  "selected-area": 0,
  "window-only": 0,
  // Enough to let the shadow fall without clipping: the shadow reaches
  // roughly blur + offset, and the padding has to cover it.
  "window-shadow": 0.06,
  "window-shadow-background": 0.09,
  "window-shadow-custom-background": 0.09,
};

/** Points, at the capture's own scale. Provisional — see PRESET_PADDING_PCT. */
export const PRESET_SHADOW: Readonly<Shadow> = {
  offsetX: 0,
  offsetY: 18,
  blur: 48,
  spread: 0,
  opacity: 0.32,
};

/** Provisional — see PRESET_PADDING_PCT. A quiet neutral, not a statement. */
export const PRESET_BACKGROUND: Readonly<Background> = {
  kind: "linear",
  colors: ["#e9edf2", "#cfd6e0"],
  angleDeg: 135,
};

/**
 * The decoration a mode means, filled in from the presets.
 *
 * Explicit values in the document always win: the presets are what a fresh
 * capture gets, not a ceiling on what a document may say. That is what keeps
 * `shot.json` the artefact — a hand-edited shadow renders as written, and the
 * still editor, when it exists, has somewhere to write to.
 */
export function decorationForMode(mode: DecorationMode,
                                  over: Partial<Decoration> = {}): Decoration {
  const wantsShadow = mode !== "selected-area" && mode !== "window-only";
  const wantsBackground = mode === "window-shadow-background"
                       || mode === "window-shadow-custom-background";
  return {
    mode,
    canvas: over.canvas ?? "natural",
    cursor: over.cursor ?? false,
    redactions: over.redactions ?? [],
    paddingPct: over.paddingPct ?? PRESET_PADDING_PCT[mode],
    ...(wantsShadow ? { shadow: over.shadow ?? { ...PRESET_SHADOW } } : {}),
    ...(wantsBackground ? { background: over.background ?? { ...PRESET_BACKGROUND } } : {}),
    // A mode that wants neither still carries whatever the document set, so a
    // document is never silently stripped of a field it declared.
    ...(!wantsShadow && over.shadow ? { shadow: over.shadow } : {}),
    ...(!wantsBackground && over.background ? { background: over.background } : {}),
  };
}

const ASPECTS: Readonly<Record<string, number | undefined>> = {
  natural: undefined,
  "16:9": 16 / 9,
  "4:3": 4 / 3,
  "1:1": 1,
};

/**
 * Padding in output pixels.
 *
 * A FRACTION OF THE SHORT EDGE, never a pixel count: the same document
 * rendered from a 1x and a 2x capture has to look the same, and a fixed
 * padding would be half as wide on the Retina one. Rounded, because a canvas
 * of fractional size is a canvas whose edge pixel is a blend.
 */
export function paddingPixels(frame: Size, paddingPct: number | undefined,
                              shadow?: ShadowLayout): number {
  const pct = paddingPct ?? 0;
  const requested = pct > 0 ? Math.min(frame.width, frame.height) * pct : 0;
  return Math.round(Math.max(requested, shadowReachPixels(shadow)));
}

/**
 * How far a shadow actually extends beyond the shape casting it.
 *
 * Canvas's `shadowBlur` is a Gaussian with sigma = blur/2, which is visually
 * dead by three sigma — so the reach is 1.5x the blur, plus whatever the offset
 * and spread push it further. Taken as one number for all four sides because
 * the padding is uniform, so the worst side is the one that matters.
 *
 * This is a CORRECTNESS bound, not a taste one: padding smaller than this
 * clips the shadow against the canvas edge, which looks like a hard grey band
 * rather than a shadow. The still gate caught exactly that — the preset
 * padding is a percentage of the capture and the preset shadow is in points,
 * so on a small capture the percentage lost. If the resulting padding looks
 * too generous, the dial to turn is the SHADOW, not this.
 */
export function shadowReachPixels(shadow: ShadowLayout | undefined): number {
  if (!shadow) return 0;
  const spread = Math.max(0, shadow.spread);
  return Math.max(
    shadow.blur * 1.5 + Math.abs(shadow.offsetX) + spread,
    shadow.blur * 1.5 + Math.abs(shadow.offsetY) + spread,
  );
}

/**
 * The output canvas for a padded capture under a preset.
 *
 * A preset only ever GROWS: the capture is never cropped or scaled to hit an
 * aspect, because a 16:9 preset that shaved the top off a window would be a
 * decoration silently destroying the thing being decorated. The padded size is
 * the floor, and whichever dimension is short is grown to meet the ratio.
 */
export function canvasSize(content: Size, padding: number, preset: string): Size {
  const base = { width: content.width + padding * 2, height: content.height + padding * 2 };
  const aspect = ASPECTS[preset];
  if (!aspect) return base;
  const current = base.width / base.height;
  if (Math.abs(current - aspect) < 1e-9) return base;
  return current < aspect
    ? { width: Math.round(base.height * aspect), height: base.height }
    : { width: base.width, height: Math.round(base.width / aspect) };
}

/** A normalised (0..1) rectangle over the capture, in output pixels. */
function redactionToPixels(r: Rect, content: Rect): Rect {
  return {
    x: content.x + r.x * content.width,
    y: content.y + r.y * content.height,
    width: r.width * content.width,
    height: r.height * content.height,
  };
}

/**
 * Where the pointer lands, in output pixels.
 *
 * `shot.cursor` is in DISPLAY-LOCAL POINTS, and the capture is a crop of that
 * display at its backing scale — so the pointer has to be moved into the
 * crop's frame and multiplied by the scale before it means anything in output
 * pixels. A window shot has no crop to subtract from, and its frame origin is
 * the window's own bounds instead.
 *
 * Returns undefined when the pointer is outside the captured area, which is
 * not an error: a shot whose pointer was elsewhere on the display simply has
 * no pointer to draw, and drawing it clamped to an edge would be a lie.
 */
export function cursorLayout(shot: Shot, content: Rect,
                             pxPerPoint: number): CursorLayout | undefined {
  const c = shot.cursor;
  if (!c) return undefined;
  const origin = shot.kind === "window"
    ? { x: shot.window?.bounds.x ?? 0, y: shot.window?.bounds.y ?? 0 }
    : { x: shot.crop?.x ?? 0, y: shot.crop?.y ?? 0 };
  const x = content.x + (c.x - origin.x) * pxPerPoint;
  const y = content.y + (c.y - origin.y) * pxPerPoint;
  if (x < content.x || y < content.y
      || x >= content.x + content.width || y >= content.y + content.height) {
    return undefined;
  }
  return { x, y, shape: c.shape, pxPerPoint };
}

/**
 * Everything `still-render.ts` needs, from the document alone.
 *
 * Pure and total: any document `parseShot` accepted produces a layout, and the
 * same document always produces the same one. That is the acceptance list's
 * "render() stays pure" at the layer where it can actually be checked without
 * a rasteriser.
 */
export function layoutStill(shot: Shot): StillLayout {
  const dec = shot.decoration;
  const frame: Size = { width: shot.frame.width, height: shot.frame.height };
  const wantsShadow = dec.mode !== "selected-area" && dec.mode !== "window-only";
  const wantsBackground = dec.mode === "window-shadow-background"
                       || dec.mode === "window-shadow-custom-background";

  // The scale that turns the document's points into this output's pixels. The
  // capture is drawn 1:1, so it is the display's backing scale — read from the
  // frame against the region it came from rather than trusted from the display
  // block, which describes the display and not necessarily this crop.
  const sourcePoints = shot.kind === "window"
    ? shot.window?.bounds.width
    : shot.crop?.width;
  const pxPerPoint = sourcePoints && sourcePoints > 0
    ? frame.width / sourcePoints
    : shot.display.backingScale;

  const shadow: ShadowLayout | undefined = wantsShadow && dec.shadow
    ? {
        offsetX: dec.shadow.offsetX * pxPerPoint,
        offsetY: dec.shadow.offsetY * pxPerPoint,
        blur: Math.max(0, dec.shadow.blur * pxPerPoint),
        spread: dec.shadow.spread * pxPerPoint,
        opacity: dec.shadow.opacity,
      }
    : undefined;

  // Alpha survives only while nothing opaque is painted behind the whole
  // canvas. A background fills every pixel, so it ends the transparency; a
  // display crop is opaque to begin with.
  const alpha = shot.frame.alpha && !wantsBackground;

  // The padding has to hold the shadow, so the shadow is resolved first.
  const padding = paddingPixels(frame, dec.paddingPct, shadow);
  const canvas = canvasSize(frame, padding, dec.canvas);
  // Centred, and rounded to whole pixels: a capture at a half-pixel offset is
  // a capture resampled across every edge, which is the fringe again.
  const content: Rect = {
    x: Math.round((canvas.width - frame.width) / 2),
    y: Math.round((canvas.height - frame.height) / 2),
    width: frame.width,
    height: frame.height,
  };

  const layout: StillLayout = {
    canvas, content, alpha,
    redactions: dec.redactions.map((r) => redactionToPixels(r, content)),
  };
  if (shadow) layout.shadow = shadow;
  if (wantsBackground && dec.background) layout.background = dec.background;
  if (dec.cursor) {
    const c = cursorLayout(shot, content, pxPerPoint);
    if (c) layout.cursor = c;
  }
  return layout;
}
