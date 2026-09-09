/**
 * The scrubber's decisions (STC-338) — no DOM, no Electron, no player.
 *
 * Same arrangement `selection.ts` has for the overlay and `thumbnail.ts` for
 * the panel: everything that DECIDES — which frame a pointer is over, what a
 * key means, how far a trim handle may be dragged, when a tick is worth
 * drawing, what the clock reads — lives here and is exercised by
 * `app/test/scrubber.test.ts` without a screen. `renderer.ts` moves the
 * elements; it does not repeat the reasoning.
 *
 * This is the first interaction study (STC-338). The list below is the point
 * of it: the editor is meant to INHERIT this vocabulary rather than invent a
 * second one, so every later timeline control is held to these rules.
 *
 * ════════════════════════════════════════════════════════════════════════
 * THE RULES
 * ════════════════════════════════════════════════════════════════════════
 *
 * **1. Position is a FRAME, never a time.** The scrubber's state is an
 * integer export-frame index. Nanoseconds are derived from it on the way out
 * (`exportFrameTimeNs`), never stored. A control whose value is a time can
 * hold a position between two frames; one whose value is a frame cannot, so
 * "the playhead is always on the grid" is true by construction rather than by
 * rounding afterwards. The `<input type=range>` carries `step=1` over frame
 * indices for the same reason — the snap is the control's own arithmetic.
 *
 * **2. There is ONE frame grid and this module does not own it.** `time.ts`
 * does: `exportFrameOf` maps a time to its frame, `exportFrameTimeNs` maps
 * back, and they are an inverse pair. A still grabbed off the playhead is
 * pixel-identical to the video's frame at the same timestamp precisely
 * because both snap here. A second implementation of `floor(t * fps / 1e9)`
 * anywhere is how a preview and an export come to disagree about an instant.
 *
 * **3. A drag is DIRECT, and a release only settles.** While dragging, the
 * playhead is wherever the pointer is, snapped to the nearest frame, with no
 * smoothing and no lag — a preview that eases toward the pointer is lying
 * about which frame you are on. On release there is no momentum, no inertia
 * and no glide: the playhead stays on the frame it was already on. "Settle"
 * means the trim handles' rubber band relaxing (rule 5), never the playhead
 * travelling further than the pointer took it.
 *
 * **4. The playhead is FREE; the trim is drawn, not fenced.** Scrubbing and
 * nudging move over the whole take, and the material outside in/out is drawn
 * dimmed rather than made unreachable. You must be able to look at what you
 * cut in order to know the cut was right. The clamps in rule 5 constrain the
 * HANDLES, never the playhead.
 *
 * **5. A clamp is felt as resistance, not as a silent stop.** Dragged past
 * its limit a trim handle keeps moving, but at a decaying rate that
 * asymptotes to `RUBBER_BAND_PX` — so the pointer pulls away from the handle
 * and the limit is something you feel arrive. On release the handle settles
 * exactly onto the clamp. A handle that simply stopped dead would be
 * indistinguishable from one that had lost the pointer.
 *
 * **6. The minimum trim is TWO frames, and that is arithmetic rather than
 * taste.** `minTrimNs(60)` is 16666667 ns while the frame grid steps 16666666
 * and 16666667 alternately, so a one-frame trim is not always expressible on
 * the grid: measured over 200000 frame positions, `clampTrim` pushes a
 * one-frame trim OFF the grid at 66666 of them (a third, first at frame 2)
 * and a two-frame trim at none. A trim whose ends are not on the grid
 * disagrees with `exportWindow`'s frame arithmetic about where the clip
 * starts. `scrubber.test.ts` re-derives this against the real `clampTrim`, so
 * the number moves if the grid does.
 *
 * **7. Shuttle is one signed ladder, not two.** J and L step the SAME rate
 * one place along `SHUTTLE_LADDER` — L toward the forward end, J toward the
 * reverse end — so decelerating and reversing are the same gesture and zero
 * is a rung rather than a special case. K jumps to zero from anywhere. This
 * is what makes "J while playing forward slows down" fall out instead of
 * needing a rule of its own.
 *
 * **8. A bare letter belongs to the timeline only when nothing is being
 * typed.** I, O, J, K and L are single keys with no modifier, so a focused
 * text field owns them and `decideKey` returns null. The same call also
 * refuses anything carrying a modifier, which is what keeps ⌘⇧C (copy frame)
 * and the global capture shortcuts working over an open preview.
 *
 * **9. A tick is drawn only when it can be seen.** At 60 fps a minute-long
 * take has 3600 frames over a few hundred pixels, so per-frame ticks are
 * sub-pixel hatching that reads as noise. `tickStrideFrames` picks the
 * finest stride from a fixed ladder that still leaves `MIN_TICK_PX` between
 * ticks, and returns null when even the coarsest cannot — drawing nothing is
 * the honest answer at that density.
 *
 * **10. The readout is frame-accurate or it is decorative.** `M:SS:FF` at
 * every position the canvas draws. Seconds alone cannot tell two adjacent
 * frames apart, which is exactly the distinction a nudge exists to make.
 */

