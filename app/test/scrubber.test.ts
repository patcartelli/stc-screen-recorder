import { describe, expect, test } from "vitest";
import {
  MIN_TICK_PX,
  MIN_TRIM_FRAMES,
  NUDGE_FRAMES,
  RUBBER_BAND_PX,
  SHIFT_NUDGE_FRAMES,
  SHUTTLE_LADDER,
  clampFrame,
  clampTrimFrame,
  decideKey,
  formatReadout,
  formatShuttle,
  formatTimecode,
  frameAtFraction,
  frameCount,
  frameToNs,
  fractionOfFrame,
  lastFrame,
  nextShuttleRate,
  nsToFrame,
  rubberBandPx,
  tickStrideFrames,
} from "../src/scrubber.js";
import { availableFrames, clampTrim, minTrimNs } from "@transform/trim.js";
import { EXPORT_FPS, exportFrameOf, exportFrameTimeNs } from "@transform/time.js";

const S = 1_000_000_000;

describe("the frame grid is time.ts's, not a second copy", () => {
  test("frameCount agrees with trim.ts's availableFrames at 60 fps", () => {
    // The load-bearing seam. `scrubber.ts` cannot import trim.ts (it chains to
    // cursor-art.ts and would drag CanvasGradient into the no-DOM pass), so
    // the count is DERIVED from exportFrameOf. This is what stops the
    // derivation drifting from the module that owns the trim.
    for (const durationNs of [0, 1, S / 2, S, 5 * S, 61 * S, 907 * S + 12345]) {
      expect(frameCount(durationNs)).toBe(availableFrames(durationNs, EXPORT_FPS));
    }
  });

  test("nsToFrame is exportFrameOf, and frameToNs is its inverse", () => {
    for (let f = 0; f < 5000; f++) {
      const ns = exportFrameTimeNs(f);
      expect(nsToFrame(ns, 3600 * S)).toBe(f);
      expect(frameToNs(f, 3600 * S)).toBe(ns);
      // A time just inside the frame's interval still resolves to it.
      expect(nsToFrame(ns + 1, 3600 * S)).toBe(f);
    }
  });

  test("a frame position can never land between two frames", () => {
    // Rule 1, as a property: whatever a pointer anywhere on the track asks
    // for, the time that comes out is a time some export frame is rendered at.
    const durationNs = 37 * S;
    for (let i = 0; i <= 1000; i++) {
      const ns = frameToNs(frameAtFraction(i / 1000, durationNs), durationNs);
      expect(exportFrameTimeNs(exportFrameOf(ns).frame)).toBe(ns);
    }
  });
});

describe("rule 6 — the minimum trim is two frames, re-derived", () => {
  // The header states 2 frames and cites a measurement. This RUNS that
  // measurement against the real clampTrim, so the constant moves if the grid
  // does rather than sitting in a comment that used to be true.
  const offGrid = (gapFrames: number): number => {
    let bad = 0;
    for (let f = 0; f < 20000; f++) {
      const startNs = exportFrameTimeNs(f);
      const endNs = exportFrameTimeNs(f + gapFrames);
      const got = clampTrim(startNs, endNs, 3600 * S, EXPORT_FPS);
      if (got.startNs !== startNs || got.endNs !== endNs) bad++;
    }
    return bad;
  };

  test("a one-frame trim is pushed off the grid; a two-frame trim is not", () => {
    expect(offGrid(1)).toBeGreaterThan(0);
    expect(offGrid(MIN_TRIM_FRAMES)).toBe(0);
  });

  test("the cause: minTrimNs does not divide the frame grid evenly", () => {
    // 16666667 ns against steps of 16666666 and 16666667 — which is why the
    // minimum cannot be expressed as one frame at all.
    const steps = new Set<number>();
    for (let f = 0; f < 100; f++) steps.add(exportFrameTimeNs(f + 1) - exportFrameTimeNs(f));
    expect(steps.size).toBeGreaterThan(1);
    expect(Math.min(...steps)).toBeLessThan(minTrimNs(EXPORT_FPS));
  });
});

