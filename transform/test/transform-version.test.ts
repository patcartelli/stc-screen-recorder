import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";
import { TRANSFORM_VERSION, TRANSFORM_HISTORY, transformFingerprint } from "../src/transform-version.js";
import { parseProject, projectForWrite, defaultProject } from "../src/trim.js";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));

/**
 * The value below is a promise about the code: every constant that reaches
 * the pixels, hashed. If this test fails you changed one of them — OMEGA, the
 * checkpoint interval, the sim or export rate, the pointer artwork, the
 * outline or click-highlight sizes. That is allowed, and it is a new
 * transform: bump TRANSFORM_VERSION, add a TRANSFORM_HISTORY entry saying what
 * changed, then update this fingerprint. Never update the fingerprint alone.
 */
const PINNED_FINGERPRINT = "795d7fb8";

describe("the transform version is honest about what it renders", () => {
  test("the fingerprint of every pixel-deciding constant is pinned to this version", () => {
    expect(transformFingerprint(),
      `a constant that reaches the pixels changed. Bump TRANSFORM_VERSION (now ${TRANSFORM_VERSION}), ` +
      "add a TRANSFORM_HISTORY entry, then pin the new fingerprint").toBe(PINNED_FINGERPRINT);
  });

  test("TRANSFORM_VERSION is the last entry in the history, and the history is contiguous", () => {
    expect(TRANSFORM_HISTORY.map((h) => h.version)).toEqual(TRANSFORM_HISTORY.map((_, i) => i + 1));
    expect(TRANSFORM_HISTORY[TRANSFORM_HISTORY.length - 1]!.version).toBe(TRANSFORM_VERSION);
    for (const h of TRANSFORM_HISTORY) expect(h.changed.length).toBeGreaterThan(10);
  });

  test("the fingerprint is stable across calls (no wall clock, no randomness)", () => {
    expect(transformFingerprint()).toBe(transformFingerprint());
  });
});

describe("the stamp travels through the project document", () => {
  const validate3 = new Ajv({ allErrors: true, strict: true }).compile(load("schema/project-3.schema.json"));

  test("a fresh default project is v3 and carries the current transform", () => {
    const p = defaultProject(640, 360);
    expect(p.version).toBe(3);
    expect(p.transform).toEqual({ version: TRANSFORM_VERSION });
  });

  test("projectForWrite emits v3 with the CURRENT transform, whatever was read", () => {
    const old = parseProject({ version: 3, transform: { version: 1 }, output: { fps: 60, width: 640, height: 360 },
                               cursor: { style: "default", scale: 1 } }, 640, 360, 5e9);
    expect(old.transform).toEqual({ version: 1 });                 // carried on read
    const out = projectForWrite(old, 5e9);
    expect(out.version).toBe(3);
    expect(out.transform).toEqual({ version: TRANSFORM_VERSION }); // re-stamped on write
    expect(validate3(out), JSON.stringify(validate3.errors, null, 2)).toBe(true);
  });

  test("v1 and v2 documents, which predate the stamp, are filled with the current transform", () => {
    for (const doc of [load("fixtures/basic/project.json"), load("fixtures/pip/project.json")]) {
      expect(doc.version).toBeLessThan(3);
      expect(parseProject(doc, 640, 360, 5e9, doc.pip != null).transform).toEqual({ version: TRANSFORM_VERSION });
    }
  });

  test("a stamp that is not a positive integer is replaced, not trusted", () => {
    for (const bad of [0, -1, 1.5, "2", null]) {
      const p = parseProject({ version: 3, transform: { version: bad }, output: { fps: 60, width: 640, height: 360 },
                               cursor: { style: "default", scale: 1 } }, 640, 360, 5e9);
      expect(p.transform).toEqual({ version: TRANSFORM_VERSION });
    }
  });

  test("projectForWrite's output with pip and trim validates against project-3", () => {
    const p = parseProject(load("fixtures/pip/project.json"), 3840, 2160, 5e9, true);
    p.trim = { startNs: 1_000_000_000, endNs: 3_000_000_000 };
    const out = projectForWrite(p, 5e9);
    expect(validate3(out), JSON.stringify(validate3.errors, null, 2)).toBe(true);
    expect(out.pip).toBeDefined();
    expect(out.trim).toBeDefined();
  });
});
