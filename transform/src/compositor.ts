import type { FrameState } from "./render.js";

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
  if (frame) ctx.drawImage(frame, 0, 0, width, height);

  // The PiP sits UNDER the cursor deliberately: a cursor over the bottom-right
  // corner must stay visible. render() has already decided the rectangle; this
  // only draws it. Drawn only when both the geometry and a decoded frame exist
  // — no frame yet is a black gap, not a stretched stale one.
  if (fs.pip && camera) {
    ctx.drawImage(camera, fs.pip.x, fs.pip.y, fs.pip.width, fs.pip.height);
  }

  if (!fs.cursor.visible) return;

  const { x, y, scale, pressed } = fs.cursor;
  const r = 8 * scale;
  if (pressed) {
    ctx.beginPath();
    ctx.arc(x, y, r * 2, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.lineWidth = 2 * scale;
  ctx.strokeStyle = "#000000";
  ctx.stroke();
}
