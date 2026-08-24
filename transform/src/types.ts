/** Mirrors schema/events-1.schema.json. All times are session-relative integer ns. */
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
export type SessionEvent = MoveEvent | ButtonEvent;

/** Mirrors schema/anchors-1.schema.json. */
export interface Anchors {
  version: 1;
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
  files: { display: string };
  stop?: { t: number; reason: "user" | "display-reconfigured" | "device-lost" | "error" };
}

/** Mirrors schema/project-1.schema.json. */
export interface Project {
  version: 1;
  output: { fps: 60; width: number; height: number };
  cursor: { style: "default"; scale: number };
}

/**
 * Everything render() may read. `frames` is the VFR source-frame PTS grid in
 * session-relative ns — sinks derive it from display.mp4's sample table via the
 * one shared demux module; fixtures hand-author it.
 */
export interface Session {
  anchors: Anchors;
  events: SessionEvent[];
  frames: number[];
}

/** Cursor simulation state at a given 120 Hz tick. Positions in event space (global points). */
export interface CursorState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  pressed: boolean;
  visible: boolean;
}
