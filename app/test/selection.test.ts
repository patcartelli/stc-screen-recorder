import { describe, test, expect } from "vitest";
import {
  reduce, confirm, initialState, dragRect, resizeRect, moveRect, roundRect,
  dominantDisplay, toDisplayLocal, windowUnderPoint, intersect, pixelSize,
  MIN_SELECTION_POINTS, NUDGE_POINTS_SHIFT,
  type SelectionState, type SelectionContext, type SelectionEvent, type Rect,
} from "../src/selection.js";

/**
 * STC-290's decisions, without a screen.
 *
 * Everything the ticket's acceptance list can be settled by argument is here:
 * a drag that crosses displays, a window that closes between hover and confirm,
 * Escape from every state, and the click that is not a selection. What is left
 * for the Mac is whether the overlay LOOKS right and whether it stays out of
 * the captured pixels — see docs/STC-290-RUNBOOK.md.
 *
 * Two displays side by side, the second one Retina and taller, because a
 * single 1x display hides every mistake this file exists to catch: a scale
 * factor assumed to be 1, an origin assumed to be zero, and a global point
 * assumed to be a display-local one.
 */
const MAIN = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
const RIGHT = { id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, scaleFactor: 2 };

const WINDOWS = [
  // Front to back, as SCShareableContent lists them — the front one overlaps
  // the back one, which is the only way to prove the order is respected.
  { id: 11, bounds: { x: 100, y: 100, width: 400, height: 300 }, app: "Notes", title: "Front" },
  { id: 12, bounds: { x: 200, y: 150, width: 800, height: 600 }, app: "Finder", title: "Behind" },
  { id: 13, bounds: { x: 2000, y: 200, width: 500, height: 400 }, app: "Safari", title: "On the right display" },
];

const ctx: SelectionContext = { displays: [MAIN, RIGHT], windows: WINDOWS };

/** Drive a sequence of events, returning the last reduction. */
function run(events: SelectionEvent[], start: SelectionState = initialState(),
             context: SelectionContext = ctx) {
  let state = start;
  let outcome;
  for (const ev of events) {
    const r = reduce(state, ev, context);
    state = r.state;
    if (r.outcome) outcome = r.outcome;
  }
  return { state, outcome };
}

const drag = (from: [number, number], to: [number, number], mods = {}): SelectionEvent[] => [
  { t: "pointerdown", at: { x: from[0], y: from[1] } },
  { t: "pointermove", at: { x: to[0], y: to[1] }, mods },
  { t: "pointerup", at: { x: to[0], y: to[1] }, mods },
];