describe("pointer position", () => {
  const durationNs = 10 * S; // 601 frames, 0..600

  test("the ends of the track are the ends of the take", () => {
    expect(frameAtFraction(0, durationNs)).toBe(0);
    expect(frameAtFraction(1, durationNs)).toBe(lastFrame(durationNs));
    expect(lastFrame(durationNs)).toBe(600);
  });

  test("it ROUNDS to the nearest tick rather than flooring", () => {
    // Flooring would put the pointer a frame behind the cursor over the
    // second half of every frame's width. The control must not feel late.
    const last = lastFrame(durationNs);
    const justPastHalfAFrame = 0.6 / last;
    expect(frameAtFraction(justPastHalfAFrame, durationNs)).toBe(1);
    expect(frameAtFraction(0.4 / last, durationNs)).toBe(0);
  });

  test("fractionOfFrame is the inverse and both stay in range", () => {
    for (const f of [0, 1, 300, 600]) {
      expect(frameAtFraction(fractionOfFrame(f, durationNs), durationNs)).toBe(f);
    }
    expect(frameAtFraction(-5, durationNs)).toBe(0);
    expect(frameAtFraction(9, durationNs)).toBe(600);
    expect(frameAtFraction(NaN, durationNs)).toBe(0);
  });

  test("a take with a single frame has nowhere to go", () => {
    expect(lastFrame(0)).toBe(0);
    expect(frameAtFraction(0.7, 0)).toBe(0);
    expect(fractionOfFrame(0, 0)).toBe(0);
  });
});

describe("rule 7 — one signed shuttle ladder", () => {
  test("L accelerates forward, J accelerates in reverse", () => {
    expect(nextShuttleRate(0, 1)).toBe(1);
    expect(nextShuttleRate(1, 1)).toBe(2);
    expect(nextShuttleRate(2, 1)).toBe(4);
    expect(nextShuttleRate(4, 1)).toBe(8);
    expect(nextShuttleRate(0, -1)).toBe(-1);
    expect(nextShuttleRate(-4, -1)).toBe(-8);
  });

  test("J while playing forward DECELERATES, and keeps going into reverse", () => {
    // The payoff of one ladder: this needs no rule of its own.
    expect(nextShuttleRate(4, -1)).toBe(2);
    expect(nextShuttleRate(2, -1)).toBe(1);
    expect(nextShuttleRate(1, -1)).toBe(0);
    expect(nextShuttleRate(0, -1)).toBe(-1);
  });

  test("the ladder has ends and they hold", () => {
    expect(nextShuttleRate(8, 1)).toBe(8);
    expect(nextShuttleRate(-8, -1)).toBe(-8);
  });

  test("a rate off the ladder resolves to its nearest rung", () => {
    expect(nextShuttleRate(3, 1)).toBe(4);
    expect(SHUTTLE_LADDER).toContain(nextShuttleRate(99, -1));
  });
});

