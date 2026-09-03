import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";
import {
  parseRecording, recordingForWrite, synthesizeRecording, RecordingLoadError, type Recording,
} from "../src/recording.js";
import type { Anchors } from "../src/types.js";

// CJS/ESM interop: ajv v8 ships CJS; vitest may or may not unwrap the default.
const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o));

const schema = load("schema/recording-1.schema.json");
const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);
const fixture = load("fixtures/recording/recording.json");
const basicAnchors: Anchors = load("fixtures/basic/anchors.json");
const pipAnchors: Anchors = load("fixtures/pip/anchors.json");

/**
 * STC-307: the schema and the loader are checked against EACH OTHER, same
 * pattern STC-301 gate 5 set for shot.json — a document the schema accepts
 * must parse, and one it rejects must be refused, so the two cannot drift
 * apart the way anchors' member checks and its schema once did (STC-262).
 */
describe("recording-1 schema and loader agree", () => {
  test("the two-segment fixture validates and round-trips through the loader", () => {
    expect(validate(fixture), JSON.stringify(validate.errors, null, 2)).toBe(true);
    const recording = parseRecording(fixture);
    expect(recording.version).toBe(1);
    expect(recording.segments).toHaveLength(2);
    expect(recording.segments[0]).toEqual({
      id: "seg-0", media: { display: { id: "disp-0", file: "display-0.mp4" } }, startNs: 0, endNs: 3_000_000_000,
    });
    expect(recording.segments[1]!.media.camera).toEqual({ id: "cam-1", file: "camera-1.mp4" });
    // The same document, written back: identical bytes when re-serialised.
    expect(JSON.stringify(recordingForWrite(recording))).toBe(JSON.stringify(parseRecording(fixture)));
    expect(recordingForWrite(recording)).toEqual(recording);
  });

  test("the loader returns a copy, never the raw object", () => {
    const raw = clone(fixture);
    const recording = parseRecording(raw);
    raw.segments[0].id = "mutated";
    expect(recording.segments[0]!.id).toBe("seg-0");
  });
});

describe("documents that must be refused — by both the schema and the loader", () => {
  const refused: [string, (d: any) => void][] = [
    ["a future version", (d) => { d.version = 2; }],
    ["no version", (d) => { delete d.version; }],
    ["no segments", (d) => { d.segments = []; }],
    ["a field nobody declared, at the top level", (d) => { d.takeId = "abc"; }],
    ["a field nobody declared, on a segment", (d) => { d.segments[0].label = "intro"; }],
    ["a segment with no display media", (d) => { delete d.segments[0].media.display; }],
    ["a segment's media.camera missing its file", (d) => { delete d.segments[1].media.camera.file; }],
    ["a non-integer startNs", (d) => { d.segments[0].startNs = 1.5; }],
  ];
  test.each(refused)("%s", (_name, mutate) => {
    const doc = clone(fixture);
    mutate(doc);
    expect(validate(doc), "the schema accepted it").toBe(false);
    expect(() => parseRecording(doc)).toThrow(RecordingLoadError);
  });

  // A sum constraint (endNs > startNs, within one segment) and every
  // cross-element constraint (ordering, non-overlap, id uniqueness) are not
  // expressible in JSON Schema; the schema alone accepts these documents, so
  // the loader's refusal is asserted on its own, same as shot.ts's redaction
  // sum constraint.
  const loaderOnly: [string, (d: any) => void, RegExp][] = [
    ["endNs equal to its own segment's startNs", (d) => { d.segments[1].endNs = d.segments[1].startNs; }, /segments\[1\]\.endNs/],
    ["overlapping segments", (d) => { d.segments[1].startNs = d.segments[0].endNs - 1; }, /segments\[1\]/],
    ["segments out of order", (d) => { d.segments.reverse(); }, /segments\[1\]/],
    ["a segment id reused across segments", (d) => { d.segments[1].id = d.segments[0].id; }, /seg-0/],
    ["a media id reused across segments", (d) => { d.segments[1].media.display.id = d.segments[0].media.display.id; }, /disp-0/],
  ];
  test.each(loaderOnly)("the schema alone accepts %s; the loader names the field", (_name, mutate, msg) => {
    const doc = clone(fixture);
    mutate(doc);
    expect(validate(doc), "the schema unexpectedly rejected it too").toBe(true);
    expect(() => parseRecording(doc)).toThrow(msg);
  });
});

/**
 * Every take on disk today predates recording.json — the helper has always
 * written exactly one segment's worth of media into anchors.json. This is
 * the load-time compatibility path (readers accept v1..vN): no file is ever
 * written to an existing take directory for it.
 */
describe("synthesizeRecording — the compatibility path for every take on disk today", () => {
  test("a display-only take with a clean stop synthesizes one segment, and it validates", () => {
    const recording: Recording = synthesizeRecording(basicAnchors);
    expect(recording).toEqual({
      version: 1,
      segments: [{
        id: "legacy:segment-0",
        media: { display: { id: "legacy:display", file: "display.mp4" } },
        startNs: 0,
        endNs: basicAnchors.stop!.t,
      }],
    });
    expect(validate(recordingForWrite(recording)), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  test("a take with a present camera carries it as segment media", () => {
    const recording = synthesizeRecording(pipAnchors);
    expect(recording.segments[0]!.media.camera).toEqual({ id: "legacy:camera", file: "camera.mp4" });
  });

  test("camera present:false synthesizes exactly like no camera at all", () => {
    const anchors: Anchors = { ...clone(pipAnchors), camera: { ...clone(pipAnchors).camera!, present: false } };
    const recording = synthesizeRecording(anchors);
    expect(recording.segments[0]!.media.camera).toBeUndefined();
  });

  test("is deterministic — the same anchors always synthesize the same ids", () => {
    expect(synthesizeRecording(basicAnchors)).toEqual(synthesizeRecording(clone(basicAnchors)));
  });

  test("refuses a take with no stop — it never finished, so there is nothing to synthesize from", () => {
    const anchors = clone(basicAnchors);
    delete anchors.stop;
    expect(() => synthesizeRecording(anchors)).toThrow(RecordingLoadError);
    expect(() => synthesizeRecording(anchors)).toThrow(/stop/);
  });
});