describe("geometry", () => {
  test("a drag makes a marquee in either direction", () => {
    expect(dragRect({ x: 100, y: 100 }, { x: 300, y: 250 }))
      .toEqual({ x: 100, y: 100, width: 200, height: 150 });
    // Backwards drags are the same rect, not a negative one.
    expect(dragRect({ x: 300, y: 250 }, { x: 100, y: 100 }))
      .toEqual({ x: 100, y: 100, width: 200, height: 150 });
  });

  test("Shift squares a new drag, following the larger delta", () => {
    const r = dragRect({ x: 100, y: 100 }, { x: 300, y: 150 }, { shift: true });
    expect(r.width).toBe(r.height);
    expect(r.width).toBe(200);
  });

  test("Shift squares a backwards drag without flipping it inside out", () => {
    const r = dragRect({ x: 300, y: 300 }, { x: 100, y: 250 }, { shift: true });
    expect(r).toEqual({ x: 100, y: 100, width: 200, height: 200 });
  });

  test("Option draws from the anchor as the centre", () => {
    const r = dragRect({ x: 200, y: 200 }, { x: 300, y: 250 }, { alt: true });
    expect(r).toEqual({ x: 100, y: 150, width: 200, height: 100 });
    expect(r.x + r.width / 2).toBe(200);
    expect(r.y + r.height / 2).toBe(200);
  });

  test("Shift and Option together give a centred square", () => {
    const r = dragRect({ x: 200, y: 200 }, { x: 300, y: 220 }, { shift: true, alt: true });
    expect(r).toEqual({ x: 100, y: 100, width: 200, height: 200 });
  });

  const origin: Rect = { x: 100, y: 100, width: 400, height: 200 };

  test("a corner handle moves the two edges it touches and no others", () => {
    // Dragging the south-east corner right and down grows both, origin fixed.
    expect(resizeRect(origin, "se", 50, 30))
      .toEqual({ x: 100, y: 100, width: 450, height: 230 });
    // The north-west corner moves the origin instead.
    expect(resizeRect(origin, "nw", 50, 30))
      .toEqual({ x: 150, y: 130, width: 350, height: 170 });
  });

  test("an edge handle drives one axis only", () => {
    expect(resizeRect(origin, "e", 50, 999)).toEqual({ x: 100, y: 100, width: 450, height: 200 });
    expect(resizeRect(origin, "n", 999, 30)).toEqual({ x: 100, y: 130, width: 400, height: 170 });
  });

  test("Shift preserves the aspect the marquee had when the handle was grabbed", () => {
    const r = resizeRect(origin, "se", 200, 0, { shift: true });
    expect(r.width / r.height).toBeCloseTo(origin.width / origin.height, 10);
  });

  test("Shift on an edge handle drives the other axis too, keeping the ratio", () => {
    const r = resizeRect(origin, "e", 200, 0, { shift: true });
    expect(r.height).not.toBe(origin.height);
    expect(r.width / r.height).toBeCloseTo(2, 10);
  });

  test("Option resizes about the centre, so the opposite edge moves too", () => {
    const before = { cx: origin.x + origin.width / 2, cy: origin.y + origin.height / 2 };
    const r = resizeRect(origin, "e", 50, 0, { alt: true });
    expect(r.width).toBe(500);
    expect(r.x + r.width / 2).toBe(before.cx);
    expect(r.y + r.height / 2).toBe(before.cy);
  });

  test("dragging a handle past the opposite edge flips rather than going negative", () => {
    const r = resizeRect(origin, "e", -600, 0);
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
    expect(r.x).toBeLessThan(origin.x);
  });

  test("rounding keeps the far edge where it was, not the width", () => {
    // Naively rounding x and width separately loses a point here.
    expect(roundRect({ x: 10.6, y: 0, width: 100.1, height: 10 }))
      .toEqual({ x: 11, y: 0, width: 100, height: 10 });
  });

  test("pixels come from the display's own scale factor", () => {
    const r = { x: 0, y: 0, width: 640, height: 360 };
    expect(pixelSize(r, MAIN)).toEqual({ width: 640, height: 360 });
    expect(pixelSize(r, RIGHT)).toEqual({ width: 1280, height: 720 });
    // An unknown display must not silently multiply by zero.
    expect(pixelSize(r, undefined)).toEqual({ width: 640, height: 360 });
  });
});

describe("displays", () => {
  test("a region wholly on one display belongs to it", () => {
    expect(dominantDisplay({ x: 100, y: 100, width: 200, height: 200 }, ctx.displays)?.id).toBe(1);
    expect(dominantDisplay({ x: 2000, y: 100, width: 200, height: 200 }, ctx.displays)?.id).toBe(2);
  });

  test("a region spanning two displays belongs to the one holding most of it", () => {
    // 300 points on the main display, 700 on the right one.
    expect(dominantDisplay({ x: 1620, y: 100, width: 1000, height: 100 }, ctx.displays)?.id).toBe(2);
    // And the other way round.
    expect(dominantDisplay({ x: 1220, y: 100, width: 1000, height: 100 }, ctx.displays)?.id).toBe(1);
  });

  test("a region on no display at all belongs to none", () => {
    expect(dominantDisplay({ x: -5000, y: -5000, width: 10, height: 10 }, ctx.displays)).toBeUndefined();
  });

  test("global becomes display-local by the display's own origin", () => {
    const r = { x: 2000, y: 300, width: 400, height: 200 };
    expect(toDisplayLocal(r, RIGHT)).toEqual({ x: 80, y: 300, width: 400, height: 200 });
  });

  test("intersect clips to the display and reports nothing when there is no overlap", () => {
    expect(intersect({ x: 1820, y: 0, width: 200, height: 100 }, MAIN.bounds))
      .toEqual({ x: 1820, y: 0, width: 100, height: 100 });
    expect(intersect({ x: 5000, y: 0, width: 10, height: 10 }, MAIN.bounds)).toBeUndefined();
  });
});

describe("windows", () => {
  test("the front window wins where two overlap", () => {
    // (250, 200) is inside both 11 and 12; 11 is in front.
    expect(windowUnderPoint(WINDOWS, { x: 250, y: 200 })?.id).toBe(11);
    // Where only the back one covers, it wins.
    expect(windowUnderPoint(WINDOWS, { x: 900, y: 700 })?.id).toBe(12);
  });

  test("bare desktop is no window, not the first one", () => {
    expect(windowUnderPoint(WINDOWS, { x: 1500, y: 900 })).toBeUndefined();
  });

  test("a window on the second display is found in global coordinates", () => {
    expect(windowUnderPoint(WINDOWS, { x: 2100, y: 300 })?.id).toBe(13);
  });
});

