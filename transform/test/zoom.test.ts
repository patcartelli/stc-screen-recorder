import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHECKPOINT_INTERVAL, DEFAULT_ZOOM, EASING_PRESETS, FULL_FRAME, HOLD_NS, LEAD_NS,
  MERGE_GAP_NS, createZoomSim, parseEasing, zoomCrop, zoomWindows,
} from "../src/zoom.js";
import type { SessionEvent } from "../src/types.js";
import { tickOf } from "../src/time.js";
import { render } from "../src/render.js";

/**
 * STC-325 — auto-zoom stage 1. When to zoom, and nothing about where.
 */

const MS = 1_000_000;
const click = (t: number, x = 100, y = 100): SessionEvent[] => [
  { t: t * MS, kind: "down", x, y, button: 0 },
  { t: t * MS + 80 * MS, kind: "up", x, y, button: 0 },
];
const move = (t: number, x = 0, y = 0): SessionEvent => ({ t: t * MS, kind: "move", x, y });
const ms = (ns: number) => ns / MS;

describe("the four merge cases the ticket names", () => {
  /**
   * Two clicks 1 s apart are ONE window. The gap between their spans is
   * negative — the first is still open when the second opens — so this is the
   * easy end of the merge rule, and it is the case a viewer would most
   * obviously notice getting wrong.
   */
  test("two clicks 1 s apart make one window", () => {
    const w = zoomWindows([...click(1000), ...click(2000)]);
    expect(w).toHaveLength(1);
    expect(ms(w[0]!.startNs)).toBe(1000 - 300);
    expect(ms(w[0]!.endNs)).toBe(2080 + 2500);
    // All four triggers are recorded, in time order.
    expect(w[0]!.events.map((e) => ms(e.t))).toEqual([1000, 1080, 2000, 2080]);
  });

  test("a burst of clicks is one window, not one each", () => {
    const burst = [0, 200, 400, 600, 800].flatMap((t) => click(1000 + t));
    const w = zoomWindows(burst);
    expect(w).toHaveLength(1);
    expect(w[0]!.events).toHaveLength(10);
  });

  /**
   * A drag is one window, and — the point worth pinning — it is one window
   * WITHOUT a drag-detecting branch. Both ends of the gesture are triggers and
   * the merge rule does the rest.
   */
  test("a drag is one window, by the merge rule and not by a special case", () => {
    const drag: SessionEvent[] = [
      { t: 1000 * MS, kind: "down", x: 10, y: 10, button: 0 },
      move(1200, 50, 50), move(1400, 90, 90), move(1600, 130, 130),
      { t: 6000 * MS, kind: "up", x: 170, y: 170, button: 0 },
    ];
    const w = zoomWindows(drag);
    expect(w).toHaveLength(1);
    expect(ms(w[0]!.startNs)).toBe(700);
    expect(ms(w[0]!.endNs)).toBe(8500);
    // The moves are not triggers and are not carried.
    expect(w[0]!.events.every((e) => e.kind === "down" || e.kind === "up")).toBe(true);
    expect(w[0]!.events).toHaveLength(2);
  });

  test("a click during an open window extends it rather than starting another", () => {
    const w = zoomWindows([...click(1000), ...click(1500)]);
    expect(w).toHaveLength(1);
    expect(ms(w[0]!.endNs)).toBe(1580 + 2500);
  });
});

describe("what does NOT open a window", () => {
  /**
   * The whole change-track amendment exists because deriving attention from
   * cursor movement fails on the interfaces this tool demos. A take that is
   * nothing but movement must produce no windows at all.
   */
  test("movement alone never zooms", () => {
    const moves = Array.from({ length: 500 }, (_, i) => move(i * 20, i, i));
    expect(zoomWindows(moves)).toEqual([]);
  });

  test("an empty take has no windows", () => {
    expect(zoomWindows([])).toEqual([]);
  });
});

