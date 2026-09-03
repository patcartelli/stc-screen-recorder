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

/** Mirrors schema/anchors-1.schema.json and schema/anchors-2.schema.json. */
export interface Anchors {
  version: 1 | 2;
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
  files: { display: string; camera?: string };
  stop?: { t: number; reason: "user" | "display-reconfigured" | "device-lost" | "error" };
}

/** Mirrors `cursor.style` in schema/project-2.schema.json. */
export type CursorStyle = "default" | "circle";

/** Mirrors the optional `trim` block in schema/project-2.schema.json. */
export interface Trim {
  startNs: number;
  endNs: number;
}

/** Mirrors schema/project-1.schema.json and schema/project-2.schema.json. */
export interface Project {
  version: 1 | 2 | 3;
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
  /** Absent means the full take. */
  trim?: Trim;
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