import { EXPORT_FPS, exportFrameOf, exportFrameTimeNs } from "@transform/time.js";

/**
 * The shuttle rates, in order, as ONE signed ladder (rule 7). J steps toward
 * the head, L toward the tail; zero is the middle rung.
 */
export const SHUTTLE_LADDER: readonly number[] = [-8, -4, -2, -1, 0, 1, 2, 4, 8];

/** Arrow key: one export frame. Shift: ten. The Premiere-familiar pair. */
export const NUDGE_FRAMES = 1;
export const SHIFT_NUDGE_FRAMES = 10;

/**
 * Minimum distance between the in and out handles, in export frames.
 *
 * TWO, not one — see rule 6. `scrubber.test.ts` proves one frame is not
 * always expressible on the grid rather than taking this on trust.
 */
export const MIN_TRIM_FRAMES = 2;

/** How far past its clamp a trim handle may be dragged before it stops moving. */
export const RUBBER_BAND_PX = 24;

/** The narrowest gap at which a tick is still worth drawing. */
export const MIN_TICK_PX = 6;

/**
 * Tick strides in frames, coarsest last: every frame, every 5, then the
 * second (60), and multiples of the second up to five minutes. Deliberately
 * not a round-numbers algorithm — at 60 fps the meaningful units are the
 * frame and the second, and a computed "nice number" would happily offer 250
 * frames, which is 4.17 seconds and means nothing to anyone.
 */
const TICK_LADDER = [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600, 18000] as const;

/**
 * How many export frames a take of this length has, inclusive of the frame at
 * `durationNs`.
 *
 * Derived from `exportFrameOf` rather than copied from `trim.ts`'s
 * `availableFrames`, which computes the same count and cannot be imported
 * here: `trim.ts` chains through `transform-version.ts` to `cursor-art.ts`
 * and would drag `CanvasGradient` into the no-DOM pass (the STC-318 lesson).
 * `scrubber.test.ts` asserts the two agree, so the derivation cannot drift
 * from the module that owns the trim.
 */
export function frameCount(durationNs: number): number {
  return exportFrameOf(Math.max(0, durationNs)).frame + 1;
}

/** The last addressable frame index. */
export function lastFrame(durationNs: number): number {
  return frameCount(durationNs) - 1;
}

export function clampFrame(frame: number, durationNs: number): number {
  // NaN is "no answer" and resolves to the start; an infinity is a direction
  // and resolves to that end, which `Math.min`/`Math.max` already do.
  if (Number.isNaN(frame)) return 0;
  return Math.max(0, Math.min(Math.round(frame), lastFrame(durationNs)));
}

/** Session time at a frame index — the ONE way this module produces a time. */
export function frameToNs(frame: number, durationNs: number): number {
  return Math.min(exportFrameTimeNs(clampFrame(frame, durationNs)), Math.max(0, durationNs));
}

/** The frame a time falls in, clamped to the take (rule 1's snap). */
export function nsToFrame(tNs: number, durationNs: number): number {
  return clampFrame(exportFrameOf(Math.max(0, tNs)).frame, durationNs);
}

