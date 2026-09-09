import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEvent } from "../src/types.js";
import { tickOf } from "../src/time.js";
import {
  createZoomSim, inWindow, zoomWindows, DEFAULT_ZOOM_PRESET, ZOOM_HOLD_NS,
  ZOOM_LEAD_NS, ZOOM_MERGE_GAP_NS, ZOOM_PRESETS, ZOOM_PRESET_NAMES,
  ZOOM_CHECKPOINT_INTERVAL,
} from "../src/zoom.js";

const MS = 1_000_000;
const at = (ms: number) => ms * MS;

const move = (ms: number, x = 0, y = 0): SessionEvent => ({ t: at(ms), kind: "move", x, y });
const down = (ms: number, x = 0, y = 0): SessionEvent => ({ t: at(ms), kind: "down", x, y, button: 0 });
const up = (ms: number, x = 0, y = 0): SessionEvent => ({ t: at(ms), kind: "up", x, y, button: 0 });

/** A drag: down, moves at 60 Hz for `ms`, up. */
function drag(startMs: number, ms: number): SessionEvent[] {
  const out: SessionEvent[] = [down(startMs)];
  for (let t = startMs + 16; t < startMs + ms; t += 16) out.push(move(t));
  out.push(up(startMs + ms));
  return out;
}

describe("zoomWindows — the locked rule: 300 ms before, 2500 ms after, merge under 2500", () => {
  test("one click is one window with the lead and the hold", () => {
    const w = zoomWindows([down(5000), up(5050)]);
    expect(w).toHaveLength(1);
    expect(w[0]!.startNs).toBe(at(5000) - ZOOM_LEAD_NS);
    expect(w[0]!.endNs).toBe(at(5050) + ZOOM_HOLD_NS);
  });

  test("no events, and motion-only takes, ask for no zoom at all", () => {
    // The Music Network property: a take that is continuous pointer motion
    // must not zoom. STC-313 says if it does, the feature is wrong.
    expect(zoomWindows([])).toEqual([]);
    const motion = Array.from({ length: 600 }, (_, i) => move(i * 16, i, i));
    expect(zoomWindows(motion)).toEqual([]);
  });

  test("a cursor-shape event is not activity", () => {
    expect(zoomWindows([{ t: at(1000), kind: "cursor", shape: "ibeam" }])).toEqual([]);
  });

  test("two clicks 1 s apart merge into one window", () => {
    const w = zoomWindows([down(1000), up(1050), down(2000), up(2050)]);
    expect(w).toHaveLength(1);
    expect(w[0]!.startNs).toBe(at(1000) - ZOOM_LEAD_NS);
    expect(w[0]!.endNs).toBe(at(2050) + ZOOM_HOLD_NS);
    expect(w[0]!.events).toHaveLength(4);
  });

  test("clicks far apart stay separate", () => {
    const w = zoomWindows([down(1000), up(1050), down(30_000), up(30_050)]);
    expect(w).toHaveLength(2);
    expect(w[0]!.endNs).toBe(at(1050) + ZOOM_HOLD_NS);
    expect(w[1]!.startNs).toBe(at(30_000) - ZOOM_LEAD_NS);
  });

  test("the merge boundary is exactly at the gap, and is inclusive", () => {
    // Two isolated clicks whose windows sit exactly ZOOM_MERGE_GAP_NS apart.
    // gap = (b - LEAD) - (a + HOLD), so b - a = GAP + LEAD + HOLD.
    const aMs = 1000;
    const exactMs = aMs + (ZOOM_MERGE_GAP_NS + ZOOM_LEAD_NS + ZOOM_HOLD_NS) / MS;
    expect(zoomWindows([down(aMs), down(exactMs)])).toHaveLength(1);
    expect(zoomWindows([down(aMs), down(exactMs + 1)])).toHaveLength(2);
  });

  test("A DRAG IS ONE WINDOW, however long — not one per move", () => {
    // The ticket's case, and the reason moves only count while a button is
    // held. A 12-second drag is far longer than the hold, so this passes only
    // because the drag's own moves keep re-triggering.
    const w = zoomWindows(drag(2000, 12_000));
    expect(w).toHaveLength(1);
    expect(w[0]!.startNs).toBe(at(2000) - ZOOM_LEAD_NS);
    expect(w[0]!.endNs).toBe(at(14_000) + ZOOM_HOLD_NS);
  });

  test("a control: the same moves WITHOUT the button produce nothing", () => {
    // Differs from the case above by exactly the thing under test. Without
    // this, "a drag is one window" is also satisfied by counting every move.
    const held = drag(2000, 12_000);
    const loose = held.filter((e) => e.kind === "move");
    expect(zoomWindows(held)).toHaveLength(1);
    expect(zoomWindows(loose)).toEqual([]);
  });

  test("a click during an open window joins it rather than starting another", () => {
    const w = zoomWindows([down(1000), up(1050), down(1800), up(1850)]);
    expect(w).toHaveLength(1);
    expect(w[0]!.events.map((e) => e.kind)).toEqual(["down", "up", "down", "up"]);
  });

  test("a take that begins mid-drag does not go negative, and depth cannot go under zero", () => {
    // An `up` with no `down` — a take started while a button was already held.
    // Depth must clamp, or a later move would read as a drag forever.
    const w = zoomWindows([up(100), move(200), move(300)]);
    expect(w).toHaveLength(1);
    expect(w[0]!.startNs).toBe(0);
    expect(w[0]!.events).toHaveLength(1);   // the up only; the moves are loose
  });

  test("unsorted input gives the same answer as sorted", () => {
    const evs = [down(5000), up(1050), down(1000), up(5050)];
    expect(zoomWindows(evs)).toEqual(zoomWindows([...evs].sort((a, b) => a.t - b.t)));
  });

  test("windows come out sorted and disjoint", () => {
    const w = zoomWindows([...drag(1000, 500), down(20_000), down(60_000), ...drag(61_000, 3000)]);
    for (let i = 1; i < w.length; i++) {
      expect(w[i]!.startNs).toBeGreaterThan(w[i - 1]!.endNs);
    }
  });
});

