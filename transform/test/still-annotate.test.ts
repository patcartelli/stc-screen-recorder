import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";
import {
  ANNOTATION_ACCENT, ANNOTATION_LINE_HEIGHT, ANNOTATION_TEXT_SIZES, ANNOTATION_WEIGHTS,
  ARROW_HEAD_LENGTH_RATIO, MAX_ANNOTATION_TEXT, MIN_ARROW_PX, MIN_BOX_PX,
  annotationFont, arrowGeometry, makeText, normaliseArrow, normaliseBox, undoLastAnnotation,
  type Annotation,
} from "../src/still-annotate.js";
import { annotationLayouts, layoutStill } from "../src/still-decorate.js";
import { scaleStillLayout } from "../src/still-export.js";
import { parseShot, shotForWrite, versionFor, ShotLoadError, type Shot } from "../src/shot.js";

/**
 * Annotation — arrow, box, text (STC-295).
 *
 * The ticket has four acceptance criteria and three of them are checkable with
 * no rasteriser at all, which is why they are here:
 *
 *   1. "re-opened after an app restart is fully editable, every annotation
 *      still attached to the right pixel" — a round trip through the loader,
 *      since the document IS the still.
 *   2. "changing the crop after annotating moves annotations with the content,
 *      not with the canvas" — the layout, against two different canvases.
 *   3. "text renders identically in preview and export" — one font constant and
 *      one render path, checked structurally.
 *
 * The fourth ("no halo where an arrow crosses the window edge") is about
 * PIXELS and belongs to the still gate, which renders in a real browser.
 */

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o));
const validateV2 = new Ajv({ allErrors: true, strict: true })
  .compile(load("schema/shot-2.schema.json"));
const fixture = load("fixtures/shot/shot.json");

const FRAME = { width: 1000, height: 500 };

const ARROW: Annotation = { kind: "arrow", from: { x: 0.1, y: 0.2 }, to: { x: 0.6, y: 0.7 }, weight: "regular" };
const BOX: Annotation = { kind: "box", shape: "rect", rect: { x: 0.2, y: 0.3, width: 0.4, height: 0.2 }, weight: "bold" };
const TEXT: Annotation = { kind: "text", at: { x: 0.5, y: 0.1 }, text: "the thing", size: "large" };

