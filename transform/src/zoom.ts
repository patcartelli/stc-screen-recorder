import type { ButtonEvent, EasingPreset, SessionEvent } from "./types.js";
import { SIM_HZ, tickTimeNs } from "./time.js";
import type { Rect } from "./spaces.js";

/**
 * Auto-zoom stage 1 (STC-325): **when** to zoom, and nothing about where.
 *
 * The locked shape is two stages on two signals, kept apart — events decide
 * WHEN a zoom window is open, and the change track decides WHERE it points
 * (stage 2, STC-326). Keeping them apart is what makes each testable alone,
 * and it is why this file computes rectangles for nothing: it produces a list
 * of time spans, and the geometry is somebody else's job.
 *
 * ## Keystrokes are not here, and that is the ticket's own correction
 *
 * The locked decision says "clicks and keystrokes decide when", and STC-325
 * originally called the keystroke half free because "events.json already
 * carries them". It does not: `events-2` has exactly three kinds — `move`,
 * `down`/`up` and `cursor` — and the tap's mask in `Capture.swift` is
 * mouse-only. Nothing in this system has ever recorded a keypress, and adding
 * one needs a permission class the app has deliberately never required, plus
 * an `events-3` schema and a decision about recording what someone typed.
 * That is STC-327. Stage 1 ships on clicks and drags, which is what the first
 * demo is made of anyway.
 */

/**
 * A zoom window opens this long BEFORE its event.
 *
 * The move has to be underway when the thing happens, or the viewer sees the
 * click and then the camera reacting to it — which reads as a lag rather than
 * as attention. Locked at 300 ms by the ticket.
 */
export const LEAD_NS = 300_000_000;

/**
 * And holds this long after.
 *
 * Long enough to read the result of a click, which is the thing worth seeing.
 * Locked at 2500 ms.
 */
export const HOLD_NS = 2_500_000_000;

/**
 * Windows closer together than this merge into one.
 *
 * Locked at 2500 ms, and equal to `HOLD_NS` by the ticket's choice rather than
 * by derivation — they answer different questions ("how long is one worth
 * watching" and "how close is too close to pull out and back in") and could
 * legitimately differ, so they are two constants rather than one reused twice.
 * A zoom that pulls out and immediately returns is the single worst artefact
 * this feature can produce; when in doubt this number goes UP.
 */
export const MERGE_GAP_NS = 2_500_000_000;

/** A span of session time during which the frame should be zoomed. */
export interface ZoomWindow {
  /** Session-relative ns, never below 0. */
  startNs: number;
  endNs: number;
  /**
   * The events that caused this window, in time order.
   *
   * The TRIGGERING events only — the clicks — not every event inside the span.
   * Two reasons. Stage 2 needs somewhere to look when the change track is
   * uninformative, and "where the pointer was when it was clicked" is that
   * fallback, which wants the clicks and not the 800 intervening moves. And a
   * window carrying every move would be most of `events.json` copied into a
   * derived sidecar, which is a file that grows with the take for no reader.
   */
  events: ButtonEvent[];
}

/**
 * The events that open a window.
 *
 * `down` AND `up`, which is what makes "a drag is one window, not one per
 * move" true WITHOUT a special case for drags — see `zoomWindows`. Moves never
 * open one: a pointer crossing the screen is not an event worth zooming to,
 * and treating it as one is the failure mode the whole change-track amendment
 * exists to avoid.
 */
function isTrigger(e: SessionEvent): e is ButtonEvent {
  return e.kind === "down" || e.kind === "up";
}

/**
 * events → windows. The whole of stage 1's decision.
 *
 * ## Why a drag needs no special case
 *
 * Both ends of a gesture are triggers, so a drag of `down` at 0 and `up` at
 * 5 s produces [-0.3, 2.5] and [4.7, 7.5] — a 2.2 s gap, under `MERGE_GAP_NS`,
 * so they merge into one window spanning the whole drag. The ticket asks for
 * "one window, not one per move" and the merge rule delivers it; a
 * drag-detecting branch would be a second mechanism for a case the first one
 * already covers.
 *
 * A LONG drag does split — `down` at 0 and `up` at 10 s leaves a 7.2 s gap and
 * gives two windows. That is deliberate rather than a limit: a ten-second drag
 * has a beginning and an end worth seeing and a middle that is just travel.
 */