describe("the boundaries, which are decisions rather than arithmetic", () => {
  test("a gap of exactly MERGE_GAP_NS merges; one nanosecond more does not", () => {
    // Second click placed so its start lands exactly MERGE_GAP_NS after the
    // first window's end.
    const firstEnd = 1000 * MS + HOLD_NS;
    const exact = firstEnd + MERGE_GAP_NS + LEAD_NS;
    const merged = zoomWindows([
      { t: 1000 * MS, kind: "down", x: 0, y: 0, button: 0 },
      { t: exact, kind: "down", x: 0, y: 0, button: 0 },
    ]);
    expect(merged).toHaveLength(1);

    const apart = zoomWindows([
      { t: 1000 * MS, kind: "down", x: 0, y: 0, button: 0 },
      { t: exact + 1, kind: "down", x: 0, y: 0, button: 0 },
    ]);
    expect(apart).toHaveLength(2);
  });

  /**
   * A long drag SPLITS, and that is deliberate — the middle of a ten-second
   * drag is travel, not an event. Pinned so that if someone later decides a
   * drag should always be one window, they change it knowingly.
   */
  test("a long drag splits into two windows, deliberately", () => {
    const w = zoomWindows([
      { t: 0, kind: "down", x: 0, y: 0, button: 0 },
      { t: 10_000 * MS, kind: "up", x: 0, y: 0, button: 0 },
    ]);
    expect(w).toHaveLength(2);
  });

  test("a window never starts before the recording does", () => {
    const w = zoomWindows([{ t: 100 * MS, kind: "down", x: 0, y: 0, button: 0 }]);
    expect(w[0]!.startNs).toBe(0);
  });

  test("out-of-order events are sorted rather than trusted", () => {
    // Far enough apart to stay two windows: 1000 and 9000 leaves a 5.2 s gap.
    // The first draft used 1000 and 5000, which correctly MERGED (a 1.2 s gap)
    // and so proved nothing about ordering — a test that cannot fail for the
    // reason it names.
    const w = zoomWindows([
      { t: 9000 * MS, kind: "down", x: 0, y: 0, button: 0 },
      { t: 1000 * MS, kind: "down", x: 0, y: 0, button: 0 },
    ]);
    expect(w).toHaveLength(2);
    expect(w[0]!.startNs).toBeLessThan(w[1]!.startNs);
    expect(ms(w[0]!.startNs)).toBe(700);
    expect(ms(w[1]!.startNs)).toBe(8700);
  });
});

describe("the spring", () => {
  const windows = zoomWindows(click(1000));

  test("starts at rest and out, and comes in while the window is open", () => {
    const sim = createZoomSim(windows);
    expect(sim.amountAt(0)).toBe(0);
    // Well inside the window, standard easing: essentially all the way in.
    expect(sim.amountAt(tickOf(2000 * MS))).toBeGreaterThan(0.99);
  });

  test("returns to the full frame after the window closes", () => {
    const sim = createZoomSim(windows);
    const afterNs = windows[0]!.endNs + 2_000 * MS;
    expect(sim.amountAt(tickOf(afterNs))).toBeLessThan(0.01);
  });

  /**
   * The property the whole 120 Hz discipline exists for, and the one the
   * non-negotiable rests on: preview and export walk different `t` sequences
   * over one trajectory, so a seek must land bit-for-bit where stepping would
   * have. Checked ACROSS a checkpoint boundary, since that is the only place
   * the two paths differ in what they execute.
   */
  test("seek equals step, bit for bit, across a checkpoint boundary", () => {
    const target = CHECKPOINT_INTERVAL * 2 + 37;
    const stepped = createZoomSim(windows);
    for (let n = 0; n <= target; n++) stepped.amountAt(n);
    const seeking = createZoomSim(windows);
    expect(seeking.amountAt(target)).toBe(stepped.amountAt(target));
  });

  test("a repeated query is identical, not merely close", () => {
    const sim = createZoomSim(windows);
    const n = tickOf(1500 * MS);
    expect(sim.amountAt(n)).toBe(sim.amountAt(n));
  });

  /**
   * Critically damped means no overshoot — which is why the presets are single
   * stiffnesses rather than the stiffness/damping pairs the ticket asks for.
   * A zoom that overshoots and settles reads as a wobble, and this is the
   * assertion that would catch someone loosening the damping.
   */
  test("never overshoots, on any preset", () => {
    for (const easing of ["calm", "standard", "snappy"] as const) {
      const sim = createZoomSim(zoomWindows(click(500)), easing);
      for (let n = 0; n < tickOf(6000 * MS); n++) {
        const a = sim.amountAt(n);
        expect(a, `${easing} at tick ${n}`).toBeGreaterThanOrEqual(0);
        expect(a, `${easing} at tick ${n}`).toBeLessThanOrEqual(1);
      }
    }
  });

  test("snappier presets arrive sooner, which is the only thing the names promise", () => {
    const at = (easing: "calm" | "standard" | "snappy") =>
      createZoomSim(zoomWindows(click(1000)), easing).amountAt(tickOf(1200 * MS));
    expect(at("snappy")).toBeGreaterThan(at("standard"));
    expect(at("standard")).toBeGreaterThan(at("calm"));
  });

  test("no windows means no motion, ever", () => {
    const sim = createZoomSim([]);
    for (const n of [0, 1, 100, CHECKPOINT_INTERVAL + 1, 10_000]) {
      expect(sim.amountAt(n)).toBe(0);
    }
  });
});