describe("inWindow", () => {
  const w = zoomWindows([down(10_000), down(40_000)]);

  test("edges are inclusive, outside is outside", () => {
    expect(inWindow(w, w[0]!.startNs)).toBe(true);
    expect(inWindow(w, w[0]!.endNs)).toBe(true);
    expect(inWindow(w, w[0]!.startNs - 1)).toBe(false);
    expect(inWindow(w, w[0]!.endNs + 1)).toBe(false);
  });

  test("the gap between two windows is out", () => {
    expect(inWindow(w, (w[0]!.endNs + w[1]!.startNs) / 2)).toBe(false);
  });
});

describe("the easing spring", () => {
  const windows = zoomWindows([down(10_000), up(10_050)]);

  test("rests at 0 before the first window and rises inside one", () => {
    const sim = createZoomSim(windows);
    const open = tickOf(windows[0]!.startNs);
    expect(sim.amountAt(0)).toBe(0);
    // Flat zero right up to the tick before the window, then moving. It is
    // already 0.0069 at `open` itself and that is correct rather than sloppy:
    // tickOf gives the tick CONTAINING startNs, and one 120 Hz step at
    // omega 10 from rest is omega^2 * dt^2 = 100/14400. An assertion of ~0
    // there was this test being wrong about its own model.
    expect(sim.amountAt(open - 1)).toBe(0);
    expect(sim.amountAt(open)).toBeGreaterThan(0);
    expect(sim.amountAt(open)).toBeLessThan(0.01);
    // one second in, Standard (~470 ms settle) is essentially all the way there
    expect(sim.amountAt(tickOf(windows[0]!.startNs + 1000 * MS))).toBeGreaterThan(0.99);
  });

  test("comes back to 0 after the window closes", () => {
    const sim = createZoomSim(windows);
    expect(sim.amountAt(tickOf(windows[0]!.endNs + 2000 * MS))).toBeLessThan(0.01);
  });

  test("no preset overshoots — a zoom that bounces reads as a bug", () => {
    for (const name of ZOOM_PRESET_NAMES) {
      const sim = createZoomSim(windows, ZOOM_PRESETS[name]);
      let peak = 0;
      for (let n = 0; n < tickOf(windows[0]!.endNs); n++) peak = Math.max(peak, sim.amountAt(n));
      expect(peak, `${name} overshot to ${peak}`).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  test("the presets are ordered: snappy reaches a given point before calm", () => {
    const half = (name: keyof typeof ZOOM_PRESETS) => {
      const sim = createZoomSim(windows, ZOOM_PRESETS[name]);
      const from = tickOf(windows[0]!.startNs);
      for (let n = from; n < from + 2000; n++) if (sim.amountAt(n) >= 0.5) return n - from;
      return Infinity;
    };
    expect(half("snappy")).toBeLessThan(half("standard"));
    expect(half("standard")).toBeLessThan(half("calm"));
  });

  test("SEEK EQUALS STEP, bit for bit, across checkpoint boundaries", () => {
    // The non-negotiable, in this module's terms: a sink that seeks must get
    // the identical float to one that stepped there. Deliberately spans
    // several checkpoints — a bug in the checkpoint arithmetic is invisible
    // inside the first 1024 ticks.
    const long = zoomWindows([down(1000), down(30_000), ...drag(45_000, 4000)]);
    const stepped = createZoomSim(long);
    const last = ZOOM_CHECKPOINT_INTERVAL * 6;
    const walked: number[] = [];
    for (let n = 0; n <= last; n++) walked.push(stepped.amountAt(n));

    for (const n of [0, 1, 1023, 1024, 1025, 2048, 4095, 5000, last]) {
      const fresh = createZoomSim(long);          // no warmed checkpoints
      expect(fresh.amountAt(n), `tick ${n}`).toBe(walked[n]!);
    }
  });

  test("a sim with no windows is flat zero forever", () => {
    const sim = createZoomSim([]);
    for (const n of [0, 1, 10_000]) expect(sim.amountAt(n)).toBe(0);
  });

  test("the default preset is one of the named ones", () => {
    expect(ZOOM_PRESET_NAMES).toContain(DEFAULT_ZOOM_PRESET);
  });
});

describe("the committed fixtures, pinned", () => {
  function eventsOf(fixture: string): SessionEvent[] {
    const raw = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "fixtures", fixture, "events.json"), "utf8"),
    );
    return raw.events as SessionEvent[];
  }

  test("fixtures/basic: the windows are what they are, and they are stable", () => {
    const w = zoomWindows(eventsOf("basic"));
    // Derived, not pasted from a run: the fixture has exactly one click —
    // down at 2005 ms, up at 2155 ms, and 120 moves that are all loose — so
    // the single window is [2005 - 300, 2155 + 2500] ms. Pinned so a change
    // to the rule has to be deliberate; if it moves, say why in
    // TRANSFORM_HISTORY, because it changes every export's zoom.
    expect(w.map((x) => [x.startNs, x.endNs])).toEqual([[1_705_000_000, 4_655_000_000]]);
    // The fixture's click is actually a small DRAG — 4 moves between the down
    // and the up — so this doubles as drag-move detection firing on committed
    // data rather than only on events this test made up. (The window is the
    // same either way, since those moves fall between the two buttons.)
    expect(w[0]!.events.map((e) => e.kind)).toEqual(["down", "move", "move", "move", "move", "up"]);
  });

  test("fixtures/real-session-cursor: a real take, and it does not zoom throughout", () => {
    // The property that matters more than the numbers: a real recording of a
    // person using a computer must not be one continuous window, or the
    // feature is a no-op that always zooms.
    const events = eventsOf("real-session-cursor");
    const w = zoomWindows(events);
    const span = events[events.length - 1]!.t - events[0]!.t;
    const covered = w.reduce((s, x) => s + (x.endNs - x.startNs), 0);
    expect(w.length).toBeGreaterThan(0);
    expect(covered).toBeLessThan(span);
  });
});