describe("a drag becomes an annotation, or nothing", () => {
  test("an arrow keeps its direction — the head is at the END of the drag", () => {
    const a = normaliseArrow({ x: 100, y: 50 }, { x: 400, y: 250 }, FRAME)!;
    expect(a.from).toEqual({ x: 0.1, y: 0.1 });
    expect(a.to).toEqual({ x: 0.4, y: 0.5 });
  });

  test("a short drag is not an arrow", () => {
    expect(normaliseArrow({ x: 100, y: 100 }, { x: 104, y: 103 }, FRAME)).toBeUndefined();
  });

  /**
   * The floor is on LENGTH, not on a bounding box.
   *
   * A perfectly horizontal drag has zero height, and `normaliseRegion`'s
   * min-width-AND-height rule (STC-297) would refuse it — but a horizontal
   * arrow is the most ordinary arrow there is. Different shape of gesture,
   * different floor.
   */
  test("a long horizontal drag IS an arrow, though it has no height", () => {
    const a = normaliseArrow({ x: 100, y: 200 }, { x: 100 + MIN_ARROW_PX * 4, y: 200 }, FRAME);
    expect(a).toBeDefined();
    expect(a!.from.y).toBe(a!.to.y);
  });

  test("a drag off the edge is clamped into the capture, not dropped", () => {
    const a = normaliseArrow({ x: -200, y: -50 }, { x: 5000, y: 900 }, FRAME)!;
    expect(a.from).toEqual({ x: 0, y: 0 });
    expect(a.to).toEqual({ x: 1, y: 1 });
  });

  test("a box normalises either way round, and a click is not a box", () => {
    const forward = normaliseBox({ x: 200, y: 100 }, { x: 600, y: 300 }, FRAME)!;
    const backward = normaliseBox({ x: 600, y: 300 }, { x: 200, y: 100 }, FRAME)!;
    expect(backward).toEqual(forward);
    // Field by field with a tolerance: 0.6 - 0.2 is 0.39999999999999997 in
    // binary floating point, and a normalised rectangle is a ratio of two
    // measurements rather than a number anyone typed.
    expect(forward.rect.x).toBeCloseTo(0.2, 12);
    expect(forward.rect.y).toBeCloseTo(0.2, 12);
    expect(forward.rect.width).toBeCloseTo(0.4, 12);
    expect(forward.rect.height).toBeCloseTo(0.4, 12);
    expect(normaliseBox({ x: 200, y: 100 },
                        { x: 200 + MIN_BOX_PX - 1, y: 100 + MIN_BOX_PX - 1 }, FRAME))
      .toBeUndefined();
  });

  test("an ellipse is the same rectangle with a different shape", () => {
    const r = normaliseBox({ x: 200, y: 100 }, { x: 600, y: 300 }, FRAME, "rect")!;
    const e = normaliseBox({ x: 200, y: 100 }, { x: 600, y: 300 }, FRAME, "ellipse")!;
    expect(e.rect).toEqual(r.rect);
    expect(e.shape).toBe("ellipse");
  });

  test("empty text is not an annotation", () => {
    // An invisible object that can still be selected and moved is how a canvas
    // starts feeling haunted.
    expect(makeText({ x: 10, y: 10 }, "   ", FRAME)).toBeUndefined();
    expect(makeText({ x: 10, y: 10 }, "", FRAME)).toBeUndefined();
  });

  test("text is trimmed and capped", () => {
    const t = makeText({ x: 500, y: 50 }, `  hello  `, FRAME)!;
    expect(t.text).toBe("hello");
    const long = makeText({ x: 0, y: 0 }, "x".repeat(MAX_ANNOTATION_TEXT + 50), FRAME)!;
    expect(long.text).toHaveLength(MAX_ANNOTATION_TEXT);
  });

  test("undo is last-in-first-out", () => {
    expect(undoLastAnnotation([ARROW, BOX, TEXT])).toEqual([ARROW, BOX]);
    expect(undoLastAnnotation([])).toEqual([]);
  });

  test("everything these produce is something parseShot accepts", () => {
    const made = [
      normaliseArrow({ x: 10, y: 10 }, { x: 400, y: 300 }, FRAME)!,
      normaliseBox({ x: 20, y: 20 }, { x: 300, y: 200 }, FRAME, "ellipse")!,
      makeText({ x: 40, y: 40 }, "note", FRAME)!,
    ];
    const doc = clone(fixture);
    doc.version = 2;
    doc.decoration.annotations = made;
    expect(validateV2(doc), JSON.stringify(validateV2.errors, null, 2)).toBe(true);
    expect(parseShot(doc).decoration.annotations).toEqual(made);
  });
});

describe("the arrow's geometry", () => {
  test("the head sits at the tip and the shaft stops at its base", () => {
    const g = arrowGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 4);
    expect(g.head[0]).toEqual({ x: 100, y: 0 });
    // The shaft ends where the head begins — drawing the full shaft under the
    // head looks identical at full alpha and shows a seam at anything less.
    expect(g.shaft.to.x).toBeCloseTo(100 - 4 * ARROW_HEAD_LENGTH_RATIO, 6);
    expect(g.shaft.from).toEqual({ x: 0, y: 0 });
  });

  test("the head's back corners straddle the shaft, perpendicular to it", () => {
    const g = arrowGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 4);
    const [, left, right] = g.head;
    expect(left.x).toBeCloseTo(right.x, 6);          // same distance back
    expect(left.y).toBeCloseTo(-right.y, 6);         // equal and opposite
    expect(Math.abs(left.y)).toBeGreaterThan(0);
  });

  /**
   * A short arrow is mostly head; an arrow whose head overruns its own tail is
   * a triangle pointing backwards. The clamp is what keeps the second from
   * happening, and it is the kind of thing that only shows up on the one drag
   * someone makes at 15 px.
   */
  test("the head never overruns the tail, however short the arrow", () => {
    const g = arrowGeometry({ x: 0, y: 0 }, { x: 20, y: 0 }, 40);
    expect(g.shaft.to.x).toBeGreaterThanOrEqual(0);
    expect(g.shaft.to.x).toBeCloseTo(10, 6);   // half the arrow, no further
  });

  test("a zero-length arrow degenerates without dividing by zero", () => {
    const g = arrowGeometry({ x: 7, y: 7 }, { x: 7, y: 7 }, 4);
    for (const p of [g.shaft.from, g.shaft.to, ...g.head]) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
  });

  test("a diagonal arrow points where it was dragged", () => {
    const g = arrowGeometry({ x: 0, y: 0 }, { x: 300, y: 400 }, 5);
    expect(g.head[0]).toEqual({ x: 300, y: 400 });
    // The base is back along the same line: same ratio of x to y.
    expect(g.shaft.to.x / g.shaft.to.y).toBeCloseTo(300 / 400, 6);
  });
});