describe("the interaction", () => {
  test("a drag leaves a marquee and confirming hands over a display-local crop", () => {
    const { state } = run(drag([100, 100], [740, 460]));
    expect(state.rect).toEqual({ x: 100, y: 100, width: 640, height: 360 });
    expect(confirm(state, ctx)).toEqual({
      kind: "region", displayId: 1,
      crop: { x: 100, y: 100, width: 640, height: 360 },
      global: { x: 100, y: 100, width: 640, height: 360 },
    });
  });

  test("a region drawn on the second display is handed over in THAT display's points", () => {
    const { state } = run(drag([2000, 300], [2400, 500]));
    const out = confirm(state, ctx);
    expect(out).toEqual({
      kind: "region", displayId: 2,
      crop: { x: 80, y: 300, width: 400, height: 200 },
      global: { x: 2000, y: 300, width: 400, height: 200 },
    });
  });

  test("a drag that starts on one display and ends on another is tracked, then clipped to the dominant one", () => {
    // Starts on the main display, ends well into the right one: 220 points of
    // it are on the main display and 780 on the right, so the right wins and
    // the crop is what will actually be captured — not what was drawn.
    const { state } = run(drag([1700, 200], [2700, 400]));
    expect(state.rect).toEqual({ x: 1700, y: 200, width: 1000, height: 200 });
    const out = confirm(state, ctx);
    expect(out).toEqual({
      kind: "region", displayId: 2,
      crop: { x: 0, y: 200, width: 780, height: 200 },
      global: { x: 1920, y: 200, width: 780, height: 200 },
    });
  });

  test("a click with no drag is not a selection", () => {
    const { state } = run([
      { t: "pointerdown", at: { x: 500, y: 500 } },
      { t: "pointerup", at: { x: 500, y: 500 } },
    ]);
    expect(state.rect).toBeUndefined();
    expect(confirm(state, ctx)).toBeUndefined();
  });

  test("a marquee smaller than the minimum is discarded on release", () => {
    const tiny = MIN_SELECTION_POINTS - 1;
    const { state } = run(drag([500, 500], [500 + tiny, 500 + tiny]));
    expect(state.rect).toBeUndefined();
  });

  test("a second drag replaces the first marquee", () => {
    const { state } = run([...drag([100, 100], [300, 300]), ...drag([600, 600], [800, 800])]);
    expect(state.rect).toEqual({ x: 600, y: 600, width: 200, height: 200 });
  });

  test("the marquee can be moved after it is drawn", () => {
    const { state } = run([
      ...drag([100, 100], [300, 300]),
      { t: "pointerdown", at: { x: 200, y: 200 }, onMarquee: true },
      { t: "pointermove", at: { x: 250, y: 280 } },
      { t: "pointerup", at: { x: 250, y: 280 } },
    ]);
    expect(state.rect).toEqual({ x: 150, y: 180, width: 200, height: 200 });
  });

  test("the marquee can be resized by a handle after it is drawn", () => {
    const { state } = run([
      ...drag([100, 100], [300, 300]),
      { t: "pointerdown", at: { x: 300, y: 300 }, handle: "se" },
      { t: "pointermove", at: { x: 400, y: 350 } },
      { t: "pointerup", at: { x: 400, y: 350 } },
    ]);
    expect(state.rect).toEqual({ x: 100, y: 100, width: 300, height: 250 });
  });

  test("arrow keys nudge by one point, ten with Shift", () => {
    const start = run(drag([100, 100], [300, 300])).state;
    const one = run([{ t: "key", key: "ArrowRight" }], start).state;
    expect(one.rect).toEqual({ x: 101, y: 100, width: 200, height: 200 });
    const ten = run([{ t: "key", key: "ArrowDown", mods: { shift: true } }], start).state;
    expect(ten.rect).toEqual({ x: 100, y: 100 + NUDGE_POINTS_SHIFT, width: 200, height: 200 });
  });

  test("a nudge with nothing selected does nothing rather than inventing a marquee", () => {
    const { state } = run([{ t: "key", key: "ArrowRight" }]);
    expect(state.rect).toBeUndefined();
  });

  test("Escape cancels from every state", () => {
    const states: Array<[string, SelectionState]> = [
      ["untouched", initialState()],
      ["mid-drag", run([{ t: "pointerdown", at: { x: 100, y: 100 } },
                        { t: "pointermove", at: { x: 200, y: 200 } }]).state],
      ["with a marquee", run(drag([100, 100], [300, 300])).state],
      ["in window mode", run([{ t: "key", key: " " },
                              { t: "pointermove", at: { x: 250, y: 200 } }]).state],
    ];
    for (const [what, state] of states) {
      const r = reduce(state, { t: "key", key: "Escape" }, ctx);
      expect(r.outcome, what).toEqual({ kind: "cancelled" });
    }
  });

  test("Return with nothing selected confirms nothing", () => {
    const { outcome } = run([{ t: "key", key: "Enter" }]);
    expect(outcome).toBeUndefined();
  });

  test("Return with a marquee confirms it", () => {
    const { outcome } = run([...drag([100, 100], [300, 300]), { t: "key", key: "Enter" }]);
    expect(outcome).toEqual({
      kind: "region", displayId: 1,
      crop: { x: 100, y: 100, width: 200, height: 200 },
      global: { x: 100, y: 100, width: 200, height: 200 },
    });
  });
});

