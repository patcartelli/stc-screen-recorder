import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";
import { DEFAULT_ZOOM, defaultProject, parseProject, projectForWrite } from "../src/trim.js";
import { ZOOM_PRESET_NAMES, ZOOM_PRESETS } from "../src/zoom.js";
import { render } from "../src/render.js";
import type { Project, Session, SessionEvent } from "../src/types.js";

/**
 * project-4: auto-zoom's user SETTINGS (STC-325 / STC-324's "v1 exposes on /
 * off / intensity and three named easing presets").
 *
 * #108 shipped the derivation — windows, spring, `render().zoom` — with the
 * preset hardcoded to the default and no way to turn any of it off. This is
 * the document half: what the user chose, stored, and read back. The windows
 * are still never stored, which is what STC-324 means by a re-take
 * regenerating the derivation and keeping the overrides.
 */

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const schema = JSON.parse(readFileSync(join(root, "schema", "project-4.schema.json"), "utf8"));
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
const duration = 12_000_000_000;

describe("the schema and the code agree about the presets", () => {
  /**
   * The `CURSOR_SHAPES` rule, applied to the second list here with a schema
   * counterpart: a preset in one and not the other is a document that
   * validates and then renders as something else.
   */
  test("the enum equals ZOOM_PRESET_NAMES", () => {
    expect([...schema.properties.zoom.properties.preset.enum].sort())
      .toEqual([...ZOOM_PRESET_NAMES].sort());
  });

  test("and the names are the presets table's own keys", () => {
    expect([...ZOOM_PRESET_NAMES].sort()).toEqual(Object.keys(ZOOM_PRESETS).sort());
  });
});

describe("parseProject", () => {
  test("fills the default on a document that predates zoom", () => {
    const v3 = {
      version: 3, output: { fps: 60, width: 640, height: 360 },
      cursor: { style: "default", scale: 1 }, transform: { version: 3 },
    };
    expect(parseProject(v3, 640, 360, duration).zoom).toEqual(DEFAULT_ZOOM);
  });

  /**
   * The shape bug worth a test of its own: `parseProject(null)` takes an early
   * `return fallback`, so a field added only in the parse body never reaches
   * it and one function returns two shapes. Both paths are compared against
   * each other rather than against a literal, which is what makes this fail if
   * either drifts.
   */
  test("every path returns the same shape, including the early return", () => {
    const fromNull = parseProject(null, 640, 360, duration);
    const fromJunk = parseProject("{nope}", 640, 360, duration);
    const fromOld = parseProject({ version: 2 }, 640, 360, duration);
    expect(fromNull).toEqual(defaultProject(640, 360));
    expect(fromJunk).toEqual(fromNull);
    expect(fromOld).toEqual(fromNull);
    for (const p of [fromNull, fromJunk, fromOld]) expect(p.zoom).toEqual(DEFAULT_ZOOM);
  });

  test("carries what the user chose", () => {
    const doc = {
      version: 4, output: { fps: 60, width: 640, height: 360 },
      cursor: { style: "default", scale: 1 }, transform: { version: 3 },
      zoom: { enabled: false, intensity: 0.5, preset: "calm" },
    };
    expect(parseProject(doc, 640, 360, duration).zoom)
      .toEqual({ enabled: false, intensity: 0.5, preset: "calm" });
  });

  /**
   * A preset this build does not have falls back rather than being guessed at.
   * A document naming an easing from a different build is a document from a
   * different build; picking the nearest of three would render something
   * nobody chose.
   */
  test("refuses an unknown preset and an out-of-range intensity", () => {
    const raw = (zoom: unknown) => ({
      version: 4, output: { fps: 60, width: 640, height: 360 },
      cursor: { style: "default", scale: 1 }, transform: { version: 3 }, zoom,
    });
    expect(parseProject(raw({ preset: "swooshy" }), 640, 360, duration).zoom!.preset)
      .toBe(DEFAULT_ZOOM.preset);
    expect(parseProject(raw({ intensity: 4 }), 640, 360, duration).zoom!.intensity)
      .toBe(DEFAULT_ZOOM.intensity);
    expect(parseProject(raw({ intensity: -1 }), 640, 360, duration).zoom!.intensity)
      .toBe(DEFAULT_ZOOM.intensity);
    // A malformed block does not cost the fields beside it.
    expect(parseProject(raw("nonsense"), 640, 360, duration).zoom).toEqual(DEFAULT_ZOOM);
  });

  test("intensity 0 is a real, kept choice — not read as absent", () => {
    const doc = {
      version: 4, output: { fps: 60, width: 640, height: 360 },
      cursor: { style: "default", scale: 1 }, transform: { version: 3 },
      zoom: { enabled: true, intensity: 0, preset: "standard" },
    };
    expect(parseProject(doc, 640, 360, duration).zoom!.intensity).toBe(0);
  });
});

