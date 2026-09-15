import { describe, test, expect } from "vitest";
import {
  windowId, overrideFor, resolvedCrop, resolvedEasingName, groupByEasing, nearestWindow,
  manualWindows, rectFromGesture, DEFAULT_OVERRIDE_RECT_FRACTION, MIN_DRAG_UV,
  type CombinedZoomWindow,
} from "../src/zoom-override.js";
import { createZoomSim, inWindow, ZOOM_PRESETS, type ZoomPreset, type ZoomWindow } from "../src/zoom.js";
import type { ZoomOverride } from "../src/types.js";

const MS = 1_000_000;
const w = (startNs: number, endNs: number): ZoomWindow => ({ startNs, endNs, events: [] });
const manual = (
  id: string, startNs: number, endNs: number,
  rect = { x: 0, y: 0, width: 1, height: 1 }, easing: ZoomPreset = "standard",
): Extract<ZoomOverride, { kind: "manual" }> => ({ kind: "manual", id, startNs, endNs, rect, easing });

describe("windowId / overrideFor", () => {
  test("windowId is the window's startNs, as a string", () => {
    expect(windowId(w(1234, 5678))).toBe("1234");
  });

  test("overrideFor finds the matching geometry override by windowId", () => {
    const overrides: ZoomOverride[] = [
      { kind: "geometry", windowId: "100", rect: { x: 0, y: 0, width: 0.5, height: 0.5 } },
      { kind: "geometry", windowId: "200", rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 } },
    ];
    expect(overrideFor(overrides, w(200, 300))).toEqual(overrides[1]);
    expect(overrideFor(overrides, w(999, 1000))).toBeUndefined();
    expect(overrideFor(undefined, w(100, 200))).toBeUndefined();
  });
});

describe("resolvedCrop", () => {
  test("returns the override's rect when one matches, undefined otherwise", () => {
    const overrides: ZoomOverride[] = [
      { kind: "geometry", windowId: "100", rect: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 } },
    ];
    expect(resolvedCrop(overrides, w(100, 200))).toEqual({ x: 0.2, y: 0.2, width: 0.4, height: 0.4 });
    expect(resolvedCrop(overrides, w(500, 600))).toBeUndefined();
    expect(resolvedCrop(undefined, w(100, 200))).toBeUndefined();
  });
});

describe("resolvedEasingName", () => {
  test("falls back to the project preset when no override, or its easing is absent", () => {
    const noEasing: ZoomOverride[] = [{ kind: "geometry", windowId: "100", rect: { x: 0, y: 0, width: 1, height: 1 } }];
    expect(resolvedEasingName(noEasing, w(100, 200), "calm")).toBe("calm");
    expect(resolvedEasingName(undefined, w(100, 200), "snappy")).toBe("snappy");
  });

  test("uses the override's own easing when it names a real preset", () => {
    const withEasing: ZoomOverride[] = [
      { kind: "geometry", windowId: "100", rect: { x: 0, y: 0, width: 1, height: 1 }, easing: "snappy" },
    ];
    expect(resolvedEasingName(withEasing, w(100, 200), "calm")).toBe("snappy");
  });

  test("an override naming an easing this build does not have falls back, not throws", () => {
    // A hand-edited or future-build document — same "a name this build does
    // not have is a build nobody chose" rule zoom.preset already follows.
    const bogus = [
      { kind: "geometry", windowId: "100", rect: { x: 0, y: 0, width: 1, height: 1 }, easing: "extreme" },
    ] as unknown as ZoomOverride[];
    expect(resolvedEasingName(bogus, w(100, 200), "calm")).toBe("calm");
  });
});

describe("groupByEasing", () => {
  test("windows with no override all land in the project's own preset group", () => {
    const windows = [w(0, 100), w(1000, 1100), w(2000, 2100)];
    const groups = groupByEasing(windows, undefined, "standard");
    expect(groups.size).toBe(1);
    expect(groups.get("standard")).toEqual(windows);
  });

  test("an overridden easing splits its window into a different group", () => {
    const windows = [w(0, 100), w(1000, 1100), w(2000, 2100)];
    const overrides: ZoomOverride[] = [
      { kind: "geometry", windowId: "1000", rect: { x: 0, y: 0, width: 1, height: 1 }, easing: "snappy" },
    ];
    const groups = groupByEasing(windows, overrides, "standard");
    expect(groups.get("standard")).toEqual([windows[0], windows[2]]);
    expect(groups.get("snappy")).toEqual([windows[1]]);
  });

  test("group order within each group follows the original window order", () => {
    const windows = [w(0, 100), w(1000, 1100), w(2000, 2100), w(3000, 3100)];
    const overrides: ZoomOverride[] = [
      { kind: "geometry", windowId: "1000", rect: { x: 0, y: 0, width: 1, height: 1 }, easing: "calm" },
      { kind: "geometry", windowId: "3000", rect: { x: 0, y: 0, width: 1, height: 1 }, easing: "calm" },
    ];
    const groups = groupByEasing(windows, overrides, "standard");
    expect(groups.get("calm")).toEqual([windows[1], windows[3]]);
  });

  /**
   * The whole point of grouping rather than a per-tick lookup: composing the
   * independent group sims by max must agree with a single-preset sim over
   * the SAME windows, because that is the case grouping degenerates to when
   * no override changes any window's easing.
   */
  test("composing group sims by max agrees with the single-sim answer when no easing is overridden", () => {
    const windows = [w(1000 * MS, 3500 * MS), w(8000 * MS, 10500 * MS)];
    const singleSim = createZoomSim(windows, ZOOM_PRESETS.standard);
    const groups = groupByEasing(windows, undefined, "standard");
    expect(groups.size).toBe(1);
    const groupSim = createZoomSim(groups.get("standard")!, ZOOM_PRESETS.standard);
    for (let t = 0; t < 12000 * MS; t += 250 * MS) {
      const n = Math.floor(t / (1_000_000_000 / 120));
      expect(groupSim.amountAt(n)).toBeCloseTo(singleSim.amountAt(n), 12);
    }
  });
});

