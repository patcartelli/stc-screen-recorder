import { SIM_HZ, EXPORT_FPS } from "./time.js";
import { OMEGA, CHECKPOINT_INTERVAL } from "./cursor.js";
import { ZOOM_HOLD_NS, ZOOM_LEAD_NS, ZOOM_MERGE_GAP_NS, ZOOM_PRESETS } from "./zoom.js";
import {
  CURSOR_SHAPES, DEFAULT_CURSOR_SHAPE, OUTLINE_PT, CLICK_HIGHLIGHT_PT, CIRCLE_PT, artFor,
} from "./cursor-art.js";
import {
  BURST_LEAD_NS, BURST_TRAIL_NS, CELL_ACTIVE_FRACTION, AMBIENT_FRAME_FRACTION, BURST_CONCENTRATION,
  MIN_ZOOM_DELTA_FRACTION, CROP_PAD_FRACTION, VIEWPORT_MIN_FRACTION, VIEWPORT_MAX_FRACTION,
  CURSOR_DEAD_ZONE_UV,
} from "./zoom-change.js";

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
 * words.
 *
 * ## Version 4 is the same guard, for the same stubbed window (STC-371)
 *
 * The three easing presets stopped being one spring run both ways: standard
 * and snappy now push in faster than they release (each preset's shipped
 * omega ×/÷ `Math.SQRT2`, picked by which way `createZoomSim`'s target is
 * pulling), and calm stays symmetric. `ZOOM_PRESETS` was already declared to
 * `transformFingerprint` for exactly this reason — the crop is still the
 * whole frame, so no export pixel moves, but the fingerprint changes the
 * moment the numbers inside that object do, and this file's own rule is
 * "never update the fingerprint alone."
 *
 * ## Version 5: the picture moves, for a window someone has TUNED (STC-330)
 *
 * STC-330's manual override table gives a WINDOW's crop a real target for
 * the first time — `zoom.crop` is no longer always the whole frame, and
 * `render()` now blends it toward that target as `zoom.amount` eases in and
 * out (`lerpRect`, spaces.ts). This is still not stage 2 (STC-326): nothing
 * DERIVES a target on its own, so an un-overridden window still crops to the
 * whole frame at every amount. But a take with even one manual override now
 * genuinely renders different pixels than one without, which version 4's own
 * promise ("still no export pixel moves") can no longer make. This landed as
 * a SEPARATE PR from STC-371's version 4 (both claimed "4" independently,
 * caught resolving the merge conflict rather than by any test — the same
 * shape of collision CLAUDE.md already records for STC-325) — version 5 is
 * what STC-330 actually ships as.
 *
 * ## Version 6: a window with no manual tuning can crop itself now (STC-326)
 *
 * Stage 2 supplies the automatic target version 3's own note deferred:
 * `zoom-change.ts`'s `deriveZoomCrop` reads `session.changes` (the
 * frame-difference sidecar, STC-322) when it covers a window, or falls back
 * to greedy dead-zone clustering of the window's own cursor positions when it
 * does not — true of every take today, since nothing here can run the
 * browser pass that writes `changes.json`. `render.ts` calls it only when a
 * window has no MANUAL override (STC-330 still wins), so this is the first
 * version where a take with no overrides at all can still show the picture
 * moving. Every threshold the classifier and the fallback use is declared to
 * `transformFingerprint` below — the same "declare now, not once STC-326
 * lands" reasoning version 3's own note already gave for `ZOOM_PRESETS`, now
 * paid off, because THIS is the version those constants start reaching real
 * pixels for a take with no overrides.
 *
 * ## Version 7: a window with no auto-zoom counterpart at all (STC-331)
 *
 * `overrides` may now carry a `kind: "manual"` entry — a window authored
 * from nothing, for when stage 1 correctly decided not to open one and the
 * user wants one anyway. Before this version such an entry was already
 * being WRITTEN by nothing (the UI did not exist) and would in any case
 * have been silently dropped on read (`trim.ts`'s `cleanOverrides` only
 * ever recognised `kind: "geometry"`) — a hand-authored `project.json`
 * naming one rendered exactly as if it said nothing. Now it renders a real
 * crop for a real span of time no derived window ever covered. No new
 * constant reaches the pixels (`manualWindows`/`resolvedCrop`/
 * `resolvedEasingName` in zoom-override.ts read the override's own
 * startNs/endNs/rect/easing, not a tunable of the code), so the
 * fingerprint below is UNCHANGED — this bump is the same kind version 5's
 * own note already drew out: a document can render differently under the
 * new code than under the old one, on the SAME session, which is the
 * question this stamp exists to answer, not "did a constant move".
 */
