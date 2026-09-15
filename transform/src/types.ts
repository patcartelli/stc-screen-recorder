/**
 * `ZoomPreset` is derived from `ZOOM_PRESETS` in zoom.ts (`keyof typeof`), so
 * the preset NAMES have one source — the table itself. That makes this a
 * cycle on paper (zoom.ts imports this file for `SessionEvent`), and an
 * `import type` is erased entirely at build, so there is no cycle at runtime
 * and none for tsc to resolve. Worth it: the alternative is restating the
 * three names here and letting them drift from the table that defines them.
 */
import type { ZoomPreset } from "./zoom.js";
import type { Changes } from "./changes.js";

/** Mirrors schema/events-1.schema.json and events-2.schema.json. All times are session-relative integer ns. */
export interface MoveEvent {
  t: number;
  kind: "move";
  x: number;
  y: number;
}
export interface ButtonEvent {
  t: number;
  kind: "down" | "up";
  x: number;
  y: number;
  button: number;
}
/**
 * Which macOS pointer is showing from t onward (events-2). The set is the
 * artwork the compositor can draw — see transform/src/cursor-art.ts, which
 * holds the runtime list the schema's enum must equal.
 */
export type CursorShape = "arrow" | "ibeam" | "crosshair" | "pointingHand";
export interface CursorShapeEvent {
  t: number;
  kind: "cursor";
  shape: CursorShape;
}
export type SessionEvent = MoveEvent | ButtonEvent | CursorShapeEvent;

/** Mirrors the optional `camera` block in schema/anchors-2.schema.json. */
export interface CameraTrack {
  present: boolean;
  device: string;
  width: number;
  height: number;
  firstFramePtsNs: number;
  lastFramePtsNs: number;
  /** median inter-frame delta; bounds the track end (see render()) */
  frameIntervalNs: number;
}

/** Mirrors the optional `pip` block in schema/project-2.schema.json. */
export interface Pip {
  enabled: boolean;
  corner: "bottom-right";
  widthPct: number;
  marginPx: number;
}

/**
 * Mirrors the optional `scope` block in schema/anchors-3.schema.json
 * (STC-370). Absent (or `kind: "display"`) means the whole display — the
 * only shape a v1/v2 document can carry, and what an untouched take still
 * writes at v2 (`anchorsDocument` emits the minimum version that can express
 * the document). `region`/`window` are display-local points, the same
 * convention shot-1's `crop`/`window` already use.
 */
export type CaptureScope =
  | { kind: "display" }
  | { kind: "region"; region: { x: number; y: number; width: number; height: number } }
  | {
      kind: "window";
      window: {
        id: number;
        app?: string;
        title?: string;
        bounds: { x: number; y: number; width: number; height: number };
      };
    };

/** Mirrors schema/anchors-1.schema.json, anchors-2.schema.json and anchors-3.schema.json. */
export interface Anchors {
  version: 1 | 2 | 3;
  timebase: { numer: number; denom: number };
  t0Ns: string;
  display: {
    id: number;
    pointWidth: number;
    pointHeight: number;
    pixelWidth: number;
    pixelHeight: number;
    backingScale: number;
    originX: number;
    originY: number;
  };
  capture: { width: number; height: number; codec: "h264" };
  camera?: CameraTrack;
  /** STC-370. Absent means the whole display, the same as v1/v2. */
  scope?: CaptureScope;
  files: { display: string; camera?: string };
  /**
   * `reason` is a plain string, not a union, ON PURPOSE (STC-311).
   *
   * It was `"user" | "display-reconfigured" | "device-lost" | "error"` — a
   * fourth copy of a list that already lived in the schema and in the Swift
   * call sites, and it had drifted from both: it never gained
   * `stream-stopped`, and it could not express the shutdown reasons at all
   * (`quit`, `stdin-closed`, `signal-N`, plus a `-timeout` suffix on any of
   * them). A union that is missing values a real file carries is worse than
   * no union: it makes a `switch` look exhaustive when it is not, and it
   * type-checks a lie. The enumeration lives in anchors-2 and nowhere else;
   * `helper/test/stop-reasons.test.ts` holds the schema to what the helper
   * can actually write.
   */
  stop?: { t: number; reason: string };
}

/** Mirrors `cursor.style` in schema/project-2.schema.json. */
export type CursorStyle = "default" | "circle";

/** Mirrors the optional `trim` block in schema/project-2.schema.json. */
export interface Trim {
  startNs: number;
  endNs: number;
}

/**
 * Auto-zoom's user settings (project-4, STC-325).
 *
 * SETTINGS only. The windows are derived from the take's events every time
 * (`zoomWindows`), never stored — which is what STC-324 means by "a re-take
 * regenerates the derivation and keeps the overrides", and it costs nothing to
 * honour now.
 */
export interface Zoom {
  enabled: boolean;
  /** Scales the eased amount; 0 is indistinguishable from off. */
  intensity: number;
  preset: ZoomPreset;
}

