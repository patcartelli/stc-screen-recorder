import type { SessionEvent } from "./types.js";
import { SIM_HZ, tickTimeNs } from "./time.js";

/**
 * Auto-zoom stage 1: WHEN to zoom (STC-325). Nothing here decides where.
 *
 * The signal, as locked: an event opens a window 300 ms BEFORE it and holds
 * 2500 ms after; windows closer than 2500 ms merge. Splitting when from where
 * is the locked shape and the reason each half is testable alone — this module
 * produces intervals over the timeline and never touches geometry, so it needs
 * no display, no crop and no coordinate space.
 *
 * ## What counts as an event
 *
 * Clicks (`down`/`up`) and any `move` that happens WHILE A BUTTON IS HELD —
 * which is to say a drag. A plain move triggers nothing.
 *
 * That distinction is the whole feature. `leftMouseDragged` is recorded as
 * `kind: "move"` (helper/src/CaptureDecisions.swift:107), so a drag is a
 * `down`, a few hundred `move`s and an `up`, and it is indistinguishable from
 * ordinary pointer motion except by whether a button is down. Triggering on
 * every move would zoom continuously through a take that is mostly mouse
 * motion — which is exactly what STC-313's Music Network demo is, and its
 * ticket says the feature is wrong, not the demo, if that happens.
 *
 * It also makes the ticket's "a drag is ONE window, not one per move" fall out
 * of the locked rule rather than needing a special case: the drag's moves are
 * a dense run of trigger events, every one of their windows overlaps its
 * neighbour, and merging collapses the lot into a single window spanning the
 * drag however long it lasts. A rule that needed an exception for drags would
 * be a rule with a seam in it.
 *
 * ## The long-drag case is OPEN, and STC-313's take settles it
 *
 * A ten-second drag is ONE window here. The alternative is defensible and was
 * built: PR #111 implemented this ticket independently, counted only
 * `down`/`up` as triggers, and got TWO windows for that drag — the merge rule
 * covers a short drag (both ends inside the gap) and lets a long one split, on
 * the argument that a long drag has a beginning and an end worth seeing and a
 * middle that is just travel.
 *
 * Neither rule can be chosen from a machine with no take to watch. What is
 * kept is the one that makes "a drag is ONE window, however long" fall out of
 * the locked rule with no case analysis, and whose failure mode is a zoom that
 * stays in too long rather than one that pulls out mid-gesture. If the Music
 * Network take reads the other way, the change is to drop the `move` arm of
 * `isTrigger` — one line, and the reasoning above is the argument for it.
 *
 * A smaller difference falls out of the same choice and is also unsettled: a
 * drag's window carries every held move in `events`, where #111's carried only
 * the two buttons. Nothing reads that field yet. STC-326 will, and it should
 * say which it wants rather than inheriting this one.
 *
 * ## Keystrokes are NOT here, and the ticket said they were
 *
 * STC-325 said keystrokes count and that `events.json` already carries them.
 * It does not: `events-2` has three kinds — move, down/up, cursor — and the
 * event tap's mask is mouse-only. Recording a keypress needs a permission
 * class this app has deliberately never asked for, an events-3 schema, and a
 * decision about storing what someone typed. That is STC-327; stage 1 ships on
 * clicks and drags, which is what the take it is judged on is made of.
 */

const MS = 1_000_000;

/**
 * How long before a trigger the window opens. The zoom has to be arriving as
 * the click lands, not starting then — 300 ms is about a spring's approach at
 * the Standard preset, so the motion reads as anticipation rather than
 * reaction.
 */
export const ZOOM_LEAD_NS = 300 * MS;

/** How long a window holds after its last trigger. */
export const ZOOM_HOLD_NS = 2500 * MS;

/**
 * Two windows this close or closer become one.
 *
 * Equal to the hold on purpose rather than by coincidence: the hold says how
 * long one event stays interesting, so two events that near are one piece of
 * activity. Pulling out and back in between them would be the worst-looking
 * thing this feature can do.
 */
export const ZOOM_MERGE_GAP_NS = 2500 * MS;

/** A stretch of the timeline the zoom is asked to be in. No geometry (STC-326 decides where). */
export interface ZoomWindow {
  startNs: number;
  endNs: number;
  /** the triggers this window was built from, in time order */
  events: SessionEvent[];
}

/**
 * True while a button is held — a prefix sum over down(+1)/up(-1), the same
 * shape `cursor.ts` uses for `pressed`, and for the same reason: a take can
 * legitimately start mid-drag or end mid-drag, so the depth is clamped at zero
 * rather than trusted to balance.
 */
function isTrigger(e: SessionEvent, depthBefore: number): boolean {
  if (e.kind === "down" || e.kind === "up") return true;
  if (e.kind === "move") return depthBefore > 0;
  return false;   // a cursor-shape event is not activity
}

/**
 * The windows a take's events ask for, in time order, non-overlapping.
 *
 * Pure and total: any event list produces a window list, and the same list
 * always produces the same one. An empty result is a real answer — a take of
 * nothing but pointer motion asks for no zoom at all.
 */