/**
 * The frame a pointer at `fraction` along the track is over.
 *
 * ROUNDS rather than floors: the frame you land on should be the one whose
 * tick is nearest the pointer, or the second half of every frame's width
 * selects the frame before it and the control feels a frame behind the
 * cursor. Flooring is right for "which frame contains this instant"
 * (`exportFrameOf`); rounding is right for "which frame is this gesture
 * pointing at", and they are different questions.
 */
export function frameAtFraction(fraction: number, durationNs: number): number {
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  return clampFrame(Math.round(f * lastFrame(durationNs)), durationNs);
}

/** Where a frame sits along the track, 0..1 — the inverse of the above. */
export function fractionOfFrame(frame: number, durationNs: number): number {
  const last = lastFrame(durationNs);
  if (last <= 0) return 0;
  return clampFrame(frame, durationNs) / last;
}

/** One step along the shuttle ladder (rule 7). `direction` is +1 for L, -1 for J. */
export function nextShuttleRate(current: number, direction: 1 | -1): number {
  let i = SHUTTLE_LADDER.indexOf(current);
  if (i < 0) {
    // A rate off the ladder (never produced here, but a caller could hold a
    // stale one) resolves to its nearest rung so the step is still one step.
    i = SHUTTLE_LADDER.reduce(
      (best, r, k) => (Math.abs(r - current) < Math.abs(SHUTTLE_LADDER[best]! - current) ? k : best),
      0,
    );
  }
  return SHUTTLE_LADDER[Math.max(0, Math.min(SHUTTLE_LADDER.length - 1, i + direction))]!;
}

export type ScrubAction =
  /** Move the playhead to an absolute frame and stop shuttling. */
  | { kind: "seek"; frame: number }
  /** Play at a signed multiple of real time; 0 means stop. */
  | { kind: "shuttle"; rate: number }
  /** Set the in or out point at the playhead. */
  | { kind: "mark"; which: "in" | "out" };

export interface KeyChord {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  /** True when a text field, textarea or contenteditable has focus (rule 8). */
  inTextField?: boolean;
}

export interface ScrubState {
  frame: number;
  durationNs: number;
  /** The current signed shuttle rate; 0 when stopped. */
  rate: number;
}

/**
 * What a keystroke means over an open preview, or null for "not ours".
 *
 * Returning null rather than an action is what lets the caller
 * `preventDefault` exactly the keys it handled. That matters more than it
 * looks: the scrubber IS a range input, so Left/Right already move it
 * natively by one step — handled and not prevented, a nudge would move two
 * frames, which is the kind of fault that reads as a mysterious feel problem
 * rather than as a bug.
 */
export function decideKey(chord: KeyChord, state: ScrubState): ScrubAction | null {
  // Rule 8. Modifiers belong to the app's own accelerators (⌘⇧C copies the
  // frame) and to the system; a scrubber that swallowed them would break
  // shortcuts that have nothing to do with it.
  if (chord.metaKey || chord.ctrlKey || chord.altKey) return null;
  if (chord.inTextField) return null;

  const key = chord.key;
  const step = chord.shiftKey ? SHIFT_NUDGE_FRAMES : NUDGE_FRAMES;

  switch (key) {
    case "ArrowLeft":
      return { kind: "seek", frame: clampFrame(state.frame - step, state.durationNs) };
    case "ArrowRight":
      return { kind: "seek", frame: clampFrame(state.frame + step, state.durationNs) };
    case "Home":
      return { kind: "seek", frame: 0 };
    case "End":
      return { kind: "seek", frame: lastFrame(state.durationNs) };
    default:
      break;
  }

  // Letters are matched case-insensitively: shift is a speed modifier
  // everywhere else on this control, and "shift+L means nothing" would be a
  // surprise rather than a rule.
  switch (key.toLowerCase()) {
    case "j":
      return { kind: "shuttle", rate: nextShuttleRate(state.rate, -1) };
    case "l":
      return { kind: "shuttle", rate: nextShuttleRate(state.rate, 1) };
    case "k":
      return { kind: "shuttle", rate: 0 };
    case " ":
      return { kind: "shuttle", rate: state.rate === 0 ? 1 : 0 };
    case "i":
      return { kind: "mark", which: "in" };
    case "o":
      return { kind: "mark", which: "out" };
    default:
      return null;
  }
}

