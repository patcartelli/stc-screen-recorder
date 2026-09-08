import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";
import {
  parseShot, shotForWrite, defaultDecoration, ShotLoadError,
  DECORATION_MODES, WINDOW_MODES, type Shot,
} from "../src/shot.js";
import { CURSOR_SHAPES } from "../src/cursor-art.js";

// CJS/ESM interop: ajv v8 ships CJS; vitest may or may not unwrap the default.
const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o));

/**
 * A document is validated against the schema for the version IT DECLARES.
 *
 * shot-2 (STC-295) adds `decoration.annotations`, and the invariant worth
 * holding is not "everything validates against shot-1" — it is that whatever
 * `shotForWrite` emits validates against the schema for the version it wrote.
 * A single validator would have made adding a version look like a regression
 * and been "fixed" by pointing it at the newest schema, which would stop it
 * ever catching a v1 document carrying a v2 field.
 */
const ajv = new Ajv({ allErrors: true, strict: true });
/**
 * The newest schema, for the structural checks that are about the ENUMS rather
 * than about any one document. Those lists have to match the loader's, and they
 * live in the version that has all of them.
 */
const schema = load("schema/shot-2.schema.json");
const VALIDATORS: Record<number, ReturnType<typeof ajv.compile>> = {
  1: ajv.compile(load("schema/shot-1.schema.json")),
  2: ajv.compile(load("schema/shot-2.schema.json")),
};
let lastErrors: unknown;
function validate(doc: any): boolean {
  const v = VALIDATORS[doc?.version as number];
  if (!v) { lastErrors = [{ message: `no schema for version ${String(doc?.version)}` }]; return false; }
  const ok = v(doc);
  lastErrors = v.errors;
  return ok as boolean;
}
validate.errors = undefined as unknown;
Object.defineProperty(validate, "errors", { get: () => lastErrors });
const fixture = load("fixtures/shot/shot.json");

/** A window capture with alpha, the shape modes 2-5 need. */
const windowShot = {
  ...clone(fixture),
  kind: "window",
  crop: undefined,
  window: { id: 4711, app: "Finder", title: "Downloads", bounds: { x: 200, y: 120, width: 800, height: 600 } },
  frame: { file: "frame.png", width: 1600, height: 1200, alpha: true },
  decoration: { mode: "window-shadow", canvas: "16:9", cursor: true, redactions: [],
                paddingPct: 0.08, shadow: { offsetX: 0, offsetY: 24, blur: 48, spread: 0, opacity: 0.35 },
                background: { kind: "linear", colors: ["#1e3a8a", "#9333ea"], angleDeg: 135 } },
};
delete (windowShot as any).crop;

/**
 * STC-301 gate 5, the loader half: every shot.json the slice writes loads
 * back, byte-for-byte, and carries a version. The schema and the loader are
 * checked against EACH OTHER here — a document the schema accepts must parse,
 * and one it rejects must be refused — so the two cannot drift apart the way
 * anchors' member checks and its schema once did (STC-262).
 */