describe("projectForWrite emits the minimum version that can express it", () => {
  const base = () => defaultProject(640, 360);

  test("an untouched zoom stays v3, so an older build still reads it", () => {
    const out = projectForWrite(base(), duration);
    expect(out.version).toBe(3);
    expect("zoom" in out).toBe(false);
    // And it still validates as the version it claims.
    const v3 = JSON.parse(readFileSync(join(root, "schema", "project-3.schema.json"), "utf8"));
    expect(new Ajv({ allErrors: true, strict: false }).compile(v3)(out)).toBe(true);
  });

  test("a changed zoom becomes v4, and changing it back returns to v3", () => {
    const p = base();
    p.zoom = { ...DEFAULT_ZOOM, preset: "snappy" };
    const four = projectForWrite(p, duration);
    expect(four.version).toBe(4);
    expect(four.zoom).toEqual({ ...DEFAULT_ZOOM, preset: "snappy" });
    expect(validate(four), JSON.stringify(validate.errors)).toBe(true);

    p.zoom = { ...DEFAULT_ZOOM };
    expect(projectForWrite(p, duration).version).toBe(3);
  });

  test("each field on its own can push it to v4", () => {
    for (const zoom of [
      { ...DEFAULT_ZOOM, enabled: false },
      { ...DEFAULT_ZOOM, intensity: 0.4 },
      { ...DEFAULT_ZOOM, preset: "calm" as const },
    ]) {
      const p = base();
      p.zoom = zoom;
      expect(projectForWrite(p, duration).version, JSON.stringify(zoom)).toBe(4);
    }
  });

  test("a round trip through write and parse keeps the choice", () => {
    const p = base();
    p.zoom = { enabled: false, intensity: 0.25, preset: "calm" };
    const written = JSON.parse(JSON.stringify(projectForWrite(p, duration)));
    expect(parseProject(written, 640, 360, duration).zoom).toEqual(p.zoom);
  });
});

describe("render reads the settings", () => {
  const MS = 1_000_000;
  const events: SessionEvent[] = [
    { t: 1000 * MS, kind: "down", x: 10, y: 10, button: 0 },
    { t: 1080 * MS, kind: "up", x: 10, y: 10, button: 0 },
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
  const project = (zoom: Project["zoom"]): Project =>
    ({ ...defaultProject(1920, 1080), zoom });
  const at = (zoom: Project["zoom"], tNs: number) => render(project(zoom), session, tNs).zoom.amount;

  test("disabled is a flat zero, all the way through the window", () => {
    for (let t = 0; t < 5000 * MS; t += 250 * MS) {
      expect(at({ ...DEFAULT_ZOOM, enabled: false }, t)).toBe(0);
    }
  });

  test("intensity scales the eased amount", () => {
    const full = at(DEFAULT_ZOOM, 2000 * MS);
    const half = at({ ...DEFAULT_ZOOM, intensity: 0.5 }, 2000 * MS);
    expect(full).toBeGreaterThan(0.9);
    expect(half).toBeCloseTo(full * 0.5, 10);
  });

  test("intensity 0 and disabled agree, which is why they are one path", () => {
    expect(at({ ...DEFAULT_ZOOM, intensity: 0 }, 2000 * MS)).toBe(0);
    expect(at({ ...DEFAULT_ZOOM, enabled: false }, 2000 * MS)).toBe(0);
  });

  /**
   * The cache bug #108's own comment predicted: keyed on the session alone, the
   * first preset asked for would answer for every later one, for the life of
   * the process. Asked in BOTH orders, because a cache that returns the first
   * answer looks correct when the first answer is the one you wanted.
   */
  test("two presets on one session get two different sims", () => {
    const t = 1150 * MS;
    const calmFirst = at({ ...DEFAULT_ZOOM, preset: "calm" }, t);
    const snappyAfter = at({ ...DEFAULT_ZOOM, preset: "snappy" }, t);
    expect(snappyAfter).toBeGreaterThan(calmFirst);
    // And again on a fresh session, asked the other way round.
    const s2 = { ...session, events: [...events] } as Session;
    const snappyFirst = render(project({ ...DEFAULT_ZOOM, preset: "snappy" }), s2, t).zoom.amount;
    const calmAfter = render(project({ ...DEFAULT_ZOOM, preset: "calm" }), s2, t).zoom.amount;
    expect(snappyFirst).toBeGreaterThan(calmAfter);
    expect(calmAfter).toBeCloseTo(calmFirst, 12);
  });

  test("a project with no zoom block renders as the default", () => {
    const noBlock = { ...defaultProject(1920, 1080) };
    delete noBlock.zoom;
    expect(render(noBlock, session, 2000 * MS).zoom.amount)
      .toBeCloseTo(at(DEFAULT_ZOOM, 2000 * MS), 12);
  });

  /**
   * The safety property, unchanged by any setting: while stage 2 is stubbed
   * the crop is the whole frame, so none of these choices can move a pixel.
   * `gate:identity` is the same claim on real pixels.
   */
  test("no setting moves the crop while stage 2 is stubbed", () => {
    for (const zoom of [
      DEFAULT_ZOOM, { ...DEFAULT_ZOOM, enabled: false },
      { ...DEFAULT_ZOOM, intensity: 0.3 }, { ...DEFAULT_ZOOM, preset: "snappy" as const },
    ]) {
      expect(render(project(zoom), session, 2000 * MS).zoom.crop)
        .toEqual({ x: 0, y: 0, width: 1, height: 1 });
    }
  });
});