describe("window mode", () => {
  test("Space toggles between the two modes and keeps the marquee", () => {
    const withRect = run(drag([100, 100], [300, 300])).state;
    const toWindow = reduce(withRect, { t: "key", key: " " }, ctx).state;
    expect(toWindow.mode).toBe("window");
    expect(toWindow.rect).toEqual(withRect.rect);
    const back = reduce(toWindow, { t: "key", key: " " }, ctx).state;
    expect(back.mode).toBe("region");
    expect(back.rect).toEqual(withRect.rect);
  });

  test("toggling into window mode highlights whatever the pointer is already over", () => {
    const { state } = run([
      { t: "pointermove", at: { x: 250, y: 200 } },
      { t: "key", key: " " },
    ]);
    expect(state.hoveredWindowId).toBe(11);
  });

  test("hovering highlights the window under the pointer and clears over the desktop", () => {
    const inWindowMode = reduce(initialState(), { t: "key", key: " " }, ctx).state;
    const over = reduce(inWindowMode, { t: "pointermove", at: { x: 900, y: 700 } }, ctx).state;
    expect(over.hoveredWindowId).toBe(12);
    const off = reduce(over, { t: "pointermove", at: { x: 1500, y: 900 } }, ctx).state;
    expect(off.hoveredWindowId).toBeUndefined();
  });

  test("a click in window mode selects that window at once", () => {
    const { outcome } = run([
      { t: "key", key: " " },
      { t: "pointermove", at: { x: 250, y: 200 } },
      { t: "pointerdown", at: { x: 250, y: 200 } },
    ]);
    expect(outcome).toEqual({ kind: "window", windowId: 11 });
  });

  test("a click on bare desktop in window mode selects nothing", () => {
    const { outcome } = run([
      { t: "key", key: " " },
      { t: "pointerdown", at: { x: 1500, y: 900 } },
    ]);
    expect(outcome).toBeUndefined();
  });

  test("a window that closed between hover and Return is refused, not captured by a stale id", () => {
    const hovered = run([{ t: "key", key: " " }, { t: "pointermove", at: { x: 250, y: 200 } }]).state;
    expect(hovered.hoveredWindowId).toBe(11);
    // The same state, against a world where that window is gone.
    const gone: SelectionContext = { ...ctx, windows: WINDOWS.filter((w) => w.id !== 11) };
    expect(confirm(hovered, ctx)).toEqual({ kind: "window", windowId: 11 });
    expect(confirm(hovered, gone)).toBeUndefined();
  });
});

describe("robustness", () => {
  test("a pointer event with a non-finite coordinate is ignored, not propagated", () => {
    const start = run(drag([100, 100], [300, 300])).state;
    const after = reduce(start, { t: "pointermove", at: { x: NaN, y: 10 } }, ctx).state;
    expect(after.rect).toEqual(start.rect);
  });

  test("an unknown key changes nothing", () => {
    const start = run(drag([100, 100], [300, 300])).state;
    const after = reduce(start, { t: "key", key: "q" }, ctx);
    expect(after.state).toEqual(start);
    expect(after.outcome).toBeUndefined();
  });

  test("a pointerup with no drag in flight is harmless", () => {
    const r = reduce(initialState(), { t: "pointerup", at: { x: 5, y: 5 } }, ctx);
    expect(r.state.rect).toBeUndefined();
    expect(r.outcome).toBeUndefined();
  });

  test("with no displays at all, a region confirms to nothing rather than throwing", () => {
    const state = run(drag([100, 100], [300, 300])).state;
    expect(confirm(state, { displays: [], windows: [] })).toBeUndefined();
  });
});