export function zoomWindows(events: readonly SessionEvent[]): ZoomWindow[] {
  const triggers = events.filter(isTrigger).slice().sort((a, b) => a.t - b.t);
  const out: ZoomWindow[] = [];
  for (const e of triggers) {
    // Clamped at 0: an event 100 ms into the take would otherwise open its
    // window before the recording exists, and a negative start is a number
    // every later consumer would have to remember to guard.
    const startNs = Math.max(0, e.t - LEAD_NS);
    const endNs = e.t + HOLD_NS;
    const last = out[out.length - 1];
    // `<=` and not `<`: a gap of exactly MERGE_GAP_NS merges. The boundary has
    // to fall one way and this is the way that errs toward fewer pull-outs.
    if (last && startNs - last.endNs <= MERGE_GAP_NS) {
      last.endNs = Math.max(last.endNs, endNs);
      last.events.push(e);
    } else {
      out.push({ startNs, endNs, events: [e] });
    }
  }
  return out;
}

/**
 * How hard the zoom moves. Three named presets, the ticket's own words.
 *
 * ## A departure, recorded rather than done quietly
 *
 * The ticket asks for these "as stiffness/damping pairs". They are single
 * stiffnesses here, because for a critically damped spring the damping is
 * DETERMINED by the stiffness (`c = 2√k` at unit mass) — offering the second
 * number as a knob would offer a control whose only non-default settings make
 * a zoom overshoot and wobble, which is the one artefact a zoom cannot afford.
 * The cursor's own spring (`OMEGA` in cursor.ts) is critically damped for the
 * same reason.
 *
 * If an eye later wants a touch of overshoot on Snappy, the dial to add is a
 * damping RATIO with 1 as its default, not a free second constant.
 *
 * **These three numbers are provisional and unseen.** The ticket says to tune
 * them on the Music Network take, which does not exist yet (STC-313). They are
 * reasoned from the cursor's 30 rad/s — a zoom moves the whole frame and so
 * must be slower than the pointer, or it reads as a lurch — and they are the
 * thing most likely to be wrong here.
 *
 * `EasingPreset` itself is in `types.ts` with the other contract types, so
 * this module can import that one and not the other way round.
 */
export const EASING_PRESETS: Readonly<Record<EasingPreset, number>> = {
  /** ~560 ms to settle. For content where the zoom should be barely noticed. */
  calm: 8,
  standard: 14,
  /** ~200 ms. Still well under the cursor's 30 — the frame is heavier than the pointer. */
  snappy: 22,
};

export const DEFAULT_EASING: EasingPreset = "standard";

/**
 * The zoom settings a document with no opinion gets.
 *
 * `enabled` is ON — see `Zoom.enabled` in types.ts for why that is safe while
 * stage 2 is stubbed, and why stage 2 must revisit it. `intensity` is 1
 * because the amount is already the spring's output in [0,1]; a default below
 * 1 would mean the presets' settle times described a motion nothing performs.
 */
export const DEFAULT_ZOOM = {
  enabled: true, intensity: 1, easing: DEFAULT_EASING,
} as const;

export function parseEasing(v: unknown): EasingPreset {
  return v === "calm" || v === "standard" || v === "snappy" ? v : DEFAULT_EASING;
}

/**
 * Same interval as the cursor's, and the same reason: 30 minutes is 216k ticks
 * and stepping from zero on every seek is quadratic.
 */
export const CHECKPOINT_INTERVAL = 1024;

const DT = 1 / SIM_HZ;

/**
 * How zoomed in the frame is at a tick: 0 is the full frame, 1 is fully in.
 *
 * A scalar rather than a rect, and that IS the stage-1/stage-2 seam. This says
 * how far along the move is; stage 2 says what it is moving toward. A stage 1
 * that produced rectangles would have had to invent a target, and inventing a
 * target is exactly the decision the change-track amendment took away from the
 * cursor.
 */
export interface ZoomSim {
  /** Amount at tick n, in [0, 1]. */
  amountAt(n: number): number;
}

/**
 * The spring, stepped at 120 Hz with semi-implicit Euler — the same
 * integrator, the same order of operations and the same checkpoint discipline
 * as `createCursorSim`.
 *
 * That sameness is load-bearing rather than tidy. `stateAt(n)` must be
 * identical whether reached by stepping or seeking, bit for bit, because
 * preview and export are two sinks walking different `t` sequences over one
 * trajectory. A checkpoint IS the stepped state, so resuming from it replays
 * the exact float sequence a continuous run would have produced.
 */