export function zoomWindows(events: readonly SessionEvent[]): ZoomWindow[] {
  const sorted = [...events].sort((a, b) => a.t - b.t);

  const triggers: SessionEvent[] = [];
  let depth = 0;
  for (const e of sorted) {
    if (isTrigger(e, depth)) triggers.push(e);
    if (e.kind === "down") depth++;
    else if (e.kind === "up") depth = Math.max(0, depth - 1);
  }
  if (triggers.length === 0) return [];

  const out: ZoomWindow[] = [];
  for (const e of triggers) {
    // Clamped at zero: a click in the first 300 ms of a take cannot open a
    // window before the take began, and a negative start would be a time
    // render() is never asked for.
    const startNs = Math.max(0, e.t - ZOOM_LEAD_NS);
    const endNs = e.t + ZOOM_HOLD_NS;
    const last = out[out.length - 1];
    if (last && startNs - last.endNs <= ZOOM_MERGE_GAP_NS) {
      last.endNs = Math.max(last.endNs, endNs);
      last.events.push(e);
    } else {
      out.push({ startNs, endNs, events: [e] });
    }
  }
  return out;
}

/** Is tNs inside any window? Windows are sorted and disjoint, so this is a scan-free bisect. */
export function inWindow(windows: readonly ZoomWindow[], tNs: number): boolean {
  let lo = 0, hi = windows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = windows[mid]!;
    if (tNs < w.startNs) hi = mid - 1;
    else if (tNs > w.endNs) lo = mid + 1;
    else return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Easing — the window edges drive a spring
// ---------------------------------------------------------------------------

const DT = 1 / SIM_HZ;

/**
 * The checkpoint interval, matching `cursor.ts`'s.
 *
 * Same discipline for the same reason: a checkpoint IS the stepped state, so
 * resuming from one replays the exact float sequence a continuous run would
 * have produced, and seeking to tick n gives the same answer as stepping to
 * it. At 120 Hz a 30-minute take is 216k ticks, and stepping from zero on
 * every query is the quadratic export this project already designed away once.
 */
export const ZOOM_CHECKPOINT_INTERVAL = 1024;

/**
 * A named easing, as a stiffness/damping pair.
 *
 * `omega` is stiffness in rad/s; `zeta` is the damping ratio, where 1 is
 * critically damped — the cursor's spring is the zeta = 1 case of this one,
 * written out (`cursor.ts` folds it into a `2 * OMEGA` term). Anything under 1
 * overshoots, and a zoom that overshoots reads as a bounce, so every preset
 * here is exactly 1 and the field exists to make that a stated choice rather
 * than an assumption baked into the arithmetic.
 *
 * **The three numbers are reasoned, not seen.** Settling time for a critically
 * damped spring is about 4.7 / omega, so these are roughly 780 ms, 470 ms and
 * 260 ms. They were chosen on a machine with no screen and are the one thing
 * in this file expected to change once someone has watched a real take —
 * STC-325 says to tune them on the Music Network take, which should barely
 * zoom, and on a form fixture, which should. Treat them the way STC-291's
 * presets are treated: real parameters, provisional values.
 */
export interface ZoomEasing { omega: number; zeta: number }

export const ZOOM_PRESETS = {
  calm: { omega: 6, zeta: 1 },
  standard: { omega: 10, zeta: 1 },
  snappy: { omega: 18, zeta: 1 },
} as const satisfies Record<string, ZoomEasing>;

export type ZoomPreset = keyof typeof ZOOM_PRESETS;
export const ZOOM_PRESET_NAMES = Object.keys(ZOOM_PRESETS) as ZoomPreset[];
export const DEFAULT_ZOOM_PRESET: ZoomPreset = "standard";

export interface ZoomSim {
  /** How far into the zoom we are at sim tick n: 0 is fully out, 1 fully in. */
  amountAt(n: number): number;
}

/**
 * The zoom amount as a function of sim tick, and of nothing else.
 *
 * A scalar rather than a rectangle, deliberately: stage 2 decides where, and
 * handing it an eased 0..1 means the two halves compose without either knowing
 * the other's units. The target is a step function — 1 inside a window, 0
 * outside — and the spring is the entire reason that step is watchable.
 *
 * The amount is NOT clamped to [0, 1]. At zeta = 1 it cannot overshoot, so a
 * clamp would never fire and would hide it if a future preset did; a caller
 * that needs a bounded value should say so at the point it needs one.
 */
export function createZoomSim(
  windows: readonly ZoomWindow[],
  easing: ZoomEasing = ZOOM_PRESETS[DEFAULT_ZOOM_PRESET],
): ZoomSim {
  if (windows.length === 0) return { amountAt: () => 0 };

  interface State { z: number; v: number }
  const checkpoints: State[] = [{ z: 0, v: 0 }];

  function step(s: State, n: number): State {
    const target = inWindow(windows, tickTimeNs(n)) ? 1 : 0;
    const a = easing.omega * easing.omega * (target - s.z)
            - 2 * easing.zeta * easing.omega * s.v;
    const v = s.v + a * DT;
    return { z: s.z + v * DT, v };
  }

  function stateAt(n: number): State {
    const k = Math.min(Math.floor(n / ZOOM_CHECKPOINT_INTERVAL), checkpoints.length - 1);
    let cur = checkpoints[k]!;
    let tick = k * ZOOM_CHECKPOINT_INTERVAL;
    while (tick < n) {
      tick++;
      cur = step(cur, tick);
      if (tick % ZOOM_CHECKPOINT_INTERVAL === 0
          && tick / ZOOM_CHECKPOINT_INTERVAL === checkpoints.length) {
        checkpoints.push(cur);
      }
    }
    return cur;
  }

  return { amountAt: (n: number) => stateAt(Math.max(0, n)).z };
}
