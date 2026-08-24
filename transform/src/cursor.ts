import type { CursorState, SessionEvent } from "./types.js";
import { SIM_HZ, tickTimeNs } from "./time.js";

/**
 * Cursor easing: a critically damped spring toward the latest raw cursor
 * position, stepped at 120 Hz with semi-implicit Euler. State is a function of
 * sim tick n only — no wall clock, no render-call count. Every query walks the
 * one canonical trajectory from tick 0; checkpoints make seeks affordable
 * (30 min = 216k ticks) without changing a single arithmetic operation:
 * a checkpoint IS the stepped state, so resuming from it replays the exact
 * float sequence the continuous run would have produced.
 */

const DT = 1 / SIM_HZ;
/** Spring stiffness, rad/s. ~150 ms settle. Phase-1 feel constant, tune here only. */
const OMEGA = 30;
export const CHECKPOINT_INTERVAL = 1024;

export interface CursorSim {
  stateAt(n: number): CursorState;
}

export function createCursorSim(events: readonly SessionEvent[]): CursorSim {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const times = sorted.map((e) => e.t);

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

  if (sorted.length === 0) {
    const hidden: CursorState = { x: 0, y: 0, vx: 0, vy: 0, pressed: false, visible: false };
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
      return { ...kin, pressed: pressedAt(tickTimeNs(n)), visible: true };
    },
  };
}
