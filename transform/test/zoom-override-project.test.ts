import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";
import { DEFAULT_ZOOM, defaultProject, parseProject, projectForWrite } from "../src/trim.js";
import { render } from "../src/render.js";
import type { Project, Session, SessionEvent } from "../src/types.js";

/**
 * project-6 (STC-330): the document half of manual zoom overrides — schema,
 * parseProject/projectForWrite, and render() actually reading the table.
 * `zoom-override.test.ts` covers the pure resolution logic in isolation
 * (`overrideFor`, `nearestWindow`, `groupByEasing`, `rectFromGesture`); this
 * file is the same shape `zoom-settings.test.ts` set for project-4 — the
 * document round trip and the wiring into a real render.
 */

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const schema6 = JSON.parse(readFileSync(join(root, "schema", "project-6.schema.json"), "utf8"));
const validate6 = new Ajv({ allErrors: true, strict: false }).compile(schema6);
const duration = 12_000_000_000;

const baseDoc = (overrides?: unknown) => ({
  version: 6, output: { fps: 60, width: 640, height: 360 },
  cursor: { style: "default", scale: 1 }, transform: { version: 4 },
  ...(overrides !== undefined ? { overrides } : {}),
});

describe("parseProject", () => {
  test("fills [] on a document that predates overrides", () => {
    const v5 = { version: 5, output: { fps: 60, width: 640, height: 360 },
                 cursor: { style: "default", scale: 1 }, transform: { version: 3 } };
    expect(parseProject(v5, 640, 360, duration).overrides).toEqual([]);
  });

  test("every path returns the same shape, including the early return", () => {
    expect(parseProject(null, 640, 360, duration).overrides).toEqual([]);
    expect(defaultProject(640, 360).overrides).toEqual([]);
  });

  test("carries a well-formed override", () => {
    const doc = baseDoc([
      { kind: "geometry", windowId: "1000", rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, easing: "snappy" },
    ]);
    expect(parseProject(doc, 640, 360, duration).overrides).toEqual([
      { kind: "geometry", windowId: "1000", rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, easing: "snappy" },
    ]);
  });

  test("an override missing easing is fine — it is optional", () => {
    const doc = baseDoc([{ kind: "geometry", windowId: "1000", rect: { x: 0, y: 0, width: 1, height: 1 } }]);
    const [o] = parseProject(doc, 640, 360, duration).overrides!;
    expect(o).toEqual({ kind: "geometry", windowId: "1000", rect: { x: 0, y: 0, width: 1, height: 1 } });
    expect("easing" in o!).toBe(false);
  });

  test("a malformed entry is dropped, not the whole array", () => {
    const doc = baseDoc([
      { kind: "geometry", windowId: "1000", rect: { x: 0, y: 0, width: 1, height: 1 } },
      { kind: "geometry", windowId: "2000" }, // no rect
      { kind: "resize", windowId: "3000" },   // unknown kind (a later phase's variant)
      "nonsense",
      { kind: "geometry", windowId: "4000", rect: { x: 0, y: 0, width: 0.5, height: 0.5 }, easing: "not-a-preset" },
    ]);
    const overrides = parseProject(doc, 640, 360, duration).overrides!;
    expect(overrides).toHaveLength(2);
    expect((overrides[0] as any).windowId).toBe("1000");
    expect((overrides[1] as any).windowId).toBe("4000");
    expect("easing" in overrides[1]!).toBe(false); // the bogus easing is dropped, not the entry
  });

  test("a non-array overrides value is treated as none", () => {
    expect(parseProject(baseDoc("nonsense"), 640, 360, duration).overrides).toEqual([]);
  });

  // STC-331: a window with no derived counterpart at all.
  describe("the manual variant", () => {
    test("carries a well-formed manual override", () => {
      const doc = baseDoc([
        { kind: "manual", id: "abc", startNs: 1000, endNs: 5000,
          rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, easing: "snappy" },
      ]);
      expect(parseProject(doc, 640, 360, duration).overrides).toEqual([
        { kind: "manual", id: "abc", startNs: 1000, endNs: 5000,
          rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, easing: "snappy" },
      ]);
    });

    test("easing is REQUIRED, unlike the geometry variant — missing or bogus drops the whole entry", () => {
      const doc = baseDoc([
        { kind: "manual", id: "no-easing", startNs: 0, endNs: 1000, rect: { x: 0, y: 0, width: 1, height: 1 } },
        { kind: "manual", id: "bogus", startNs: 0, endNs: 1000, rect: { x: 0, y: 0, width: 1, height: 1 }, easing: "extreme" },
        { kind: "manual", id: "fine", startNs: 0, endNs: 1000, rect: { x: 0, y: 0, width: 1, height: 1 }, easing: "calm" },
      ]);
      const overrides = parseProject(doc, 640, 360, duration).overrides!;
      expect(overrides.map((o) => (o as any).id)).toEqual(["fine"]);
    });

    test("a missing id, or a non-integer/negative startNs or endNs, drops the entry", () => {
      const doc = baseDoc([
        { kind: "manual", startNs: 0, endNs: 1000, rect: { x: 0, y: 0, width: 1, height: 1 }, easing: "calm" }, // no id
        { kind: "manual", id: "a", startNs: -1, endNs: 1000, rect: { x: 0, y: 0, width: 1, height: 1 }, easing: "calm" },
        { kind: "manual", id: "b", startNs: 0, endNs: 1.5, rect: { x: 0, y: 0, width: 1, height: 1 }, easing: "calm" },
        { kind: "manual", id: "c", startNs: 0, endNs: 1000, rect: { x: 0, y: 0, width: 1, height: 1 }, easing: "calm" },
      ]);
      expect(parseProject(doc, 640, 360, duration).overrides!.map((o) => (o as any).id)).toEqual(["c"]);
    });

    test("geometry and manual entries coexist in one array", () => {
      const doc = baseDoc([
        { kind: "geometry", windowId: "1000", rect: { x: 0, y: 0, width: 1, height: 1 } },
        { kind: "manual", id: "m1", startNs: 0, endNs: 1000, rect: { x: 0, y: 0, width: 1, height: 1 }, easing: "calm" },
      ]);
      const overrides = parseProject(doc, 640, 360, duration).overrides!;
      expect(overrides).toHaveLength(2);
      expect(overrides.map((o) => o.kind)).toEqual(["geometry", "manual"]);
    });

    test("a round trip through write and parse keeps every manual field, and validates against project-6", () => {
      const p = defaultProject(640, 360);
      p.overrides = [
        { kind: "manual", id: "m1", startNs: 500, endNs: 3500, rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, easing: "snappy" },
      ];
      const written = projectForWrite(p, duration);
      expect(written.version).toBe(6);
      expect(validate6(written), JSON.stringify(validate6.errors)).toBe(true);
      const roundTripped = JSON.parse(JSON.stringify(written));
      expect(parseProject(roundTripped, 640, 360, duration).overrides).toEqual(p.overrides);
    });
  });
});