describe("nearestWindow", () => {
  const windows = [w(1000, 2000), w(5000, 6000), w(10000, 11000)];

  test("null when there are no windows at all", () => {
    expect(nearestWindow([], 5500)).toBeNull();
  });

  test("returns the window CONTAINING tNs when inside one", () => {
    expect(nearestWindow(windows, 1500)).toBe(windows[0]);
    expect(nearestWindow(windows, 5000)).toBe(windows[1]); // inclusive of the boundary
    expect(nearestWindow(windows, 11000)).toBe(windows[2]);
  });

  test("returns the closer neighbour when between windows", () => {
    expect(nearestWindow(windows, 2100)).toBe(windows[0]);  // closer to window 0's end
    expect(nearestWindow(windows, 4900)).toBe(windows[1]);  // closer to window 1's start
    expect(nearestWindow(windows, 3500)).toBe(windows[1]);  // exactly equidistant leans to "after" per <=
  });

  test("before the first window and after the last both resolve to a real neighbour", () => {
    expect(nearestWindow(windows, 0)).toBe(windows[0]);
    expect(nearestWindow(windows, 100000)).toBe(windows[2]);
  });

  test("a single window is always the answer, whatever tNs is", () => {
    const one = [w(1000, 2000)];
    expect(nearestWindow(one, 0)).toBe(one[0]);
    expect(nearestWindow(one, 1500)).toBe(one[0]);
    expect(nearestWindow(one, 1_000_000)).toBe(one[0]);
  });

  // STC-331: manual windows carry no promise of staying sorted or disjoint
  // against a derived one. These are the cases the old sorted-bisect
  // implementation could not have answered correctly even if handed them.
  describe("overlapping windows (STC-331)", () => {
    test("an EARLIER window that outlasts a LATER, smaller one is still found", () => {
      // A pattern the old bisect got wrong: window A starts first and ends
      // last; window B is fully nested inside it. tNs sits after B ends but
      // still inside A — the old "tNs > mid.endNs => search right" branch
      // would have skipped A here if B were probed first.
      const a = w(0, 1000);
      const b = w(100, 200);
      expect(nearestWindow([a, b], 500)).toBe(a);
      expect(nearestWindow([b, a], 500)).toBe(a); // order-independent
    });

    test("two windows both containing tNs resolve deterministically to the later-starting one", () => {
      const a = w(0, 1000);
      const b = w(400, 1400);
      expect(nearestWindow([a, b], 500)).toBe(b);
      expect(nearestWindow([b, a], 500)).toBe(b);
    });
  });
});

