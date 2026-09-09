import type { CursorState, CursorStyle, Project, Session } from "./types.js";
import { frameIndexAt, tickOf } from "./time.js";
import {
  displayToOutput, fixedCornerPipUv, mapPoint, mapVector, outputRect, roundRect,
  uvRectToPixels, type Rect,
} from "./spaces.js";
import { createZoomSim, zoomWindows, type ZoomSim } from "./zoom.js";
import { createCursorSim, type CursorSim } from "./cursor.js";

/**
 * THE non-negotiable: render(project, session, t) → FrameState is a pure
 * function — no wall clock, no decoder scheduling, no live helper stats, no
 * current display state. Preview and export are two sinks that call this with
 * different t sequences; sinks may not fork it.
 *
 * The per-session sim cache below is a pure memo: every cursor state lives on
 * the one canonical trajectory from tick 0, so cached and fresh answers are
 * bit-identical (cursor.test.ts proves it).
 */

export interface FrameState {
  /** 120 Hz sim tick this t falls in */
  tick: number;
  /** index into session.frames of the source frame to show, or null before the first frame */
  frameIndex: number | null;
  /** that frame's session-relative PTS ns, or null */
  framePtsNs: number | null;
  /**
   * cursor in output pixel coordinates. `pxPerPoint` is how many output pixels
   * one cursor point covers: the display-to-output ratio times the project's
   * cursor scale, so the pointer keeps its on-screen size relative to the
   * content at any export size. `style` picks the artwork set or the circle.
   */
  cursor: CursorState & { pxPerPoint: number; style: CursorStyle };
  /** camera picture-in-picture, or null when there is none to draw */
  pip: PipState | null;
  /** auto-zoom (STC-325). Always present; `crop` is the whole frame while stage 2 is stubbed */
  zoom: ZoomState;
}

/**
 * Where the zoom is, at this instant.
 *
 * `amount` is stage 1's eased 0..1 — how far into the zoom we are. `crop` is
 * stage 2's answer to *where*, as a UV rect over the CAPTURE: the same space
 * a redaction lives in (spaces.ts), so it moves with the picture rather than
 * with the canvas and needs no units of its own.
 *
 * **Stage 2 is not built, and `crop` is the whole frame at every amount.** So
 * the zoom currently changes no pixels, and that is the point of shipping it
 * this way: the machinery is in the render path and gated, and the only thing
 * left for STC-326 to add is a rectangle. Wiring it later would mean landing
 * the plumbing and the geometry in one change, with no run in between where
 * the plumbing alone is known good.
 */
export interface ZoomState {
  amount: number;
  crop: Rect;
}

/** The whole capture, in UV. What `crop` is until STC-326 decides otherwise. */
export const FULL_FRAME_UV: Rect = { x: 0, y: 0, width: 1, height: 1 };

export interface PipState {
  frameIndex: number;
  framePtsNs: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The PiP is drawn only while the camera track actually exists.
 *
 * "Greatest PTS <= t, hold" is right for gaps inside a track and wrong at its
 * end: a camera lost mid-take would otherwise hold its last frame for the rest
 * of the recording, leaving a frozen face on screen. Both bounds come from
 * anchors.camera, never from an assumed frame rate — the measured camera rate
 * varies run to run.
 */
function pipStateAt(project: Project, session: Session, tNs: number): PipState | null {
  const pip = project.pip;
  const cam = session.anchors.camera;
  const frames = session.cameraFrames;
  if (!pip?.enabled || !cam?.present || !frames?.length) return null;

  if (tNs < cam.firstFramePtsNs) return null;
  if (tNs > cam.lastFramePtsNs + cam.frameIntervalNs) return null;

  const frameIndex = frameIndexAt(frames, tNs);
  if (frameIndex === null) return null;

  // A crop in UV over the output, not a corner in output pixels (STC-314):
  // the camera lives in the same space as a zoom crop, so whatever comes to
  // move a zoom can move the camera without a second answer to "where does
  // the PiP go". Rounded because this rectangle places a DECODED FRAME, and a
  // frame at a half-pixel offset is a frame resampled across every edge.
  const rect = roundRect(uvRectToPixels(
    fixedCornerPipUv(pip, project.output, cam),
    outputRect(project.output),
  ));
  return { frameIndex, framePtsNs: frames[frameIndex]!, ...rect };
}

const simCache = new WeakMap<Session, CursorSim>();

/**
 * The zoom sim, memoised per session exactly as the cursor's is, and for the
 * same reason: both replay one canonical trajectory from tick 0, so a cached
 * answer and a fresh one are bit-identical.
 *
 * Keyed on the session alone, which is correct only while the easing preset is
 * a constant. When a project can choose one, this key has to include it — a
 * cache that ignores an input is how two takes come to share one answer.
 */
const zoomCache = new WeakMap<Session, ZoomSim>();

export function render(project: Project, session: Session, tNs: number): FrameState {
  let sim = simCache.get(session);
  if (!sim) {
    sim = createCursorSim(session.events);
    simCache.set(session, sim);
  }

  let zoomSim = zoomCache.get(session);
  if (!zoomSim) {
    zoomSim = createZoomSim(zoomWindows(session.events));
    zoomCache.set(session, zoomSim);
  }

  const tick = tickOf(tNs);
  const frameIndex = frameIndexAt(session.frames, tNs);
  const s = sim.stateAt(tick);

  // global points → display-local points → output pixels. spaces.ts owns the
  // rule; this stays the only event-space conversion in the transform.
  const m = displayToOutput(session.anchors.display, project.output);
  const at = mapPoint(m, s);
  // A velocity is a DIFFERENCE of global points, so it scales without
  // translating — hence the second call rather than a flag.
  const vel = mapVector(m, { x: s.vx, y: s.vy });

  return {
    tick,
    frameIndex,
    framePtsNs: frameIndex === null ? null : session.frames[frameIndex]!,
    cursor: {
      x: at.x,
      y: at.y,
      vx: vel.x,
      vy: vel.y,
      pressed: s.pressed,
      visible: s.visible,
      shape: s.shape,
      style: project.cursor.style,
      pxPerPoint: project.cursor.scale * m.sx,
    },
    pip: pipStateAt(project, session, tNs),
    // Stage 2 stubbed: the amount is real and eased, the crop is the whole
    // frame, so this is a no-op on the pixels by construction.
    zoom: { amount: zoomSim.amountAt(tick), crop: FULL_FRAME_UV },
  };
}
