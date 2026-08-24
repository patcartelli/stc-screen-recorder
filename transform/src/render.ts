import type { CursorState, Project, Session } from "./types.js";
import { frameIndexAt, tickOf } from "./time.js";
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
  /** cursor in output pixel coordinates */
  cursor: CursorState & { scale: number };
}

const simCache = new WeakMap<Session, CursorSim>();

export function render(project: Project, session: Session, tNs: number): FrameState {
  let sim = simCache.get(session);
  if (!sim) {
    sim = createCursorSim(session.events);
    simCache.set(session, sim);
  }

  const tick = tickOf(tNs);
  const frameIndex = frameIndexAt(session.frames, tNs);
  const s = sim.stateAt(tick);

  // global points → display-local points → output pixels
  const { display } = session.anchors;
  const sx = project.output.width / display.pointWidth;
  const sy = project.output.height / display.pointHeight;

  return {
    tick,
    frameIndex,
    framePtsNs: frameIndex === null ? null : session.frames[frameIndex]!,
    cursor: {
      x: (s.x - display.originX) * sx,
      y: (s.y - display.originY) * sy,
      vx: s.vx * sx,
      vy: s.vy * sy,
      pressed: s.pressed,
      visible: s.visible,
      scale: project.cursor.scale,
    },
  };
}