describe("rectFromGesture", () => {
  test("a bare click (a === b) produces a default-sized rect centred on the click", () => {
    const r = rectFromGesture({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, 16 / 9);
    // 16:9 (landscape): height is the short edge, so it gets the fraction
    // directly; width is divided by the aspect so the rect is SQUARE in real
    // pixels (a UV square on a landscape frame would be visually wide).
    expect(r.height).toBeCloseTo(DEFAULT_OVERRIDE_RECT_FRACTION, 10);
    expect(r.width).toBeCloseTo(DEFAULT_OVERRIDE_RECT_FRACTION / (16 / 9), 10);
    expect(r.x + r.width / 2).toBeCloseTo(0.5, 10);
    expect(r.y + r.height / 2).toBeCloseTo(0.5, 10);
  });

  test("a drag under MIN_DRAG_UV on both axes is treated as a click", () => {
    const r = rectFromGesture({ x: 0.5, y: 0.5 }, { x: 0.5 + MIN_DRAG_UV / 2, y: 0.5 }, 1);
    expect(r.width).toBeCloseTo(DEFAULT_OVERRIDE_RECT_FRACTION, 10);
    expect(r.height).toBeCloseTo(DEFAULT_OVERRIDE_RECT_FRACTION, 10);
  });

  test("a real drag produces the normalised drag rect, order-independent", () => {
    const a = rectFromGesture({ x: 0.2, y: 0.3 }, { x: 0.6, y: 0.7 }, 1);
    const b = rectFromGesture({ x: 0.6, y: 0.7 }, { x: 0.2, y: 0.3 }, 1);
    expect(a.x).toBeCloseTo(0.2, 10);
    expect(a.y).toBeCloseTo(0.3, 10);
    expect(a.width).toBeCloseTo(0.4, 10);
    expect(a.height).toBeCloseTo(0.4, 10);
    expect(b).toEqual(a);
  });

  test("a click-default near the frame edge clamps into the frame rather than overflowing", () => {
    const r = rectFromGesture({ x: 0.02, y: 0.02 }, { x: 0.02, y: 0.02 }, 1);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x + r.width).toBeLessThanOrEqual(1 + 1e-9);
    expect(r.y + r.height).toBeLessThanOrEqual(1 + 1e-9);
  });

  test("a drag that leaves the frame clamps to it", () => {
    const r = rectFromGesture({ x: -0.2, y: -0.2 }, { x: 1.3, y: 1.3 }, 1);
    expect(r).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  test("a portrait-ish aspect makes width the short edge", () => {
    const r = rectFromGesture({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, 9 / 16);
    expect(r.width).toBeCloseTo(DEFAULT_OVERRIDE_RECT_FRACTION, 10);
    expect(r.height).toBeCloseTo(DEFAULT_OVERRIDE_RECT_FRACTION * (9 / 16), 10);
  });
});

// ---------------------------------------------------------------------------
// STC-331: a window with no derived counterpart at all
// ---------------------------------------------------------------------------

describe("manualWindows", () => {
  test("undefined or empty overrides produce no windows", () => {
    expect(manualWindows(undefined)).toEqual([]);
    expect(manualWindows([])).toEqual([]);
  });

  test("a manual entry becomes a ZoomWindow-shaped window carrying the override", () => {
    const o = manual("m1", 1000, 5000, { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, "snappy");
    const [win] = manualWindows([o]);
    expect(win).toEqual({ startNs: 1000, endNs: 5000, events: [], manual: o });
  });

  test("a geometry override contributes no manual window", () => {
    const geometry: ZoomOverride = { kind: "geometry", windowId: "1000", rect: { x: 0, y: 0, width: 1, height: 1 } };
    expect(manualWindows([geometry])).toEqual([]);
  });

  test("mixed overrides: only the manual entries come back, in order", () => {
    const geometry: ZoomOverride = { kind: "geometry", windowId: "1000", rect: { x: 0, y: 0, width: 1, height: 1 } };
    const m1 = manual("m1", 0, 100);
    const m2 = manual("m2", 200, 300);
    const windows = manualWindows([geometry, m1, geometry, m2]);
    expect(windows.map((w) => w.manual!.id)).toEqual(["m1", "m2"]);
  });
});

describe("resolvedCrop / resolvedEasingName with a manual window", () => {
  test("a manual window's own rect and easing win outright, with no overrides-table lookup", () => {
    const [win] = manualWindows([manual("m1", 0, 1000, { x: 0.3, y: 0.4, width: 0.1, height: 0.2 }, "calm")]);
    // Overrides table has nothing matching windowId "0" — proves the crop
    // came from `.manual`, not from an accidental geometry-style lookup.
    expect(resolvedCrop(undefined, win!)).toEqual({ x: 0.3, y: 0.4, width: 0.1, height: 0.2 });
    expect(resolvedEasingName(undefined, win!, "snappy")).toBe("calm");
  });

  test("a derived window (no .manual) is unaffected — falls through to the existing geometry lookup", () => {
    const derived: CombinedZoomWindow = w(100, 200);
    const overrides: ZoomOverride[] = [
      { kind: "geometry", windowId: "100", rect: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 } },
    ];
    expect(resolvedCrop(overrides, derived)).toEqual({ x: 0.5, y: 0.5, width: 0.1, height: 0.1 });
    expect(resolvedEasingName(overrides, derived, "standard")).toBe("standard"); // no easing on the override
  });
});

describe("groupByEasing mixes derived and manual windows", () => {
  test("a manual window lands in the group its OWN easing names, never the project preset", () => {
    const derived = [w(0, 100)];
    const [m] = manualWindows([manual("m1", 5000, 6000, undefined, "snappy")]);
    const groups = groupByEasing([...derived, m!], undefined, "calm");
    expect(groups.get("calm")).toEqual(derived);
    expect(groups.get("snappy")).toEqual([m]);
  });
});

describe("inWindow (zoom.ts) under overlap — STC-331's own concern, exercised from here", () => {
  test("an earlier, longer window still reports true past a nested later one's end", () => {
    const windows = [w(0, 1000), w(100, 200)];
    expect(inWindow(windows, 500)).toBe(true);
    expect(inWindow([...windows].reverse(), 500)).toBe(true);
  });
});