describe("rule 8 — the keyboard grammar", () => {
  const state = { frame: 100, durationNs: 60 * S, rate: 0 };

  test("arrows nudge one frame, shift ten", () => {
    expect(decideKey({ key: "ArrowRight" }, state)).toEqual({ kind: "seek", frame: 100 + NUDGE_FRAMES });
    expect(decideKey({ key: "ArrowLeft" }, state)).toEqual({ kind: "seek", frame: 100 - NUDGE_FRAMES });
    expect(decideKey({ key: "ArrowRight", shiftKey: true }, state))
      .toEqual({ kind: "seek", frame: 100 + SHIFT_NUDGE_FRAMES });
    expect(decideKey({ key: "ArrowLeft", shiftKey: true }, state))
      .toEqual({ kind: "seek", frame: 100 - SHIFT_NUDGE_FRAMES });
  });

  test("a nudge at either end stops at the end rather than running off", () => {
    expect(decideKey({ key: "ArrowLeft", shiftKey: true }, { ...state, frame: 3 }))
      .toEqual({ kind: "seek", frame: 0 });
    const last = lastFrame(state.durationNs);
    expect(decideKey({ key: "ArrowRight", shiftKey: true }, { ...state, frame: last - 2 }))
      .toEqual({ kind: "seek", frame: last });
  });

  test("J K L shuttle and I O mark", () => {
    expect(decideKey({ key: "l" }, state)).toEqual({ kind: "shuttle", rate: 1 });
    expect(decideKey({ key: "j" }, state)).toEqual({ kind: "shuttle", rate: -1 });
    expect(decideKey({ key: "k" }, { ...state, rate: 8 })).toEqual({ kind: "shuttle", rate: 0 });
    expect(decideKey({ key: "i" }, state)).toEqual({ kind: "mark", which: "in" });
    expect(decideKey({ key: "o" }, state)).toEqual({ kind: "mark", which: "out" });
  });

  test("the letters are case-insensitive", () => {
    expect(decideKey({ key: "L", shiftKey: true }, state)).toEqual({ kind: "shuttle", rate: 1 });
    expect(decideKey({ key: "I", shiftKey: true }, state)).toEqual({ kind: "mark", which: "in" });
  });

  test("space toggles between stopped and 1x", () => {
    expect(decideKey({ key: " " }, state)).toEqual({ kind: "shuttle", rate: 1 });
    expect(decideKey({ key: " " }, { ...state, rate: 4 })).toEqual({ kind: "shuttle", rate: 0 });
  });

  test("a focused text field owns every bare key", () => {
    // Rule 8's whole point: typing "in" into the slug field must not mark an
    // in point, and typing a width must not shuttle.
    for (const key of ["i", "o", "j", "k", "l", " ", "ArrowLeft", "ArrowRight"]) {
      expect(decideKey({ key, inTextField: true }, state)).toBeNull();
    }
  });

  test("a modifier means the key is not the scrubber's", () => {
    // ⌘⇧C copies the frame; ⌃⌥⇧⌘1 captures. Swallowing these would break
    // shortcuts that have nothing to do with the timeline.
    expect(decideKey({ key: "c", metaKey: true, shiftKey: true }, state)).toBeNull();
    expect(decideKey({ key: "l", metaKey: true }, state)).toBeNull();
    expect(decideKey({ key: "ArrowRight", altKey: true }, state)).toBeNull();
    expect(decideKey({ key: "1", ctrlKey: true, altKey: true, shiftKey: true, metaKey: true }, state))
      .toBeNull();
  });

  test("keys the scrubber does not claim return null, so the caller can tell", () => {
    // This is what lets renderer.ts preventDefault EXACTLY what it handled —
    // the range input moves natively on Left/Right, so a handled-but-not-
    // prevented arrow would move two frames.
    expect(decideKey({ key: "q" }, state)).toBeNull();
    expect(decideKey({ key: "Enter" }, state)).toBeNull();
    expect(decideKey({ key: "Tab" }, state)).toBeNull();
  });

  test("Home and End reach the ends of the take", () => {
    expect(decideKey({ key: "Home" }, state)).toEqual({ kind: "seek", frame: 0 });
    expect(decideKey({ key: "End" }, state))
      .toEqual({ kind: "seek", frame: lastFrame(state.durationNs) });
  });
});

describe("rule 5 — a clamp is felt, not silent", () => {
  const durationNs = 10 * S; // 601 frames

  test("the handles keep MIN_TRIM_FRAMES apart, and say when they are held", () => {
    const free = clampTrimFrame("in", 100, 400, durationNs);
    expect(free).toEqual({ clamped: 100, held: false });

    const held = clampTrimFrame("in", 399, 400, durationNs);
    expect(held.clamped).toBe(400 - MIN_TRIM_FRAMES);
    expect(held.held).toBe(true);

    const heldOut = clampTrimFrame("out", 101, 100, durationNs);
    expect(heldOut.clamped).toBe(100 + MIN_TRIM_FRAMES);
    expect(heldOut.held).toBe(true);
  });

  test("`held` is what makes resistance visible — it is not merely the clamp", () => {
    // A clamp with no `held` would be the silent stop rule 5 forbids: the
    // view has nothing to change and the handle just parks under a moving
    // pointer. Dragging exactly ONTO the clamp is not being held.
    expect(clampTrimFrame("in", 398, 400, durationNs).held).toBe(false);
    expect(clampTrimFrame("in", 399, 400, durationNs).held).toBe(true);
  });

  test("the ends of the take clamp too", () => {
    expect(clampTrimFrame("in", -20, 400, durationNs)).toEqual({ clamped: 0, held: true });
    const last = lastFrame(durationNs);
    expect(clampTrimFrame("out", last + 50, 100, durationNs)).toEqual({ clamped: last, held: true });
  });

  test("a take too short for a trim collapses instead of reporting a limit", () => {
    expect(clampTrimFrame("in", 5, 0, S / 100)).toEqual({ clamped: 0, held: false });
  });

  test("the rubber band arrives smoothly and never exceeds its range", () => {
    expect(rubberBandPx(0)).toBe(0);
    expect(rubberBandPx(-30)).toBe(0);
    // Slope 1 at the clamp: resistance ARRIVES rather than switching on.
    expect(rubberBandPx(0.001)).toBeCloseTo(0.001, 5);
    // Monotone, and asymptotic to RUBBER_BAND_PX.
    let prev = 0;
    for (const excess of [1, 5, 20, 100, 1000, 100000]) {
      const got = rubberBandPx(excess);
      expect(got).toBeGreaterThan(prev);
      expect(got).toBeLessThan(RUBBER_BAND_PX);
      prev = got;
    }
    expect(rubberBandPx(1e9)).toBeCloseTo(RUBBER_BAND_PX, 3);
  });
});