/**
 * A manual override of one derived zoom window (project-6, STC-330).
 *
 * A discriminated union with ONE variant so far — later phases (STC-329,
 * STC-331) add variants, never migrations, per STC-328's own schema note.
 * `kind: "geometry"` is the only one this phase writes or reads; a document
 * naming another kind is from a later build this one does not have yet, and
 * is carried through unread rather than refused (see `zoom-override.ts`).
 *
 * `windowId` is the derived window's `startNs`, AS A STRING — deliberately
 * not the number itself, so it reads as an opaque identity rather than a
 * time a caller might be tempted to do arithmetic on. Stage 1's merge rule
 * (`ZOOM_MERGE_GAP_NS`) guarantees two windows in one take never share a
 * `startNs`, which is what makes this safe to use as a key with no
 * collision handling.
 *
 * **Take-local by design.** An override matches only the exact derivation
 * it was authored against — re-record from scratch and stage 1 derives a
 * new window list with new `startNs` values, so old overrides simply stop
 * matching anything. That is a deliberate simplification (STC-328), not a
 * bug: there is no cross-recording matching, no fuzzy tolerance, no
 * orphaned-override UX to design.
 *
 * `rect` is UV over the CAPTURE — the same space `ZoomState.crop` and a
 * redaction both live in (STC-314) — so it moves with the picture rather
 * than the canvas and needs no units of its own. `easing`, when present,
 * overrides the project's own `zoom.preset` for JUST this window; absent
 * means this window plays at the project's preset like every other one.
 *
 * The second variant (project-6, STC-331) is a window with NO auto-zoom
 * counterpart: `kind: "manual"` authors one from nothing, for when stage 1
 * correctly decided not to open a window and the user wants one anyway.
 * It carries its own `startNs`/`endNs` — there is no derived window to
 * inherit timing from — and `easing` is REQUIRED rather than optional,
 * for the same reason: a geometry override falls back to the project's own
 * `zoom.preset` when it names none, but a manual window has no derivation
 * to fall back to either, so `zoom-override.ts` never has an "absent"
 * case to resolve for it. `id` is take-local exactly like a derived
 * window's `startNs`-as-`windowId`, just freshly minted rather than
 * derived, since there is no natural value to match against.
 */
export type ZoomOverride =
  | { kind: "geometry"; windowId: string; rect: { x: number; y: number; width: number; height: number }; easing?: ZoomPreset }
  | { kind: "manual"; id: string; startNs: number; endNs: number; rect: { x: number; y: number; width: number; height: number }; easing: ZoomPreset };

/** Mirrors schema/project-1.schema.json and schema/project-2.schema.json. */
export interface Project {
  version: 1 | 2 | 3 | 4 | 5 | 6;
  output: { fps: 60; width: number; height: number };
  /**
   * Which transform this edit was authored against (project-3, STC-308).
   * Filled by parseProject on older documents; re-stamped with the current
   * transform on every write, because the current transform is what renders
   * it. TRANSFORM_HISTORY says what each number drew.
   */
  transform?: { version: number };
  /**
   * `default` is the macOS pointer set (cursor-art.ts); `circle` is the phase-1
   * placeholder, kept as an option. `scale` multiplies the point size of either.
   */
  cursor: { style: CursorStyle; scale: number };
  pip?: Pip;
  /**
   * The recorded app's base text size in POINTS (project-5, STC-318).
   *
   * The one input to the legibility figure that cannot be derived from the
   * recording: a web app at 14-16 CSS px and a native app at 13 pt produce
   * identical pixels, and only the person who recorded it knows which. Always
   * present after a parse, defaulted to `DEFAULT_TEXT_PT`.
   */
  textPt?: number;
  /** Absent means the full take. */
  trim?: Trim;
  /**
   * Absent on documents written before project-4. `parseProject` fills it, so
   * nothing downstream has to tell "off" from "older than zoom" — a question
   * the render does not care about.
   */
  zoom?: Zoom;
  /**
   * Manual zoom overrides (project-6, STC-330). Absent on documents written
   * before project-6; `parseProject` fills `[]`, so nothing downstream has
   * to tell "no overrides" from "older than overrides" — the same reasoning
   * `zoom` already follows.
   */
  overrides?: ZoomOverride[];
}

/**
 * Everything render() may read. `frames` is the VFR source-frame PTS grid in
 * session-relative ns — sinks derive it from display.mp4's sample table via the
 * one shared demux module; fixtures hand-author it. `cameraFrames` is the same
 * for the optional camera track (absent when there is no camera).
 */
export interface Session {
  anchors: Anchors;
  events: SessionEvent[];
  frames: number[];
  cameraFrames?: number[];
  /** the frame-difference sidecar (STC-322), absent on every take today — nothing here can run the browser decode pass that writes it. Auto-zoom stage 2 (STC-326) falls back to cursor clustering when this is absent. */
  changes?: Changes;
}

/** Cursor simulation state at a given 120 Hz tick. Positions in event space (global points). */
export interface CursorState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  pressed: boolean;
  visible: boolean;
  /** the pointer showing at this tick: the last cursor event at or before it, else the arrow */
  shape: CursorShape;
}
