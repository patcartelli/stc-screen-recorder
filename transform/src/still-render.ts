import type { Background } from "./shot.js";
import type { StillLayout } from "./still-decorate.js";
import { drawCursor } from "./cursor-art.js";

/**
 * The decorated still, drawn (STC-291). Everything it draws was decided by
 * `still-decorate.ts`; this file works out nothing except how to say it to a
 * canvas.
 *
 * ## The shadow is cast by the window's own alpha
 *
 * A window capture arrives with its real rounded corners as alpha, so the
 * shadow has to follow that shape rather than a rectangle. Canvas gives this
 * for free — `shadowColor` + `drawImage` shadows an image by its alpha — but
 * it draws the image as well as the shadow, and the image has to be drawn
 * separately anyway (at a different size, once spread is involved).
 *
 * So the shadow pass draws the frame far off the canvas and brings only its
 * shadow back with a matching `shadowOffsetX`. The image lands nowhere; the
 * shadow lands exactly where it belongs. That also makes `spread` — which
 * canvas has no property for — a matter of scaling the off-canvas image, since
 * nothing of it is visible to be distorted.
 *
 * ## Nothing is resampled
 *
 * The frame is drawn at its natural pixel size at integer coordinates. A
 * premultiplied image with a hard alpha edge, resampled, is precisely how the
 * dark fringe at a rounded corner appears, and the acceptance list forbids one.
 */

/** The slice of a 2D context this needs. Structural, so a recorder can stand in. */
export interface StillRenderContext {
  fillStyle: string | CanvasGradient | unknown;
  globalAlpha: number;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  save(): void;
  restore(): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  drawImage(image: unknown, dx: number, dy: number, dw: number, dh: number): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): unknown;
  createRadialGradient(x0: number, y0: number, r0: number,
                       x1: number, y1: number, r1: number): unknown;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(a: number, b: number, c: number, d: number, e: number, f: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  arc(x: number, y: number, r: number, s: number, e: number): void;
  strokeStyle: string;
  lineWidth: number;
  lineJoin: string;
}

interface GradientLike { addColorStop(offset: number, color: string): void }

const isGradient = (g: unknown): g is GradientLike =>
  !!g && typeof (g as GradientLike).addColorStop === "function";

/**
 * Gradient endpoints for a CSS-style angle across a box.
 *
 * CSS's convention, because it is the one anybody writing a value into
 * `shot.json` by hand will assume: 0° points to the top, 90° to the right, and
 * the line is long enough that the first and last stops land exactly on the
 * box's corners rather than somewhere inside it.
 */
export function gradientLine(width: number, height: number, angleDeg: number): {
  x0: number; y0: number; x1: number; y1: number;
} {
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(rad), dy = -Math.cos(rad);
  // Half the projection of the box onto the gradient direction.
  const half = (Math.abs(width * dx) + Math.abs(height * dy)) / 2;
  const cx = width / 2, cy = height / 2;
  return { x0: cx - dx * half, y0: cy - dy * half, x1: cx + dx * half, y1: cy + dy * half };
}

/** Paints the background over the whole canvas. */
function paintBackground(ctx: StillRenderContext, bg: Background,
                         width: number, height: number, image: unknown): void {
  const colors = bg.colors && bg.colors.length > 0 ? bg.colors : ["#ffffff"];

  if (bg.kind === "image" || bg.kind === "wallpaper") {
    // No image supplied — for `wallpaper` that is the normal state today,
    // since nothing sources the desktop picture yet (STC-291, not built). Fall
    // back to the first colour rather than leaving the canvas transparent: a
    // mode that promises a background must produce one.
    if (image) {
      ctx.drawImage(image, 0, 0, width, height);
      return;
    }
    ctx.fillStyle = colors[0]!;
    ctx.fillRect(0, 0, width, height);
    return;
  }

  if (bg.kind === "solid" || colors.length === 1) {
    ctx.fillStyle = colors[0]!;
    ctx.fillRect(0, 0, width, height);
    return;
  }

  const g = bg.kind === "radial"
    ? ctx.createRadialGradient(width / 2, height / 2, 0,
                               width / 2, height / 2, Math.hypot(width, height) / 2)
    : (() => {
        const l = gradientLine(width, height, bg.angleDeg ?? 180);
        return ctx.createLinearGradient(l.x0, l.y0, l.x1, l.y1);
      })();

  if (isGradient(g)) {
    const last = colors.length - 1;
    colors.forEach((c, i) => g.addColorStop(last === 0 ? 0 : i / last, c));
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = colors[0]!;
  }
  ctx.fillRect(0, 0, width, height);
}