/**
 * Where a dragged trim handle may actually go, and whether it is being held
 * there (rule 5).
 *
 * `requested` is the frame under the pointer; `opposite` is the other
 * handle's frame. `clamped` is where the handle is allowed to sit; `held` is
 * true when the pointer has gone past that — which is what the view turns
 * into rubber band and a visible state, rather than letting the handle stop
 * dead under a pointer that is still moving.
 */
export function clampTrimFrame(
  which: "in" | "out",
  requested: number,
  opposite: number,
  durationNs: number,
): { clamped: number; held: boolean } {
  const last = lastFrame(durationNs);
  // NOT clamped to the take first: `held` is measured against what the POINTER
  // asked for, and clamping here would erase the fact that it went past the
  // end of the track. Dragging a handle off the left edge would then read as
  // held: false and feel dead — the silent stop rule 5 exists to prevent.
  const want = Number.isNaN(requested) ? 0 : Math.round(requested);
  // A take too short to hold the minimum trim collapses to the whole take
  // rather than reporting a limit the material cannot satisfy.
  if (last < MIN_TRIM_FRAMES) return { clamped: which === "in" ? 0 : last, held: false };
  const clamped =
    which === "in"
      ? Math.max(0, Math.min(want, opposite - MIN_TRIM_FRAMES))
      : Math.min(last, Math.max(want, opposite + MIN_TRIM_FRAMES));
  return { clamped, held: clamped !== want };
}

/**
 * How far past its clamp a handle is drawn, given how far past it the pointer
 * is (rule 5).
 *
 * `excess * R / (excess + R)` — the standard asymptotic band. At the clamp it
 * is zero and its slope is 1, so resistance ARRIVES rather than switching on;
 * far past it, it approaches `R` and never exceeds it, so the handle cannot
 * be dragged into somewhere it will not settle. Negative input (the pointer
 * back inside the limit) is zero, not a mirror: there is nothing to resist.
 */
export function rubberBandPx(excessPx: number, range: number = RUBBER_BAND_PX): number {
  if (!(excessPx > 0) || range <= 0) return 0;
  return (excessPx * range) / (excessPx + range);
}

/**
 * The finest tick stride that still leaves `MIN_TICK_PX` between ticks, or
 * null when even the coarsest does not (rule 9).
 */
export function tickStrideFrames(
  durationNs: number,
  trackPx: number,
  minPx: number = MIN_TICK_PX,
): number | null {
  const last = lastFrame(durationNs);
  if (last <= 0 || !(trackPx > 0)) return null;
  const pxPerFrame = trackPx / last;
  for (const stride of TICK_LADDER) {
    if (pxPerFrame * stride >= minPx) return stride;
  }
  return null;
}

/**
 * `M:SS:FF` — minutes, seconds, and the frame within the second (rule 10).
 *
 * Built from the FRAME index, not from the time: deriving the frame field by
 * taking a remainder of nanoseconds would reintroduce exactly the off-by-one
 * the grid exists to prevent, since `exportFrameTimeNs` ceilings and the
 * remainder would not.
 */
export function formatTimecode(frame: number): string {
  const f = Math.max(0, Math.round(frame));
  const totalSeconds = Math.floor(f / EXPORT_FPS);
  const frames = f % EXPORT_FPS;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}:${String(frames).padStart(2, "0")}`;
}

/** The readout the clock shows: where the playhead is, out of what. */
export function formatReadout(frame: number, durationNs: number): string {
  return `${formatTimecode(clampFrame(frame, durationNs))} / ${formatTimecode(lastFrame(durationNs))}`;
}

/**
 * How the rate is announced, e.g. "8x" or "-2x" — empty when stopped.
 *
 * Shown for ordinary playback too, where it reads "1x". That is information
 * rather than chrome precisely because it can also say 8x: a number that only
 * ever had one value would not be worth the space.
 */
export function formatShuttle(rate: number): string {
  return rate === 0 ? "" : `${rate}x`;
}