describe("the crop, while stage 2 is stubbed", () => {
  /**
   * THE safety property of this whole slice: with a full-frame target the crop
   * is the identity at every amount, so the derivation can run on every take
   * without moving a pixel. `gate:identity` is the same claim on real pixels;
   * this is it in arithmetic, so a failure says which of the two broke.
   */
  test("is the identity at every amount", () => {
    for (const a of [0, 0.001, 0.25, 0.5, 0.75, 0.999, 1]) {
      expect(zoomCrop(a)).toEqual(FULL_FRAME);
    }
  });

  test("interpolates toward a target once stage 2 supplies one", () => {
    const target = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
    expect(zoomCrop(0, target)).toEqual(FULL_FRAME);
    expect(zoomCrop(1, target)).toEqual(target);
    const half = zoomCrop(0.5, target);
    expect(half.x).toBeCloseTo(0.125, 10);
    expect(half.width).toBeCloseTo(0.75, 10);
  });
});

describe("the easing presets", () => {
  test("parse defensively, like every other stored preference", () => {
    expect(parseEasing("calm")).toBe("calm");
    expect(parseEasing("nonsense")).toBe("standard");
    expect(parseEasing(undefined)).toBe("standard");
    expect(parseEasing(14)).toBe("standard");
  });

  test("the default is one of them, and the default zoom uses it", () => {
    expect(EASING_PRESETS[DEFAULT_ZOOM.easing]).toBeGreaterThan(0);
  });

  /**
   * The schema's enum and this table must name the same three presets — the
   * `CURSOR_SHAPES` rule, applied to the second list in the codebase that has
   * a schema counterpart. A preset added to one and not the other is a
   * document that validates and renders as the default.
   */
  test("the schema's enum equals this table's keys", () => {
    const root = join(__dirname, "..", "..");
    const schema = JSON.parse(readFileSync(join(root, "schema", "project-4.schema.json"), "utf8"));
    expect([...schema.properties.zoom.properties.easing.enum].sort())
      .toEqual(Object.keys(EASING_PRESETS).sort());
  });
});

/**
 * Goldens of NUMBERS, from the two real takes committed in this repo.
 *
 * The ticket says to tune on "the Music Network take" and "the form fixture".
 * Neither exists — Music Network is STC-313 and has not been recorded, and no
 * form fixture was ever made. These two ARE real recordings with real click
 * rhythm, already pinned here for the cursor's sake, so they are what stage 1
 * is measured against rather than a stream I invented and then agreed with.
 *
 * What they cannot cover is stated rather than glossed: neither is a
 * continuous-motion take, so "Music Network should mostly decide NOT to zoom"
 * — the parent ticket's own hardest test — stays unverified until that take
 * exists.
 */
/**
 * The gate's claim, in arithmetic.
 *
 * `gate:identity` is stage 1's stated acceptance — the derivation runs with
 * zoom on and the pixels must not move — and it needs real Chrome for its
 * H.264 decoder, so it runs on CI and not here. What CAN be checked here is
 * the property the gate would be measuring: with stage 2 stubbed, a render
 * with zoom ON and one with zoom OFF differ in `zoom.amount` and in nothing
 * else. If that holds, no pixel can move; if it fails, the gate would fail too
 * and this says so in a second rather than in a browser.
 */
describe("zoom on and zoom off render the same frame (stage 2 stubbed)", () => {
  const anchors = {
    version: 2, timebase: { numer: 125, denom: 3 }, t0Ns: "0",
    display: { id: 1, pointWidth: 1920, pointHeight: 1080, pixelWidth: 1920,
               pixelHeight: 1080, backingScale: 1, originX: 0, originY: 0 },
    capture: { width: 1920, height: 1080, codec: "h264", firstFrameNs: 0 },
    files: { display: "display.mp4" }, stop: { t: 12_000_000_000, reason: "user" },
  } as never;
  const events = [...click(1000), ...click(4000)];
  const session = { anchors, events, frames: [0, 16_000_000, 32_000_000] } as never;
  const base = {
    version: 3 as const, output: { fps: 60 as const, width: 1920, height: 1080 },
    cursor: { style: "default" as const, scale: 1 },
    transform: { version: 3 },
  };

  test("every field but zoom.amount is identical, at every sampled tick", () => {
    const on = { ...base, zoom: { enabled: true, intensity: 1, easing: "standard" as const } };
    const off = { ...base, zoom: { enabled: false, intensity: 1, easing: "standard" as const } };
    for (let tNs = 0; tNs < 8_000 * MS; tNs += 97 * MS) {
      const a = render(on, session, tNs);
      const b = render(off, session, tNs);
      expect({ ...a, zoom: null }).toEqual({ ...b, zoom: null });
      // The crop is the identity on BOTH, which is what makes the pixels safe.
      expect(a.zoom.crop).toEqual(FULL_FRAME);
      expect(b.zoom.crop).toEqual(FULL_FRAME);
    }
  });

  test("and the amount really did move, so the check is not vacuous", () => {
    const on = { ...base, zoom: { enabled: true, intensity: 1, easing: "standard" as const } };
    const amounts = [];
    for (let tNs = 0; tNs < 8_000 * MS; tNs += 97 * MS) {
      amounts.push(render(on, session, tNs).zoom.amount);
    }
    // Without this the test above would pass just as well with the whole
    // derivation deleted — the vacuous-clearance shape this repo keeps meeting.
    expect(Math.max(...amounts)).toBeGreaterThan(0.9);
    expect(Math.min(...amounts)).toBeLessThan(0.1);
  });
});