describe("shot-1 schema and loader agree", () => {
  test("the display-crop fixture validates and round-trips through the loader", () => {
    expect(validate(fixture), JSON.stringify(validate.errors, null, 2)).toBe(true);
    const shot = parseShot(fixture);
    expect(shot.version).toBe(1);
    expect(shot.kind).toBe("display-crop");
    expect(shot.crop).toEqual({ x: 100, y: 80, width: 640, height: 360 });
    expect(shot.cursor).toEqual({ x: 420, y: 300, shape: "arrow" });
    expect(shot.decoration.redactions).toHaveLength(1);
    // The same document, written back: identical bytes when re-serialised.
    // Document-to-document: `shotForWrite` emits the SERIALISABLE form, which
    // at v1 omits the v2-only `annotations` key that the in-memory `Shot`
    // always carries.
    const written = shotForWrite(shot);
    expect(written.version).toBe(1);
    expect(written.decoration.annotations).toBeUndefined();
    expect(validate(JSON.parse(JSON.stringify(written))),
           JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect({ ...written, decoration: { ...written.decoration, annotations: [] } }).toEqual(shot);
  });

  test("a window capture with the full decoration validates and round-trips", () => {
    expect(validate(windowShot), JSON.stringify(validate.errors, null, 2)).toBe(true);
    const shot = parseShot(windowShot);
    expect(shot.window?.id).toBe(4711);
    expect(shot.frame.alpha).toBe(true);
    expect(shot.decoration.shadow?.blur).toBe(48);
    expect(shot.decoration.background?.colors).toEqual(["#1e3a8a", "#9333ea"]);
    expect({ ...shotForWrite(shot), decoration: { ...shotForWrite(shot).decoration, annotations: [] } })
      .toEqual(shot);
  });

  test("the loader returns a copy, never the raw object", () => {
    const raw = clone(fixture);
    const shot = parseShot(raw);
    raw.decoration.redactions[0].x = 0.9;
    expect(shot.decoration.redactions[0]!.x).toBe(0.1);
  });

  test("cursor shapes are exactly the set the compositor can draw", () => {
    expect(schema.properties.cursor.properties.shape.enum).toEqual([...CURSOR_SHAPES]);
  });

  test("the loader's mode and window-mode lists match the schema's enum", () => {
    expect([...DECORATION_MODES]).toEqual(schema.properties.decoration.properties.mode.enum);
    expect(WINDOW_MODES).toEqual(DECORATION_MODES.filter((m) => m !== "selected-area"));
  });

  test("defaultDecoration is the honest mode for the kind, and validates", () => {
    expect(defaultDecoration("display-crop").mode).toBe("selected-area");
    expect(defaultDecoration("window").mode).toBe("window-only");
    for (const kind of ["display-crop", "window"] as const) {
      const doc = clone(kind === "window" ? windowShot : fixture);
      doc.decoration = defaultDecoration(kind);
      // Through `shotForWrite`, which is what decides the version and what
      // strips the v2-only key from a document that has nothing to say with
      // it. `defaultDecoration` is an IN-MEMORY value and always carries
      // `annotations`; the document on disk is what the schema describes.
      const written = JSON.parse(JSON.stringify(shotForWrite(parseShot(doc))));
      expect(written.version).toBe(1);
      expect(validate(written), JSON.stringify(validate.errors, null, 2)).toBe(true);
      expect(parseShot(doc).decoration).toEqual(defaultDecoration(kind));
    }
  });
});

describe("documents that must be refused — by both the schema and the loader", () => {
  const refused: [string, (d: any) => void][] = [
    ["a future version", (d) => { d.version = 3; }],
    ["no version", (d) => { delete d.version; }],
    ["a crop on a window shot", (d) => { Object.assign(d, clone(windowShot)); d.crop = { x: 0, y: 0, width: 1, height: 1 }; }],
    ["a window block on a display-crop shot", (d) => { d.window = clone(windowShot).window; }],
    ["a window mode on a display-crop shot", (d) => { d.decoration.mode = "window-shadow"; }],
    ["a window mode on a window shot captured WITHOUT alpha", (d) => { Object.assign(d, clone(windowShot)); d.frame.alpha = false; }],
    ["a zero-size crop", (d) => { d.crop.width = 0; }],
    ["a cursor with no shape (a zeroed cursor is the lie the schema forbids)", (d) => { d.cursor = { x: 0, y: 0 }; }],
    ["a cursor shape the compositor cannot draw", (d) => { d.cursor.shape = "grab"; }],
    ["a redaction with zero area", (d) => { d.decoration.redactions = [{ x: 0.1, y: 0.1, width: 0, height: 0.1 }]; }],
    ["an unknown decoration mode", (d) => { d.decoration.mode = "blurred"; }],
    ["an unknown canvas preset", (d) => { d.decoration.canvas = "21:9"; }],
    ["padding above 1", (d) => { d.decoration.paddingPct = 1.5; }],
    ["a shadow with opacity above 1", (d) => { d.decoration.shadow = { offsetX: 0, offsetY: 0, blur: 1, spread: 0, opacity: 2 }; }],
    ["a background colour that is not hex", (d) => { d.decoration.background = { kind: "solid", colors: ["red"] }; }],
    ["capturedAtNs as a number (would round past 2^53)", (d) => { d.capturedAtNs = 1000000000; }],
    ["a field nobody declared", (d) => { d.decoration.baked = "output.png"; }],
  ];
  test.each(refused)("%s", (_name, mutate) => {
    const doc = clone(fixture);
    mutate(doc);
    expect(validate(doc), "the schema accepted it").toBe(false);
    expect(() => parseShot(doc)).toThrow(ShotLoadError);
  });

  // A sum constraint (x + width <= 1) is not expressible in JSON Schema; the
  // loader carries it alone, so it is asserted alone.
  test("a redaction extending past the capture is refused by the loader (the schema cannot say so)", () => {
    const doc = clone(fixture);
    doc.decoration.redactions = [{ x: 0.9, y: 0, width: 0.2, height: 0.1 }];
    expect(validate(doc)).toBe(true);
    expect(() => parseShot(doc)).toThrow(/redactions\[0\]/);
  });

  test("the error names the field", () => {
    const doc = clone(fixture);
    doc.decoration.canvas = "21:9";
    expect(() => parseShot(doc)).toThrow(/decoration\.canvas/);
  });
});

describe("what the loader tolerates that the schema also tolerates", () => {
  test("no cursor at all — the pointer was on another display", () => {
    const doc = clone(fixture);
    delete doc.cursor;
    expect(validate(doc)).toBe(true);
    expect(parseShot(doc).cursor).toBeUndefined();
  });
  test("no optional decoration parameters — the preset is the whole decoration", () => {
    const doc = clone(fixture);
    doc.decoration = { mode: "selected-area", canvas: "natural", cursor: false, redactions: [] };
    expect(validate(doc)).toBe(true);
    const shot: Shot = parseShot(doc);
    // `annotations` is the one field the loader ADDS: absent in a v1 document
    // means empty, and every consumer gets an array rather than having to tell
    // "none" from "an older document".
    expect(shot.decoration).toEqual({ ...doc.decoration, annotations: [] });
    // ...and the write path puts the document back exactly as it was.
    expect(JSON.parse(JSON.stringify(shotForWrite(shot))).decoration).toEqual(doc.decoration);
  });
});