describe("rule 9 — a tick is drawn only when it can be seen", () => {
  test("a short take gets per-frame ticks", () => {
    // 1 second = 61 frames over 600 px is 10 px a frame.
    expect(tickStrideFrames(S, 600)).toBe(1);
  });

  test("a long take coarsens rather than hatching", () => {
    const stride = tickStrideFrames(600 * S, 600); // 10 minutes over 600 px
    expect(stride).not.toBeNull();
    // Whatever it picked must actually clear the legibility floor.
    const pxPerFrame = 600 / lastFrame(600 * S);
    expect(pxPerFrame * stride!).toBeGreaterThanOrEqual(MIN_TICK_PX);
  });

  test("it returns the FINEST stride that clears the floor, not just any", () => {
    // A function that always answered with the coarsest rung would pass a
    // "clears the floor" assertion and be useless.
    const durationNs = 60 * S;
    const trackPx = 600;
    const stride = tickStrideFrames(durationNs, trackPx)!;
    const pxPerFrame = trackPx / lastFrame(durationNs);
    expect(pxPerFrame * stride).toBeGreaterThanOrEqual(MIN_TICK_PX);
    // ...and one rung finer would NOT have cleared it.
    expect(pxPerFrame * (stride / 2)).toBeLessThan(MIN_TICK_PX);
  });

  test("nothing is drawn when even the coarsest rung is too fine", () => {
    expect(tickStrideFrames(10 * 3600 * S, 40)).toBeNull();
    expect(tickStrideFrames(60 * S, 0)).toBeNull();
    expect(tickStrideFrames(0, 600)).toBeNull();
  });
});

describe("rule 10 — the readout is frame-accurate", () => {
  test("M:SS:FF, built from the frame index", () => {
    expect(formatTimecode(0)).toBe("0:00:00");
    expect(formatTimecode(1)).toBe("0:00:01");
    expect(formatTimecode(59)).toBe("0:00:59");
    expect(formatTimecode(60)).toBe("0:01:00");
    expect(formatTimecode(3601)).toBe("1:00:01"); // 3601 frames = 1 min + 1 frame
  });

  test("adjacent frames read differently — the thing seconds cannot do", () => {
    for (let f = 0; f < 400; f++) {
      expect(formatTimecode(f)).not.toBe(formatTimecode(f + 1));
    }
  });

  test("minutes roll over", () => {
    expect(formatTimecode(60 * EXPORT_FPS)).toBe("1:00:00");
    expect(formatTimecode(90 * EXPORT_FPS + 7)).toBe("1:30:07");
    expect(formatTimecode(605 * EXPORT_FPS)).toBe("10:05:00");
  });

  test("the readout names where the playhead is, out of what", () => {
    expect(formatReadout(90, 10 * S)).toBe("0:01:30 / 0:10:00");
  });

  test("the shuttle rate is announced only while shuttling", () => {
    expect(formatShuttle(0)).toBe("");
    expect(formatShuttle(1)).toBe("1x");
    expect(formatShuttle(-4)).toBe("-4x");
  });
});

describe("clampFrame", () => {
  test("holds the take's bounds and survives nonsense", () => {
    expect(clampFrame(-1, 10 * S)).toBe(0);
    expect(clampFrame(1e9, 10 * S)).toBe(600);
    expect(clampFrame(NaN, 10 * S)).toBe(0);
    expect(clampFrame(Infinity, 10 * S)).toBe(600);
    expect(clampFrame(12.4, 10 * S)).toBe(12);
  });
});
