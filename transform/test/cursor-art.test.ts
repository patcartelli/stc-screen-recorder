import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CURSOR_SHAPES, DEFAULT_CURSOR_SHAPE, OUTLINE_PT, artFor, drawCursor, type PathCommand,
} from "../src/cursor-art.js";
import { recorder } from "./_canvas-recorder.js";

const root = join(__dirname, "..", "..");
const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));

function points(path: readonly PathCommand[]): [number, number][] {
  const out: [number, number][] = [];
  for (const c of path) {
    if (c[0] === "M" || c[0] === "L") out.push([c[1], c[2]]);
    if (c[0] === "Q") out.push([c[1], c[2]], [c[3], c[4]]);
  }
  return out;
}

describe("the pointer set is one list, held in two places", () => {
  test("CURSOR_SHAPES equals the events-2 schema's shape enum, in order", () => {
    // A shape the schema admits but the compositor cannot draw would be an
    // event that silently draws the wrong pointer; a shape the compositor can
    // draw but the schema refuses could never be recorded.
    const schema = load("schema/events-2.schema.json");
    expect(schema.definitions.cursorEvent.properties.shape.enum).toEqual(CURSOR_SHAPES);
  });

  test("the default shape is the arrow, and it is in the set", () => {
    expect(DEFAULT_CURSOR_SHAPE).toBe("arrow");
    expect(CURSOR_SHAPES).toContain(DEFAULT_CURSOR_SHAPE);
  });

  test.each(CURSOR_SHAPES)("%s: a closed outline with its hotspot inside its bounds", (shape) => {
    const { path } = artFor(shape);
    expect(path[0]![0]).toBe("M");
    expect(path[path.length - 1]![0]).toBe("Z");
    const pts = points(path);
    expect(pts.length).toBeGreaterThan(3);
    // The hotspot is where the event's (x, y) lands. Artwork that does not
    // reach its own origin would be drawn beside the point it claims.
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    expect(Math.min(...xs)).toBeLessThanOrEqual(0);
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.min(...ys)).toBeLessThanOrEqual(0);
    expect(Math.max(...ys)).toBeGreaterThanOrEqual(0);
  });

  test("the arrow's hotspot is its tip, so the system's event location lands on the point", () => {
    const pts = points(artFor("arrow").path);
    expect(pts[0]).toEqual([0, 0]);
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("drawCursor", () => {
  test("places the hotspot at (x, y) and scales points to pixels through the context transform", () => {
    const { ctx, ops } = recorder();
    drawCursor(ctx, "arrow", 123.5, 45.25, 2.5);
    expect(ops[0]).toBe("save()");
    expect(ops[1]).toBe("translate(123.5,45.25)");
    expect(ops[2]).toBe("scale(2.5,2.5)");
    expect(ops[ops.length - 1]).toBe("restore()");
  });

  test("a 1-point white outline under a black fill: stroke before fill, width 2 points", () => {
    const { ctx, ops } = recorder();
    drawCursor(ctx, "arrow", 0, 0, 1);
    const stroke = ops.indexOf("stroke()");
    const fill = ops.indexOf("fill()");
    expect(stroke).toBeGreaterThan(-1);
    expect(fill).toBeGreaterThan(stroke);
    expect(ops.slice(0, stroke)).toContain("strokeStyle=#ffffff");
    expect(ops.slice(0, stroke)).toContain(`lineWidth=${OUTLINE_PT * 2}`);
    expect(ops.slice(stroke, fill)).toContain("fillStyle=#000000");
  });

  test("the shape asked for is the shape traced", () => {
    const trace = (shape: (typeof CURSOR_SHAPES)[number]) => {
      const { ctx, ops } = recorder();
      drawCursor(ctx, shape, 0, 0, 1);
      return ops.filter((o) => /^(moveTo|lineTo|quadraticCurveTo)\(/.test(o)).join(";");
    };
    const traces = CURSOR_SHAPES.map(trace);
    expect(new Set(traces).size).toBe(CURSOR_SHAPES.length);
    expect(trace("arrow")).toBe(trace("arrow"));
  });
});
