import type { CursorShape, CursorState, SessionEvent } from "./types.js";
import { SIM_HZ, tickTimeNs } from "./time.js";
import { DEFAULT_CURSOR_SHAPE } from "./cursor-art.js";

/**
 * Cursor easing: a critically damped spring toward the latest raw cursor
 * position, stepped at 120 Hz with semi-implicit Euler. State is a function of
 * sim tick n only — no wall clock, no render-call count. Every query walks the
 * one canonical trajectory from tick 0; checkpoints make seeks affordable
 * (30 min = 216k ticks) without changing a single arithmetic operation:
 * a checkpoint IS the stepped state, so resuming from it replays the exact
 * float sequence the continuous run would have produced.
 *
 * The pointer's SHAPE is not simulated: it is a step function of the cursor
 * events (events-2), read at the tick's start time like `pressed`. Before the
 * first cursor event — and for the whole of a v1 take, which has none — it is
 * the arrow.
 */

const DT = 1 / SIM_HZ;
/**
 * Spring stiffness, rad/s. ~150 ms settle. Phase-1 feel constant, tune here
 * only — and bump TRANSFORM_VERSION when you do (transform-version.ts): it
 * decides every cursor pixel in every export.
 */
export const OMEGA = 30;
export const CHECKPOINT_INTERVAL = 1024;

export interface CursorSim {
  stateAt(n: number): CursorState;
}

export function createCursorSim(events: readonly SessionEvent[]): CursorSim {
  const all = [...events].sort((a, b) => a.t - b.t);
  // Only move/down/up carry a position; a cursor event says which pointer is
  // showing and must not become a spring target.
  const sorted = all.filter((e) => e.kind !== "cursor");
  const times = sorted.map((e) => e.t);

  const shapeTimes: number[] = [];
  const shapeVals: CursorShape[] = [];
  for (const e of all) {
    if (e.kind === "cursor") {
      shapeTimes.push(e.t);
      shapeVals.push(e.shape);
    }
  }

  // pressed = any button down at t: prefix sum over down(+1)/up(-1) events
  const btnTimes: number[] = [];
  const btnDepth: number[] = [];
  let depth = 0;
  for (const e of sorted) {
    if (e.kind === "down" || e.kind === "up") {
      depth += e.kind === "down" ? 1 : -1;
      btnTimes.push(e.t);
      btnDepth.push(depth);
    }
  }

  /** index of last element <= t in a sorted array, or -1 */
  function lastLE(arr: readonly number[], t: number): number {
    let lo = 0, hi = arr.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid]! <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  function targetAt(tNs: number): { x: number; y: number } {
    const i = lastLE(times, tNs);
    const e = sorted[i < 0 ? 0 : i]!; // before the first event, pre-warm at its position
    return { x: e.x, y: e.y };
  }

  function pressedAt(tNs: number): boolean {
    const i = lastLE(btnTimes, tNs);
    return i >= 0 && btnDepth[i]! > 0;
  }

  function shapeAt(tNs: number): CursorShape {
    const i = lastLE(shapeTimes, tNs);
    return i < 0 ? DEFAULT_CURSOR_SHAPE : shapeVals[i]!;
  }

  if (sorted.length === 0) {
    const hidden: CursorState = {
      x: 0, y: 0, vx: 0, vy: 0, pressed: false, visible: false, shape: DEFAULT_CURSOR_SHAPE,
    };
    return { stateAt: () => ({ ...hidden }) };
  }

  interface Kinematics { x: number; y: number; vx: number; vy: number }
  const first = targetAt(0);
  const tick0: Kinematics = { x: first.x, y: first.y, vx: 0, vy: 0 };
  // checkpoints[k] = kinematic state at tick k*CHECKPOINT_INTERVAL, filled as first reached
  const checkpoints: Kinematics[] = [tick0];

  function step(s: Kinematics, n: number): Kinematics {
    // advance from tick n-1 to tick n; target sampled at tick n's start time
    const tgt = targetAt(tickTimeNs(n));
    const ax = OMEGA * OMEGA * (tgt.x - s.x) - 2 * OMEGA * s.vx;
    const ay = OMEGA * OMEGA * (tgt.y - s.y) - 2 * OMEGA * s.vy;
    const vx = s.vx + ax * DT;
    const vy = s.vy + ay * DT;
    return { x: s.x + vx * DT, y: s.y + vy * DT, vx, vy };
  }

  function kinematicsAt(n: number): Kinematics {
    const k = Math.min(Math.floor(n / CHECKPOINT_INTERVAL), checkpoints.length - 1);
    let cur = checkpoints[k]!;
    let tick = k * CHECKPOINT_INTERVAL;
    while (tick < n) {
      tick++;
      cur = step(cur, tick);
      if (tick % CHECKPOINT_INTERVAL === 0 && tick / CHECKPOINT_INTERVAL === checkpoints.length) {
        checkpoints.push(cur);
      }
    }
    return cur;
  }

  return {
    stateAt(n: number): CursorState {
      const kin = kinematicsAt(n);
      const tNs = tickTimeNs(n);
      return { ...kin, pressed: pressedAt(tNs), visible: true, shape: shapeAt(tNs) };
    },
  };
}