describe("annotations are positioned against the CONTENT, not the canvas", () => {
  const content = { x: 100, y: 50, width: 800, height: 400 };

  test("an arrow's ends land on the fractions of the content they name", () => {
    const [a] = annotationLayouts([ARROW], content, 1);
    if (!a || a.kind !== "arrow") throw new Error("unreachable");
    expect(a.geometry.shaft.from).toEqual({ x: 100 + 0.1 * 800, y: 50 + 0.2 * 400 });
    expect(a.geometry.head[0]).toEqual({ x: 100 + 0.6 * 800, y: 50 + 0.7 * 400 });
  });

  /**
   * The ticket's SECOND acceptance criterion, stated as directly as it can be:
   * change the padding — which moves and resizes the content inside a bigger
   * canvas — and the annotation follows the picture rather than staying put on
   * the canvas.
   */
  test("more padding moves annotations WITH the content, not with the canvas", () => {
    const base = shotWith([ARROW, BOX], { paddingPct: 0 });
    const padded = shotWith([ARROW, BOX], { paddingPct: 0.2 });
    const a = layoutStill(base);
    const b = layoutStill(padded);

    expect(b.canvas.width).toBeGreaterThan(a.canvas.width);
    const arrowA = a.annotations[0], arrowB = b.annotations[0];
    if (!arrowA || !arrowB || arrowA.kind !== "arrow" || arrowB.kind !== "arrow") {
      throw new Error("unreachable");
    }

    // Moved by exactly the content's own shift — the annotation is attached to
    // the picture, and the picture moved.
    const dx = b.content.x - a.content.x;
    const dy = b.content.y - a.content.y;
    expect(arrowB.geometry.head[0].x - arrowA.geometry.head[0].x).toBeCloseTo(dx, 6);
    expect(arrowB.geometry.head[0].y - arrowA.geometry.head[0].y).toBeCloseTo(dy, 6);
    // And it did NOT stay where it was on the canvas, which is the failure this
    // criterion exists to rule out. A control, not a restatement: if dx were 0
    // the assertion above would pass for a canvas-anchored annotation too.
    expect(dx).not.toBe(0);
  });

  test("a canvas preset that grows the canvas does not move the annotation off the picture", () => {
    const natural = layoutStill(shotWith([BOX], { canvas: "natural" }));
    const wide = layoutStill(shotWith([BOX], { canvas: "16:9" }));
    for (const l of [natural, wide]) {
      const b = l.annotations[0];
      if (!b || b.kind !== "box") throw new Error("unreachable");
      // Still inside the content rect, wherever the content ended up.
      expect(b.rect.x).toBeGreaterThanOrEqual(l.content.x);
      expect(b.rect.x + b.rect.width).toBeLessThanOrEqual(l.content.x + l.content.width + 1e-9);
    }
  });

  test("stroke widths and text sizes are POINTS, so scale changes them", () => {
    const [thin] = annotationLayouts([BOX], content, 1);
    const [thick] = annotationLayouts([BOX], content, 2);
    if (!thin || !thick || thin.kind !== "box" || thick.kind !== "box") throw new Error("unreachable");
    expect(thin.strokePx).toBe(ANNOTATION_WEIGHTS.bold);
    expect(thick.strokePx).toBe(ANNOTATION_WEIGHTS.bold * 2);

    const [small] = annotationLayouts([TEXT], content, 1);
    const [big] = annotationLayouts([TEXT], content, 3);
    if (!small || !big || small.kind !== "text" || big.kind !== "text") throw new Error("unreachable");
    expect(small.sizePx).toBe(ANNOTATION_TEXT_SIZES.large);
    expect(big.sizePx).toBe(ANNOTATION_TEXT_SIZES.large * 3);
  });
});

