import { SIM_HZ, EXPORT_FPS } from "./time.js";
import { OMEGA, CHECKPOINT_INTERVAL } from "./cursor.js";
import {
  CURSOR_SHAPES, DEFAULT_CURSOR_SHAPE, OUTLINE_PT, CLICK_HIGHLIGHT_PT, CIRCLE_PT, artFor,
} from "./cursor-art.js";

/**
 * Which transform made the pixels (STC-308).
 *
 * render() is a pure function of (project, session, t) — within one version
 * of the code. The constants that decide every cursor pixel (the spring's
 * stiffness, the checkpoint interval, the pointer artwork) are not in the
 * project document, so a take re-rendered after any of them changed produced
 * different pixels with no record of why, and an export manifest recorded a
 * hash without saying which transform computed it.
 *
 * This is the stamp: written into project.json on save and into every export
 * manifest, read back by parseProject. The number is bumped by hand, and the
 * fingerprint below is what makes that honest — a test pins it, so changing
 * anything that reaches the pixels fails until the version is bumped and the
 * history says what changed.
 *
 * ## Auto-zoom is deliberately NOT here yet (STC-325)
 *
 * Stage 1 is in the render path and its constants (`ZOOM_LEAD_NS`, the hold,
 * the merge gap, the easing presets) decide nothing a viewer can see: stage 2
 * is stubbed, the crop is the whole frame, and `composite` takes the same
 * five-argument `drawImage` it always did. No pixel differs, so bumping the
 * version would claim a change that did not happen and put a lie in the
 * history — the stamp exists to EXPLAIN different pixels.
 *
 * The moment STC-326 makes the crop real, both halves are owed in the same
 * change: add zoom's constants to `transformFingerprint` below and bump. This
 * note is here rather than in the ticket because this file is where the
 * omission would be made.
 */
export const TRANSFORM_VERSION = 2;

/** What each version rendered. The last entry is TRANSFORM_VERSION. */
export const TRANSFORM_HISTORY: readonly { version: number; since: string; changed: string }[] = [
  { version: 1, since: "2026-08-24", changed: "placeholder circle cursor; 120 Hz spring, OMEGA 30, checkpoints every 1024 ticks" },
  { version: 2, since: "2026-09-02", changed: "macOS pointer artwork (arrow, I-beam, crosshair, pointing hand) drawn from events-2 cursor-shape events; circle kept as project.cursor.style \"circle\" (#65)" },
];

/**
 * Every constant that reaches the pixels, hashed. Bit-exact within a version:
 * the same inputs give the same fingerprint on every machine, so the pinned
 * value in transform-version.test.ts is a promise about the code, not about a
 * renderer. FNV-1a, because it needs no async and no platform crypto.
 */
export function transformFingerprint(): string {
  const inputs = {
    SIM_HZ, EXPORT_FPS, OMEGA, CHECKPOINT_INTERVAL,
    OUTLINE_PT, CLICK_HIGHLIGHT_PT, CIRCLE_PT, DEFAULT_CURSOR_SHAPE,
    art: CURSOR_SHAPES.map((s) => [s, artFor(s).path]),
  };
  const text = JSON.stringify(inputs);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
