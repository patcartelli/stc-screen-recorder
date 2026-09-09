import { SIM_HZ, EXPORT_FPS } from "./time.js";
import { OMEGA, CHECKPOINT_INTERVAL } from "./cursor.js";
import { ZOOM_HOLD_NS, ZOOM_LEAD_NS, ZOOM_MERGE_GAP_NS, ZOOM_PRESETS } from "./zoom.js";
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
 * ## Auto-zoom IS here, at version 3 — the deferral note is discharged
 *
 * The note this replaces said to wait: stage 2 is stubbed, the crop is the
 * whole frame, `composite` takes the same five-argument `drawImage`, no pixel
 * differs, and bumping would "claim a change that did not happen". That
 * reasoning is right about the PIXELS and wrong about what the stamp is for,
 * and #112 is what made the difference concrete.
 *
 * `project-4` carries `zoom.enabled`, `zoom.intensity` and `zoom.preset` now.
 * Two takes rendered by the same code with different presets are different
 * renders of the same session, and a version 2 stamp on both is a stamp that
 * cannot tell them apart — which is the question this file exists to answer.
 * The stamp is what code rendered an edit, not whether the last change to that
 * code happened to be visible.
 *
 * The second reason is the guard rather than the record. `transformFingerprint`
 * fails until a constant that reaches the render is declared to it, and the
 * window between "the derivation runs" and "STC-326 gives the crop a target"
 * is exactly the window in which leaving zoom's four constants out would
 * switch that guard off — someone could retune the presets, change what every
 * export's zoom does, and no test would notice.
 *
 * So version 3 says: the derivation runs, and a document can change it. It
 * does NOT claim the picture moved, and TRANSFORM_HISTORY says so in as many
 * words. STC-326 bumps again when the picture does move.
 */
export const TRANSFORM_VERSION = 3;

/** What each version rendered. The last entry is TRANSFORM_VERSION. */
export const TRANSFORM_HISTORY: readonly { version: number; since: string; changed: string }[] = [
  { version: 1, since: "2026-08-24", changed: "placeholder circle cursor; 120 Hz spring, OMEGA 30, checkpoints every 1024 ticks" },
  { version: 2, since: "2026-09-02", changed: "macOS pointer artwork (arrow, I-beam, crosshair, pointing hand) drawn from events-2 cursor-shape events; circle kept as project.cursor.style \"circle\" (#65)" },
  { version: 3, since: "2026-09-09", changed: "auto-zoom stage 1 (STC-325): windows from clicks and held-button moves (300 ms lead, 2500 ms hold, 2500 ms merge) drive a critically damped 120 Hz spring, and project-4's zoom.enabled/intensity/preset choose whether and how hard. NO PIXEL MOVES at this version — the crop is the whole frame until STC-326 supplies a target — so the bump records that the derivation runs and that a document can now change it, not that the picture changed (#108, #112)" },
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
    // Auto-zoom's constants shape `zoom.amount` already and reach the pixels
    // the moment STC-326 gives the crop a target. Declared NOW rather than
    // then: a constant that changes the render but not the hash is exactly
    // what this guard exists to prevent, and the stubbed window is the only
    // one in which they could be retuned unnoticed.
    zoom: { ZOOM_LEAD_NS, ZOOM_HOLD_NS, ZOOM_MERGE_GAP_NS, ZOOM_PRESETS },
  };
  const text = JSON.stringify(inputs);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
