import type { CursorState, CursorStyle, Project, Session } from "./types.js";
import { frameIndexAt, tickOf } from "./time.js";
import {
  displayToOutput, fixedCornerPipUv, mapPoint, mapVector, outputRect, roundRect,
  uvRectToPixels,
} from "./spaces.js";
import { createCursorSim, type CursorSim } from "./cursor.js";
import {
  DEFAULT_ZOOM, FULL_FRAME, createZoomSim, zoomCrop, zoomWindows, type ZoomSim,
} from "./zoom.js";

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
  /**
   * Which part of the capture to show, as a UV rect over it (STC-325).
   *
   * Always present, and `FULL_FRAME` when zoom is off — a null would make
   * every sink write the same "or the whole thing" fallback, which is three
   * copies of one rule and the shape of a defect this repo has fixed four
   * times. While stage 2 is stubbed this is the full frame at every amount by
   * construction, which is what makes `gate:identity` stage 1's acceptance:
   * the whole derivation runs and the pixels must not move.
   */
  zoom: ZoomState;
}

export interface ZoomState {
  /** 0 is the full frame, 1 is fully in. The spring's output, times intensity. */
  amount: number;
  /** UV over the capture. `FULL_FRAME` until stage 2 supplies a target. */
  crop: { x: number; y: number; width: number; height: number };
}

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
/** One sim per (session, easing preset) — see the note at the call site. */
const zoomCache = new WeakMap<Session, Map<string, ZoomSim>>();

export function render(project: Project, session: Session, tNs: number): FrameState {
  let sim = simCache.get(session);
  if (!sim) {
    sim = createCursorSim(session.events);
    simCache.set(session, sim);
  }
  // Memoised per (session, easing) for the same reason as the cursor's: every
  // amount lives on the one canonical trajectory from tick 0, so a cached and
  // a fresh sim are bit-identical. Keyed on the easing too, because changing
  // the preset changes the trajectory and a stale sim would answer for the
  // old one.
  const zoomCfg = project.zoom ?? DEFAULT_ZOOM;
  const zoomKey = `${zoomCfg.easing}`;
  let zsims = zoomCache.get(session);
  if (!zsims) { zsims = new Map(); zoomCache.set(session, zsims); }
  let zsim = zsims.get(zoomKey);
  if (!zsim) {
    zsim = createZoomSim(zoomWindows(session.events), zoomCfg.easing);
    zsims.set(zoomKey, zsim);
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
    zoom: zoomStateAt(zoomCfg, zsim, tick),
  };
}

/**
 * Off means the full frame and an amount of zero — not a skipped spring.
 *
 * Reading the sim only when enabled would make "off" and "on with intensity 0"
 * two different code paths for one visible result, and the cheaper of them is
 * the one that never gets exercised.
 */
function zoomStateAt(cfg: { enabled: boolean; intensity: number },
                     sim: ZoomSim, tick: number): ZoomState {
  if (!cfg.enabled) return { amount: 0, crop: FULL_FRAME };
  const amount = sim.amountAt(tick) * cfg.intensity;
  // The target is stage 2's (STC-326). Until then it is the full frame, so
  // this is the identity at every amount.
  return { amount, crop: zoomCrop(amount, FULL_FRAME) };
}