describe("real takes", () => {
  const root = join(__dirname, "..", "..");
  const load = (name: string): SessionEvent[] =>
    JSON.parse(readFileSync(join(root, "fixtures", name, "events.json"), "utf8")).events;
  const triggersOf = (ev: SessionEvent[]) =>
    ev.filter((e) => e.kind === "down" || e.kind === "up");

  /**
   * **The finding, which is about the fixtures rather than the code.**
   *
   * `real-session` is 30 triggers between 248 ms and 8101 ms — a click roughly
   * every 250-400 ms, because it was recorded to pin click and drag semantics
   * and not to look like a demo. Every gap is far under `MERGE_GAP_NS`, so
   * stage 1 correctly answers "zoomed for the whole take": ONE window.
   *
   * That is the merge rule doing its job on a dense stream, and it is worth
   * more as an assertion than a tidier number would be — 30 triggers becoming
   * 30 windows is precisely the pull-out-and-back-in artefact the merge exists
   * to prevent.
   *
   * The bounds are DERIVED from the fixture's own first and last trigger
   * rather than transcribed from a run — `start = max(0, first − LEAD)` and
   * `end = last + HOLD`. Real event times are not round milliseconds (the
   * first draft asserted 10601 against 10601.397917), and a golden copied out
   * of the output is only a note of what the code did on the day; a
   * relationship still fails if a constant or the merge rule moves.
   */
  test("real-session: 30 triggers collapse to ONE window", () => {
    const events = load("real-session");
    const trig = triggersOf(events);
    expect(trig).toHaveLength(30);
    const w = zoomWindows(events);
    expect(w).toHaveLength(1);
    expect(w[0]!.startNs).toBe(Math.max(0, trig[0]!.t - LEAD_NS));
    expect(w[0]!.endNs).toBe(trig[trig.length - 1]!.t + HOLD_NS);
    expect(w[0]!.events).toHaveLength(30);
    // And the clamp really bound here: the first click is 248 ms in, inside
    // the 300 ms lead, so this take's window starts at zero.
    expect(w[0]!.startNs).toBe(0);
    expect(Math.round(ms(w[0]!.endNs))).toBe(10601);
  });

  /** Same shape; here the first click is 5.3 s in, so nothing clamps. */
  test("real-session-cursor: 12 triggers, also one window", () => {
    const events = load("real-session-cursor");
    const trig = triggersOf(events);
    expect(trig).toHaveLength(12);
    const w = zoomWindows(events);
    expect(w).toHaveLength(1);
    expect(w[0]!.startNs).toBe(trig[0]!.t - LEAD_NS);
    expect(w[0]!.endNs).toBe(trig[trig.length - 1]!.t + HOLD_NS);
    expect(Math.round(ms(w[0]!.startNs))).toBe(5037);
    expect(Math.round(ms(w[0]!.endNs))).toBe(13837);
    // It does NOT start at 0: the first click is 5.3 s in, and the take before
    // that is unzoomed. A window that began at the take's start would mean the
    // lead had been applied to the recording rather than to the event.
    expect(w[0]!.startNs).toBeGreaterThan(0);
  });

  /**
   * What these fixtures CANNOT settle, stated rather than glossed.
   *
   * Neither is continuous-motion, so the parent ticket's hardest test — "the
   * Music Network take should mostly decide NOT to zoom" — is unverified here
   * and stays that way until STC-313 records it. What this asserts instead is
   * the half that is checkable now: a stream with no clicks produces no
   * windows, whatever else is in it.
   */
  test("a real take's moves alone would produce nothing", () => {
    const movesOnly = load("real-session").filter((e) => e.kind === "move");
    expect(movesOnly.length).toBeGreaterThan(100);
    expect(zoomWindows(movesOnly)).toEqual([]);
  });

  test("the spring stays in range over a whole real take", () => {
    const events = load("real-session");
    const sim = createZoomSim(zoomWindows(events));
    const lastNs = Math.max(...events.map((e) => e.t));
    for (let n = 0; n <= tickOf(lastNs); n += 7) {
      const a = sim.amountAt(n);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
    }
  });
});
