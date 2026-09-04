import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CURSOR_SHAPES, DEFAULT_CURSOR_SHAPE } from "../../transform/src/cursor-art.js";

const root = join(__dirname, "..", "..");

/**
 * The shape names exist in three languages: the schema's enum, the artwork's
 * list (cursor-art.test.ts holds those two equal), and the Swift list the
 * helper classifies into. This holds the third to the first. A helper that
 * wrote a name the schema refuses would fail at load, loudly; a helper whose
 * list was SHORTER would silently write the arrow for a shape the compositor
 * can draw, which no schema check can see.
 */
function swiftStringList(file: string, name: string): string[] {
  const src = readFileSync(join(root, file), "utf8");
  const m = src.match(new RegExp(`let ${name}\\s*=\\s*\\[([^\\]]*)\\]`));
  if (!m) throw new Error(`${name} not found as a string-array literal in ${file}`);
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

describe("cursor shape names — helper, schema and artwork agree", () => {
  const schema = JSON.parse(readFileSync(join(root, "schema/events-2.schema.json"), "utf8"));
  const schemaEnum: string[] = schema.definitions.cursorEvent.properties.shape.enum;

  test("CaptureDecisions.swift's cursorShapeNames equals the events-2 enum", () => {
    expect(swiftStringList("helper/src/CaptureDecisions.swift", "cursorShapeNames")).toEqual(schemaEnum);
  });

  test("and the artwork list, so the helper can never name a shape without a drawing", () => {
    expect(swiftStringList("helper/src/CaptureDecisions.swift", "cursorShapeNames")).toEqual([...CURSOR_SHAPES]);
  });

  test("the helper's default is the compositor's default", () => {
    const src = readFileSync(join(root, "helper/src/CaptureDecisions.swift"), "utf8");
    const m = src.match(/let defaultCursorShape\s*=\s*"([^"]+)"/);
    expect(m?.[1]).toBe(DEFAULT_CURSOR_SHAPE);
  });

  test("CursorShape.swift's NSCursor lookup covers every name and nothing else", () => {
    // The lookup is a switch, so a name added to the list without a case
    // would classify as missing at runtime; catch it here instead.
    const src = readFileSync(join(root, "helper/src/CursorShape.swift"), "utf8");
    const cases = [...src.matchAll(/case "([^"]+)":\s*return \.\w+/g)].map((x) => x[1]!);
    expect(cases).toEqual(schemaEnum);
  });
});
