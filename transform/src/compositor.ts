import type { FrameState } from "./render.js";

/**
 * The one compositor. Both sinks call exactly this with identical inputs on
 * identically-configured contexts ({ alpha: false, willReadFrequently: true },
 * which also keeps Chrome on the software raster path) — that is what makes
 * the pre-encode RGBA gate meaningful. Sinks may not fork this any more than
 * they may fork render().
 */
export function composite(
  ctx: OffscreenCanvasRenderingContext2D,
  frame: ImageBitmap | null,
  fs: FrameState,
  width: number,
  height: number,
): void {
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);
  if (frame) ctx.drawImage(frame, 0, 0, width, height);
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