describe("projectForWrite emits the minimum version that can express it", () => {
  const base = () => defaultProject(640, 360);

  test("no overrides stays at whatever version zoom/textPt already need (v3, untouched)", () => {
    const out = projectForWrite(base(), duration);
    expect(out.version).toBe(3);
    expect("overrides" in out).toBe(false);
  });

  test("a real override pushes it to v6, and removing it returns to v3", () => {
    const p = base();
    p.overrides = [{ kind: "geometry", windowId: "1000", rect: { x: 0, y: 0, width: 0.5, height: 0.5 } }];
    const six = projectForWrite(p, duration);
    expect(six.version).toBe(6);
    expect(six.overrides).toEqual(p.overrides);
    expect(validate6(six), JSON.stringify(validate6.errors)).toBe(true);

    p.overrides = [];
    expect(projectForWrite(p, duration).version).toBe(3);
  });

  test("v6 is a superset: a non-default zoom AND textPt survive alongside overrides", () => {
    const p = base();
    p.zoom = { ...DEFAULT_ZOOM, preset: "snappy" };
    p.textPt = 18;
    p.overrides = [{ kind: "geometry", windowId: "1000", rect: { x: 0, y: 0, width: 0.5, height: 0.5 } }];
    const out = projectForWrite(p, duration);
    expect(out.version).toBe(6);
    expect(out.zoom).toEqual(p.zoom);
    expect(out.textPt).toBe(18);
    expect(out.overrides).toEqual(p.overrides);
    expect(validate6(out), JSON.stringify(validate6.errors)).toBe(true);
  });

  test("a round trip through write and parse keeps every override field", () => {
    const p = base();
    p.overrides = [
      { kind: "geometry", windowId: "500", rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, easing: "calm" },
      { kind: "geometry", windowId: "9000", rect: { x: 0, y: 0, width: 1, height: 1 } },
    ];
    const written = JSON.parse(JSON.stringify(projectForWrite(p, duration)));
    expect(parseProject(written, 640, 360, duration).overrides).toEqual(p.overrides);
  });
});