/**
 * How far off-canvas the shadow pass parks the image it is casting from.
 *
 * Has to clear the canvas, the blur's own reach and any spread, or a sliver of
 * the real image would appear at the left edge — which would look like a
 * rendering bug and be one. Derived per render rather than a constant, because
 * a 6K capture with a large blur is far wider than any number worth hardcoding.
 */
export function shadowParkDistance(layout: StillLayout): number {
  const s = layout.shadow;
  const reach = s ? s.blur * 3 + Math.abs(s.spread) + Math.abs(s.offsetX) : 0;
  return layout.canvas.width + layout.content.width + reach + 64;
}

export interface StillSources {
  /** The captured frame. Null renders everything except the capture itself. */
  frame: unknown;
  /** A background image for `image`/`wallpaper` modes, when one was supplied. */
  background?: unknown;
}

/**
 * Draws one decorated still.
 *
 * Deterministic by construction: it reads `layout` and `sources` and nothing
 * else — no clock, no randomness, no ambient state — so two calls with the
 * same arguments issue the same operations in the same order. Whether the
 * rasteriser then produces the same pixels is a property of the rasteriser,
 * which is why the gate compares two renders inside ONE browser rather than
 * against a stored image (CLAUDE.md, the rasterization-backend trap).
 *
 * The context must have been created with `alpha: true` whenever
 * `layout.alpha` is set, or the transparency modes 2 and 3 exist for will be
 * composited onto opaque black by the canvas itself.
 */
export function renderStill(ctx: StillRenderContext, sources: StillSources,
                            layout: StillLayout): void {
  const { canvas, content } = layout;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (layout.background) {
    paintBackground(ctx, layout.background, canvas.width, canvas.height, sources.background);
  }

  // The shadow, under everything but the background.
  if (layout.shadow && sources.frame) {
    const s = layout.shadow;
    const park = shadowParkDistance(layout);
    ctx.save();
    ctx.shadowColor = `rgba(0, 0, 0, ${s.opacity})`;
    ctx.shadowBlur = s.blur;
    ctx.shadowOffsetX = s.offsetX + park;
    ctx.shadowOffsetY = s.offsetY;
    // Parked `park` to the left, so only the shadow returns. Spread grows the
    // casting shape, which is invisible where it actually sits.
    ctx.drawImage(sources.frame,
                  content.x - park - s.spread, content.y - s.spread,
                  content.width + s.spread * 2, content.height + s.spread * 2);
    ctx.restore();
  }

  if (sources.frame) {
    ctx.drawImage(sources.frame, content.x, content.y, content.width, content.height);
  }

  // Over the capture and under nothing: a fill that a shadow or a background
  // could soften would not be irreversible, and irreversible is the whole
  // point of solid fill (STC-297 owns the UI; this honours the field).
  if (layout.redactions.length > 0) {
    ctx.save();
    ctx.fillStyle = "#000000";
    for (const r of layout.redactions) ctx.fillRect(r.x, r.y, r.width, r.height);
    ctx.restore();
  }

  if (layout.cursor) {
    const c = layout.cursor;
    drawCursor(ctx as never, c.shape, c.x, c.y, c.pxPerPoint);
  }
}