describe("a 1x export scales the markup with everything else", () => {
  /**
   * `scaleStillLayout` scales the RESOLVED annotations rather than resolving
   * them again, and the two must agree. They do because every quantity is a
   * length and the arrow head's "never longer than half the arrow" clamp
   * compares two things that scale together — but that is an argument, and this
   * is the check.
   */
  test("scaling a resolved layout equals resolving it at the smaller scale", () => {
    const content = { x: 100, y: 50, width: 800, height: 400 };
    const factor = 0.5;
    const scaled = annotationLayouts([ARROW], content, 2)
      .map((a) => scaleStillLayout({
        canvas: { width: 1000, height: 500 }, content, alpha: false,
        redactions: [], annotations: [a],
      }, factor).annotations[0]);
    const resolvedAtHalf = annotationLayouts([ARROW], {
      x: content.x * factor, y: content.y * factor,
      width: content.width * factor, height: content.height * factor,
    }, 2 * factor);

    const a = scaled[0], b = resolvedAtHalf[0];
    if (!a || !b || a.kind !== "arrow" || b.kind !== "arrow") throw new Error("unreachable");
    expect(a.strokePx).toBeCloseTo(b.strokePx, 6);
    expect(a.geometry.head[0].x).toBeCloseTo(b.geometry.head[0].x, 6);
    expect(a.geometry.head[0].y).toBeCloseTo(b.geometry.head[0].y, 6);
    expect(a.geometry.shaft.to.x).toBeCloseTo(b.geometry.shaft.to.x, 6);
  });
});

describe("shot-2: the version is the minimum that can express the document", () => {
  test("a shot with no annotations is written as v1, without the key", () => {
    const shot = parseShot(fixture);
    expect(versionFor(shot)).toBe(1);
    const doc = JSON.parse(JSON.stringify(shotForWrite(shot)));
    expect(doc.version).toBe(1);
    // Not `annotations: []` — shot-1 says additionalProperties: false, so the
    // key at all would make the document fail its own schema.
    expect("annotations" in doc.decoration).toBe(false);
  });

  test("adding an annotation makes it v2; removing the last one takes it back", () => {
    const shot: Shot = parseShot(fixture);
    const marked: Shot = { ...shot, decoration: { ...shot.decoration, annotations: [ARROW] } };
    expect(versionFor(marked)).toBe(2);
    const doc = JSON.parse(JSON.stringify(shotForWrite(marked)));
    expect(doc.version).toBe(2);
    expect(validateV2(doc), JSON.stringify(validateV2.errors, null, 2)).toBe(true);

    const unmarked: Shot = { ...marked, decoration: { ...marked.decoration, annotations: [] } };
    expect(versionFor(unmarked)).toBe(1);
    expect(JSON.parse(JSON.stringify(shotForWrite(unmarked))).version).toBe(1);
  });

  /**
   * The ticket's FIRST acceptance criterion: an annotated still re-opened after
   * a restart is fully editable, every annotation still on the right pixel. A
   * restart is exactly a write and a read, so that is what this is.
   */
  test("annotations survive a write and a read, unchanged", () => {
    const shot: Shot = parseShot(fixture);
    const all: Annotation[] = [ARROW, BOX, TEXT];
    const marked: Shot = { ...shot, decoration: { ...shot.decoration, annotations: all } };
    const onDisk = JSON.stringify(shotForWrite(marked), null, 2);
    const reopened = parseShot(JSON.parse(onDisk));
    expect(reopened.decoration.annotations).toEqual(all);
    // And writing it again produces the same bytes — no drift across restarts.
    expect(JSON.stringify(shotForWrite(reopened), null, 2)).toBe(onDisk);
  });

  test("a v1 document carrying an annotation is refused", () => {
    const doc = clone(fixture);
    doc.decoration.annotations = [ARROW];
    expect(doc.version).toBe(1);
    expect(() => parseShot(doc)).toThrow(/needs version 2/);
  });

  test("a v1 document with an EMPTY array is fine — that is not a v2 feature", () => {
    // Not pedantry for its own sake: `Decoration` always carries the array in
    // memory, so a stored shot that has been parsed, edited and handed back
    // would otherwise be refused for a key it never asked for — which is what
    // `still:writeShot` does on every shot.
    const doc = clone(fixture);
    doc.decoration.annotations = [];
    expect(parseShot(doc).decoration.annotations).toEqual([]);
  });

  test("a malformed annotation is refused, with the index and the field named", () => {
    const bad: [string, unknown, RegExp, string?][] = [
      ["an unknown kind", { kind: "scribble" }, /annotations\[0\]\.kind/],
      ["an arrow with no weight", { kind: "arrow", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }, /weight/],
      ["a point outside 0..1", { kind: "arrow", from: { x: -0.1, y: 0 }, to: { x: 1, y: 1 }, weight: "thin" }, /from/],
      ["a box with zero area", { kind: "box", shape: "rect", weight: "thin", rect: { x: 0, y: 0, width: 0, height: 0.2 } }, /rect/],
      // NB not in the schema-agreement loop below: a SUM constraint
      // (x + width <= 1) is not expressible in JSON Schema, so the loader
      // carries it alone — exactly as the redaction case already documents.
      ["a box past the edge", { kind: "box", shape: "rect", weight: "thin", rect: { x: 0.9, y: 0, width: 0.2, height: 0.2 } }, /rect/, "loader only"],
      ["empty text", { kind: "text", at: { x: 0, y: 0 }, text: "  ", size: "regular" }, /text/],
      ["an unknown size", { kind: "text", at: { x: 0, y: 0 }, text: "hi", size: "huge" }, /size/],
      ["a field nobody declared", { kind: "text", at: { x: 0, y: 0 }, text: "hi", size: "small", colour: "#fff" }, /does not know/],
    ];
    for (const [name, a, pattern, loaderOnly] of bad) {
      const doc = clone(fixture);
      doc.version = 2;
      doc.decoration.annotations = [a];
      expect(() => parseShot(doc), name).toThrow(ShotLoadError);
      expect(() => parseShot(doc), name).toThrow(pattern);
      // And the schema agrees — the two must not drift the way anchors' did.
      if (!loaderOnly) expect(validateV2(doc), `${name}: the schema accepted it`).toBe(false);
    }
  });
});