export const TRANSFORM_VERSION = 7;

/** What each version rendered. The last entry is TRANSFORM_VERSION. */
export const TRANSFORM_HISTORY: readonly { version: number; since: string; changed: string }[] = [
  { version: 1, since: "2026-08-24", changed: "placeholder circle cursor; 120 Hz spring, OMEGA 30, checkpoints every 1024 ticks" },
  { version: 2, since: "2026-09-02", changed: "macOS pointer artwork (arrow, I-beam, crosshair, pointing hand) drawn from events-2 cursor-shape events; circle kept as project.cursor.style \"circle\" (#65)" },
  { version: 3, since: "2026-09-09", changed: "auto-zoom stage 1 (STC-325): windows from clicks and held-button moves (300 ms lead, 2500 ms hold, 2500 ms merge) drive a critically damped 120 Hz spring, and project-4's zoom.enabled/intensity/preset choose whether and how hard. NO PIXEL MOVES at this version — the crop is the whole frame until STC-326 supplies a target — so the bump records that the derivation runs and that a document can now change it, not that the picture changed (#108, #112)" },
  { version: 4, since: "2026-09-14", changed: "asymmetric zoom shoulders (STC-371): standard and snappy push in at omega×√2 and release at omega÷√2 instead of one symmetric spring; calm is unchanged. Still no export pixel moves — the crop is still the whole frame until STC-326 — but the editor's Zoom lane curve (which samples render()'s own zoom.amount) already shows the new shape, and the fingerprint moved because ZOOM_PRESETS did" },
  { version: 5, since: "2026-09-14", changed: "manual zoom override, phase 1 (STC-330): project-6's overrides table gives a derived window a tuned crop rect and/or easing preset; render() blends the crop toward that target as zoom.amount eases (spaces.ts's lerpRect). Windows sharing a resolved easing are grouped and simmed independently, composed by max (zoom-override.ts). The FIRST version where the picture actually moves for a real take — a window with no override still crops to the whole frame, but one with an override now renders different pixels than the same take without it" },
  { version: 6, since: "2026-09-14", changed: "auto-zoom stage 2 (STC-326): a window with no manual override now derives its own crop via zoom-change.ts's deriveZoomCrop — the change track (session.changes) when it covers the window, greedy dead-zone cursor clustering otherwise (the fallback every take hits today, since no changes.json exists yet). A trusted null (everything changed, nothing did, or the union was barely tighter than the full frame) still crops to the whole frame; anything else blends toward a real target the same way a manual override does. The FIRST version where a take with NO overrides at all can render different pixels than the same take with auto-zoom off" },
  { version: 7, since: "2026-09-15", changed: "manual override, phase 2 (STC-331): project-6's overrides table gains a 'manual' variant — a window with no derived counterpart at all, authored with its own startNs/endNs/rect and a REQUIRED easing. Spliced into the same window list a derived window lives in (zoom-override.ts's manualWindows/CombinedZoomWindow) and resolved at the same first tier a geometry override is. nearestWindow (zoom-override.ts) and inWindow (zoom.ts) both moved from a sorted-disjoint bisect to a plain scan, since a manual window carries no promise of not overlapping a derived one or another manual one. No new constant reaches the pixels, so the fingerprint is unchanged; the bump records that a document can now render a span of time no derivation would ever have opened a window for" },
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
    // Auto-zoom's constants shape `zoom.amount` and reach the pixels for any
    // window a manual override or stage 2 supplies a target for.
    zoom: { ZOOM_LEAD_NS, ZOOM_HOLD_NS, ZOOM_MERGE_GAP_NS, ZOOM_PRESETS },
    // Stage 2's own thresholds (STC-326) — every one of them decides whether
    // and how a window with no manual override crops itself, for every take
    // rendered today (the cursor-clustering fallback needs no changes.json).
    zoomChange: {
      BURST_LEAD_NS, BURST_TRAIL_NS, CELL_ACTIVE_FRACTION, AMBIENT_FRAME_FRACTION,
      BURST_CONCENTRATION, MIN_ZOOM_DELTA_FRACTION, CROP_PAD_FRACTION,
      VIEWPORT_MIN_FRACTION, VIEWPORT_MAX_FRACTION, CURSOR_DEAD_ZONE_UV,
    },
  };
  const text = JSON.stringify(inputs);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
