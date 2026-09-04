import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";
import { runSwiftHarness } from "./_swift-harness.js";
import { parseShot } from "../../transform/src/shot.js";
import { CURSOR_SHAPES } from "../../transform/src/cursor-art.js";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));

/**
 * STC-289: the one-frame path's decisions, and the writer half of STC-301
 * gate 5.
 *
 * The Swift harness asserts the pure decisions (request parsing, crop
 * resolution, cursor localisation across displays, shape classification) and
 * PRINTS every shot.json `shotDocument` produces. This side validates each of
 * those against the schema and against `parseShot` — so the helper's writer
 * and the transform's loader are checked against each other on every
 * `npm test`, not only on a Mac with a grant. A field the Swift side adds
 * that the loader refuses fails here, before any still is ever taken.
 */
describe("still decisions (STC-289)", () => {
  test("Swift pure-function assertions all pass, and every emitted shot.json loads", async () => {
    const out = await runSwiftHarness({
      label: "still",
      sources: [
        "helper/src/StillDecisions.swift",
        "helper/src/AnchorsDoc.swift",
        // For cursorShapeNames — the still writes the same list the recording
        // path classifies into (STC-309), so it is not declared twice.
        "helper/src/CaptureDecisions.swift",
        "helper/test/still/main.swift",
      ],
    });
    expect(out, out).toContain("ALL PASS");

    const docs = out.split("\n")
      .filter((l) => l.startsWith("shot-json "))
      .map((l) => {
        const m = l.match(/^shot-json (\S+) (.*)$/);
        if (!m || m[1] === undefined || m[2] === undefined) throw new Error(`unparseable harness line: ${l}`);
        return { label: m[1], doc: JSON.parse(m[2]) };
      });
    // Four documents, named, so a harness that stopped printing one is a
    // failure here rather than a quietly smaller sample.
    expect(docs.map((d) => d.label).sort())
      .toEqual(["display-crop", "full-display", "window", "window-opaque"]);

    const validate = new Ajv({ allErrors: true, strict: true }).compile(load("schema/shot-1.schema.json"));
    for (const { label, doc } of docs) {
      expect(validate(doc), `${label}: ${JSON.stringify(validate.errors, null, 2)}`).toBe(true);
      // The loader is the stricter of the two (it refuses what the schema
      // merely does not describe); a document must survive both.
      const shot = parseShot(doc);
      expect(shot.version).toBe(1);
      // Round trip: what the loader normalises must be what was written.
      expect(JSON.parse(JSON.stringify(shot))).toEqual(doc);
    }

    const byLabel = Object.fromEntries(docs.map((d) => [d.label, d.doc]));
    expect(byLabel["display-crop"].cursor).toEqual({ x: 420, y: 300, shape: "arrow" });
    expect(byLabel["full-display"]).not.toHaveProperty("cursor");
    expect(byLabel["full-display"].crop).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(byLabel["window"].decoration.mode).toBe("window-only");
    expect(byLabel["window"].frame.alpha).toBe(true);
    expect(byLabel["window-opaque"].decoration.mode).toBe("selected-area");

    // The list the still writes its cursor shape from must be shot-1's enum,
    // which is what the compositor can draw. cursor-shape-names.test.ts holds
    // the same Swift list to events-2; this holds it to shot-1.
    const shapesLine = out.split("\n").find((l) => l.startsWith("shapes "));
    expect(shapesLine, "harness did not print its shape list").toBeDefined();
    const swiftShapes = shapesLine!.slice("shapes ".length).split(",");
    const schemaShapes = load("schema/shot-1.schema.json").properties.cursor.properties.shape.enum;
    expect(swiftShapes).toEqual(schemaShapes);
    expect(swiftShapes).toEqual([...CURSOR_SHAPES]);
  });
}, 60_000);