describe("render reads overrides", () => {
  const MS = 1_000_000;
  // One click at t=2000ms: window is [1700ms, 4500ms] (300ms lead, 2500ms hold).
  const events: SessionEvent[] = [
    { t: 2000 * MS, kind: "down", x: 10, y: 10, button: 0 },
    { t: 2050 * MS, kind: "up", x: 10, y: 10, button: 0 },
  ];
  const session = {
    anchors: {
      version: 2, timebase: { numer: 125, denom: 3 }, t0Ns: "0",
      display: { id: 1, pointWidth: 1920, pointHeight: 1080, pixelWidth: 1920,
                 pixelHeight: 1080, backingScale: 1, originX: 0, originY: 0 },
      capture: { width: 1920, height: 1080, codec: "h264", firstFrameNs: 0 },
      files: { display: "display.mp4" }, stop: { t: duration, reason: "user" },
    },
    events, frames: [0, 16_000_000, 32_000_000],
  } as unknown as Session;

  // windowId for the derived window: startNs = 2000ms - 300ms lead = 1700ms.
  const WINDOW_ID = String(1700 * MS);
  const TARGET = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };

  const projectWith = (overrides: Project["overrides"]): Project =>
    ({ ...defaultProject(1920, 1080), overrides });

  test("with no override, an empty overrides array applies no override — stage 2 (STC-326) still can and does move the crop", () => {
    const p = projectWith([]);
    const fs = render(p, session, 3000 * MS); // well inside the hold, spring settled
    expect(fs.zoom.amount).toBeGreaterThan(0.95);
    // This file's own concern is only that the EMPTY array behaves like no
    // override at all — not this file's TARGET. Stage 2's own answer (a
    // real crop now, not the whole frame) is proven in
    // zoom-change-render.test.ts, not restated here.
    expect(fs.zoom.crop).not.toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(fs.zoom.crop.x).not.toBeCloseTo(TARGET.x, 1);
  });

  test("deep inside the window (amount near 1), the crop is close to the override's target", () => {
    const p = projectWith([{ kind: "geometry", windowId: WINDOW_ID, rect: TARGET }]);
    const fs = render(p, session, 3000 * MS); // well inside the hold, spring settled
    expect(fs.zoom.amount).toBeGreaterThan(0.95);
    expect(fs.zoom.crop.x).toBeCloseTo(TARGET.x, 1);
    expect(fs.zoom.crop.y).toBeCloseTo(TARGET.y, 1);
    expect(fs.zoom.crop.width).toBeCloseTo(TARGET.width, 1);
    expect(fs.zoom.crop.height).toBeCloseTo(TARGET.height, 1);
  });

  test("long before the window, amount is 0 and the crop is exactly the whole frame regardless of the target", () => {
    const p = projectWith([{ kind: "geometry", windowId: WINDOW_ID, rect: TARGET }]);
    const fs = render(p, session, 0);
    expect(fs.zoom.amount).toBe(0);
    expect(fs.zoom.crop).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  test("an override for a DIFFERENT windowId never applies", () => {
    const p = projectWith([{ kind: "geometry", windowId: "999999999", rect: TARGET }]);
    const fs = render(p, session, 3000 * MS);
    expect(fs.zoom.amount).toBeGreaterThan(0.95);
    // Not the mismatched override's target — whatever crop this window
    // shows came from stage 2's own fallback (STC-326), not from an
    // override for a window this take does not have.
    expect(fs.zoom.crop.x).not.toBeCloseTo(TARGET.x, 1);
    expect(fs.zoom.crop.width).not.toBeCloseTo(TARGET.width, 1);
  });

  test("mid-transition, the crop is a real blend, not a snap between the two extremes", () => {
    const p = projectWith([{ kind: "geometry", windowId: WINDOW_ID, rect: TARGET }]);
    const fs = render(p, session, 1750 * MS); // just after the window opens
    expect(fs.zoom.amount).toBeGreaterThan(0);
    expect(fs.zoom.amount).toBeLessThan(0.95);
    // Strictly between the whole frame and the target on every component
    // that actually differs.
    expect(fs.zoom.crop.x).toBeGreaterThan(0);
    expect(fs.zoom.crop.x).toBeLessThan(TARGET.x);
    expect(fs.zoom.crop.width).toBeLessThan(1);
    expect(fs.zoom.crop.width).toBeGreaterThan(TARGET.width);
  });

  test("an override's own easing changes how fast ITS window settles, without touching the project preset", () => {
    const snappyOverride: Project["overrides"] =
      [{ kind: "geometry", windowId: WINDOW_ID, rect: TARGET, easing: "snappy" }];
    const p = { ...defaultProject(1920, 1080), zoom: { ...DEFAULT_ZOOM, preset: "calm" as const },
                overrides: snappyOverride };
    const pNoEasing = { ...defaultProject(1920, 1080), zoom: { ...DEFAULT_ZOOM, preset: "calm" as const },
                         overrides: [{ kind: "geometry" as const, windowId: WINDOW_ID, rect: TARGET }] };
    const t = 1750 * MS; // early in the transition, where the two presets clearly differ
    const snappyAmount = render(p, session, t).zoom.amount;
    const calmAmount = render(pNoEasing, session, t).zoom.amount;
    expect(snappyAmount).toBeGreaterThan(calmAmount);
  });

  test("seeking straight to a tick gives the same crop as stepping there", () => {
    const p = projectWith([{ kind: "geometry", windowId: WINDOW_ID, rect: TARGET }]);
    const t = 2200 * MS;
    const seeked = render(p, session, t).zoom;

    const s2: Session = { ...session, events: [...events] };
    for (let u = 0; u < t; u += 8_333_333) render(p, s2, u);
    const stepped = render(p, s2, t).zoom;

    expect(stepped).toEqual(seeked);
  });

  test("does not mutate the project's overrides array", () => {
    const p = projectWith([{ kind: "geometry", windowId: WINDOW_ID, rect: TARGET }]);
    const before = JSON.stringify(p);
    for (const t of [0, 2000 * MS, 5000 * MS]) render(p, session, t);
    expect(JSON.stringify(p)).toBe(before);
  });
});

describe("render reads a manual window with no derived counterpart (STC-331)", () => {
  const MS = 1_000_000;
  const TARGET = { x: 0.15, y: 0.25, width: 0.2, height: 0.3 };

  // No clicks or drags at all — stage 1 opens ZERO windows on its own, which
  // is exactly the case this ticket exists for: "when auto-zoom correctly
  // decided not to zoom, and you want to anyway."
  const emptySession = {
    anchors: {
      version: 2, timebase: { numer: 125, denom: 3 }, t0Ns: "0",
      display: { id: 1, pointWidth: 1920, pointHeight: 1080, pixelWidth: 1920,
                 pixelHeight: 1080, backingScale: 1, originX: 0, originY: 0 },
      capture: { width: 1920, height: 1080, codec: "h264", firstFrameNs: 0 },
      files: { display: "display.mp4" }, stop: { t: duration, reason: "user" },
    },
    events: [], frames: [0, 16_000_000, 32_000_000],
  } as unknown as Session;

  const manualOverride = (easing: "calm" | "standard" | "snappy" = "standard"): Project["overrides"] => [
    { kind: "manual", id: "m1", startNs: 2000 * MS, endNs: 5000 * MS, rect: TARGET, easing },
  ];

  test("a manual window zooms even though no derived window exists at that time", () => {
    const p: Project = { ...defaultProject(1920, 1080), overrides: manualOverride() };
    expect(render(p, emptySession, 0).zoom.amount).toBe(0); // before the window: nothing
    const inside = render(p, emptySession, 3500 * MS); // well inside, spring settled
    expect(inside.zoom.amount).toBeGreaterThan(0.95);
    expect(inside.zoom.crop.x).toBeCloseTo(TARGET.x, 1);
    expect(inside.zoom.crop.width).toBeCloseTo(TARGET.width, 1);
  });

  test("outside the manual window's span, the crop is exactly the whole frame", () => {
    const p: Project = { ...defaultProject(1920, 1080), overrides: manualOverride() };
    const before = render(p, emptySession, 0);
    expect(before.zoom.amount).toBe(0);
    expect(before.zoom.crop).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  test("its own easing governs its spring, independent of the project's preset", () => {
    const snappy: Project = { ...defaultProject(1920, 1080), zoom: { ...DEFAULT_ZOOM, preset: "calm" as const },
                               overrides: manualOverride("snappy") };
    const calm: Project = { ...defaultProject(1920, 1080), zoom: { ...DEFAULT_ZOOM, preset: "calm" as const },
                             overrides: manualOverride("calm") };
    const t = 2100 * MS; // early in the transition, where the presets clearly differ
    expect(render(snappy, emptySession, t).zoom.amount).toBeGreaterThan(render(calm, emptySession, t).zoom.amount);
  });

  test("seeking straight to a tick gives the same crop as stepping there", () => {
    const p: Project = { ...defaultProject(1920, 1080), overrides: manualOverride() };
    const t = 2300 * MS;
    const seeked = render(p, emptySession, t).zoom;

    const s2: Session = { ...emptySession, events: [] };
    for (let u = 0; u < t; u += 8_333_333) render(p, s2, u);
    const stepped = render(p, s2, t).zoom;

    expect(stepped).toEqual(seeked);
  });

  test("a manual window and a derived one can coexist and each drive their own span", () => {
    // One click at t=10000ms opens a derived window at [9700ms, 12500ms];
    // the manual window above sits earlier and does not overlap it.
    const events: SessionEvent[] = [
      { t: 10000 * MS, kind: "down", x: 10, y: 10, button: 0 },
      { t: 10050 * MS, kind: "up", x: 10, y: 10, button: 0 },
    ];
    const session2: Session = { ...emptySession, events };
    const p: Project = { ...defaultProject(1920, 1080), overrides: manualOverride() };

    const duringManual = render(p, session2, 3500 * MS);
    expect(duringManual.zoom.amount).toBeGreaterThan(0.95);
    expect(duringManual.zoom.crop.x).toBeCloseTo(TARGET.x, 1);

    const duringDerived = render(p, session2, 11000 * MS);
    expect(duringDerived.zoom.amount).toBeGreaterThan(0.95);
    // The derived window has no override of its own — its crop is whatever
    // stage 2's fallback says, which is certainly not the manual TARGET.
    expect(duringDerived.zoom.crop.x).not.toBeCloseTo(TARGET.x, 1);

    const betweenThem = render(p, session2, 6000 * MS);
    expect(betweenThem.zoom.amount).toBeLessThan(0.05);
  });
});