describe("text renders identically in preview and export", () => {
  /**
   * The third acceptance criterion, checked the only way it can be without two
   * rasterisers to compare: there is ONE font string and ONE place that lays
   * text out, so preview and export have nothing to disagree about. This repo
   * has fixed the "one value, two copies" defect five times; this is the guard
   * against the sixth.
   */
  test("the font comes from one constant, and the size is the only variable", () => {
    expect(annotationFont(24)).toContain("24px");
    expect(annotationFont(24)).toBe(annotationFont(24));
    expect(annotationFont(12)).not.toBe(annotationFont(24));
  });

  test("line spacing is a constant, not a measurement", () => {
    // `measureText` is the one part of this a different rasteriser can answer
    // differently. Neither path measures, so neither can disagree.
    const src = readFileSync(join(root, "transform/src/still-render.ts"), "utf8");
    // The CALL, not the word: the file explains why it does not measure, and a
    // check that forbids a file from naming the rule it keeps is a check
    // somebody deletes. (Learned one file over, in `library-seam.test.ts`.)
    expect(src).not.toMatch(/\.measureText\(/);
    expect(ANNOTATION_LINE_HEIGHT).toBeGreaterThan(1);
  });

  test("there is exactly one accent colour, and it is not configurable per annotation", () => {
    expect(ANNOTATION_ACCENT).toMatch(/^#[0-9a-f]{6}$/i);
    // A colour field would be a value nothing writes and nothing reads — the
    // cost the STC-300 audit priced. If one is ever added, it belongs in the
    // schema with something writing it.
    const schema = load("schema/shot-2.schema.json");
    const items = schema.properties.decoration.properties.annotations.items.oneOf;
    for (const variant of items) {
      expect(Object.keys(variant.properties)).not.toContain("color");
      expect(Object.keys(variant.properties)).not.toContain("colour");
    }
  });
});

/** The display-crop fixture, with annotations and an overridden decoration. */
function shotWith(annotations: Annotation[], over: Record<string, unknown>): Shot {
  const doc = clone(fixture);
  doc.version = 2;
  doc.decoration = { ...doc.decoration, ...over, annotations };
  return parseShot(doc);
}
