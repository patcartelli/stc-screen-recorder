import { FULL_FRAME_UV, type FrameState } from "./render.js";
import { uvRectToPixels } from "./spaces.js";
import { CLICK_HIGHLIGHT_PT, drawCircle, drawCursor } from "./cursor-art.js";

/**
 * The one compositor. Both sinks call exactly this with identical inputs, and
 * that is what makes the pre-encode RGBA gate meaningful. Sinks may not fork
 * this any more than they may fork render().
 *
 * The contexts are NOT identically configured, and an earlier version of this
 * comment said they were: the gates and a hashing export use
 * { alpha: false, willReadFrequently: true } (software raster, so pixels can
 * be read back), while the app's preview and a plain export use { alpha: false }
 * alone. PHASE-2 measured the two raster paths byte-identical on this machine;
 * the identity gate compares them for real, inside one browser, and
 * export-identity.slow pins both processes to software because across
 * rasterizers they differ (CLAUDE.md, the rasterization-backend trap).
 */
/**
 * The display frame, cropped to the zoom's rectangle.
 *
 * The full-frame case takes the FIVE-argument `drawImage` rather than the
 * nine-argument one with a full source rect. The two are equivalent by spec
 * and this repo does not make claims about rasterisers it does not control —
 * CLAUDE.md records the pre-encode hash already differing between GPU and
 * swiftshader for far simpler drawing. Taking the old call when the crop is
 * the whole frame makes "auto-zoom stage 1 changes no pixels" true by
 * CONSTRUCTION rather than by a measurement that might not hold on the next
 * Chromium. The nine-argument path goes live with STC-326, which changes the
 * picture on purpose.
 *
 * The crop is UV over the CAPTURE, so it is converted against the frame's own
 * size through spaces.ts — the one owner (STC-314).
 */
function drawSource(
  ctx: OffscreenCanvasRenderingContext2D,
  frame: ImageBitmap,
  fs: FrameState,
  width: number,
  height: number,
): void {
  const c = fs.zoom.crop;
  if (c.x === 0 && c.y === 0 && c.width === 1 && c.height === 1) {
    ctx.drawImage(frame, 0, 0, width, height);
    return;
  }
  const src = uvRectToPixels(c, { x: 0, y: 0, width: frame.width, height: frame.height });
  ctx.drawImage(frame, src.x, src.y, src.width, src.height, 0, 0, width, height);
}

export function composite(
  ctx: OffscreenCanvasRenderingContext2D,
  frame: ImageBitmap | null,
  camera: ImageBitmap | null,
  fs: FrameState,
  width: number,
  height: number,
): void {
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);
  if (frame) drawSource(ctx, frame, fs, width, height);

  // The PiP sits UNDER the cursor deliberately: a cursor over the bottom-right
  // corner must stay visible. render() has already decided the rectangle; this
  // only draws it. Drawn only when both the geometry and a decoded frame exist
  // — no frame yet is a black gap, not a stretched stale one.
  if (fs.pip && camera) {
    ctx.drawImage(camera, fs.pip.x, fs.pip.y, fs.pip.width, fs.pip.height);
  }

  if (!fs.cursor.visible) return;

  // The click highlight sits UNDER the pointer, centred on the hotspot, so the
  // artwork stays legible through a click. (x, y) IS the hotspot: macOS
  // reports event locations at the hotspot, and cursor-art.ts puts each
  // shape's hotspot at its origin.
  const { x, y, pxPerPoint, pressed, shape, style } = fs.cursor;
  if (pressed) {
    ctx.beginPath();
    ctx.arc(x, y, CLICK_HIGHLIGHT_PT * pxPerPoint, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
    ctx.fill();
  }
  if (style === "circle") drawCircle(ctx, x, y, pxPerPoint);
  else drawCursor(ctx, shape, x, y, pxPerPoint);
}