export function createZoomSim(windows: readonly ZoomWindow[],
                              easing: EasingPreset = DEFAULT_EASING): ZoomSim {
  const omega = EASING_PRESETS[easing];
  // Sorted and non-overlapping by construction (`zoomWindows` merges), so the
  // target at a tick is a binary search rather than a scan. Kept as plain
  // arrays for the same reason cursor.ts does: an object per tick is garbage
  // the sim does not need.
  const starts = windows.map((w) => w.startNs);
  const ends = windows.map((w) => w.endNs);

  /** 1 while a window is open at the tick's START time, else 0. */
  function targetAt(n: number): number {
    const t = tickTimeNs(n);
    // Rightmost window whose start is <= t.
    let lo = 0, hi = starts.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid]! <= t) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return found >= 0 && t < ends[found]! ? 1 : 0;
  }

  interface State { amount: number; velocity: number }
  const tick0: State = { amount: targetAt(0), velocity: 0 };
  const checkpoints: State[] = [{ ...tick0 }];

  /** Advance from tick n-1 to tick n; target sampled at tick n's start time. */
  function step(s: State, n: number): State {
    const target = targetAt(n);
    // Critically damped: a = -2ω·v - ω²·(x - target). Semi-implicit — velocity
    // first, then position from the NEW velocity — because that is what
    // cursor.ts does, and two integrators that disagree by an operation order
    // would make the pointer and the frame drift apart over a long take.
    const accel = -2 * omega * s.velocity - omega * omega * (s.amount - target);
    const velocity = s.velocity + accel * DT;
    const amount = s.amount + velocity * DT;
    return { amount, velocity };
  }

  return {
    amountAt(n: number): number {
      if (n <= 0) return clamp01(tick0.amount);
      const k = Math.min(Math.floor(n / CHECKPOINT_INTERVAL), checkpoints.length - 1);
      let cur = checkpoints[k]!;
      // Increment BEFORE stepping, exactly as `cursor.ts` does. The first
      // draft stepped then incremented, which stored state(tick+1) under
      // checkpoint index tick and sampled the target a tick early — seek and
      // step then disagreed in the last digits, which the determinism test
      // caught. "The same order of operations" was a claim in the comment
      // before it was true of the code.
      let tick = k * CHECKPOINT_INTERVAL;
      while (tick < n) {
        tick++;
        cur = step(cur, tick);
        if (tick % CHECKPOINT_INTERVAL === 0 && tick / CHECKPOINT_INTERVAL === checkpoints.length) {
          checkpoints.push(cur);
        }
      }
      return clamp01(cur.amount);
    },
  };
}

/**
 * Clamped at the READ, never in the state.
 *
 * A critically damped spring does not overshoot, so this should never bind —
 * but clamping the stored value would change the trajectory (a clamped
 * position feeds the next step's error term), which is exactly the kind of
 * quiet difference that makes seek and step disagree. Clamp what is handed
 * out; leave the simulation alone.
 */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * The crop the frame should show, given how far in the zoom is and where it is
 * pointing.
 *
 * **`target` is stage 2's answer and is stubbed to the full frame for now**
 * (STC-326). With a full-frame target this function is the identity at every
 * amount, which is precisely what makes `gate:identity` meaningful as stage
 * 1's acceptance: the whole derivation runs — windows, spring, per-tick
 * amount, crop — and must still produce byte-identical pixels, so anything
 * that reaches the frame by accident shows up as a failure rather than as a
 * picture nobody compared.
 *
 * UV over the capture, because that is the space STC-314 named for exactly
 * this: a crop that moves with the picture rather than with the canvas.
 */
export const FULL_FRAME: Rect = { x: 0, y: 0, width: 1, height: 1 };

export function zoomCrop(amount: number, target: Rect = FULL_FRAME): Rect {
  const a = clamp01(amount);
  // Linear interpolation from the full frame toward the target. Linear in the
  // CROP and not in a "zoom factor": the spring already shapes the motion, and
  // a second easing curve on top of it would make the preset numbers describe
  // something other than what they say.
  return {
    x: FULL_FRAME.x + (target.x - FULL_FRAME.x) * a,
    y: FULL_FRAME.y + (target.y - FULL_FRAME.y) * a,
    width: FULL_FRAME.width + (target.width - FULL_FRAME.width) * a,
    height: FULL_FRAME.height + (target.height - FULL_FRAME.height) * a,
  };
}
