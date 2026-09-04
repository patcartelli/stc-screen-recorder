import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));

/**
 * Sidecars from a real 11 s take recorded from the app on 2026-09-04
 * (display.mp4 and camera.mp4 omitted), the STC-309 counterpart of
 * fixtures/real-session: it pins what only a real pointer produces. The take
 * hovered a text field, links and the desktop and clicked in the field; the
 * export was WATCHED — I-beam over the field, hand over the links, arrow
 * elsewhere, the click highlight under the I-beam, all in step with the
 * video. That watch is the evidence the shapes are RIGHT; nothing below can
 * tell a correct shape from a uniformly wrong one. What this file holds is
 * the producer's contract: v2, in order, change-only, names the compositor
 * can draw.
 *
 * The crosshair never appears — nothing on a normal desktop shows one — so
 * "every shape in the enum" is asserted as "every shape seen is in the enum"
 * plus the three the watch confirmed. anchors.camera.present is true and
 * camera.mp4 is not committed, so this session is for these checks only;
 * loadSession would correctly refuse it.
 */
const anchors = load("fixtures/real-session-cursor/anchors.json");
const doc = load("fixtures/real-session-cursor/events.json");
const events = doc.events as any[];
const cursor = events.filter((e) => e.kind === "cursor");
const enumShapes: string[] = load("schema/events-2.schema.json").definitions.cursorEvent.properties.shape.enum;

describe("real captured session with cursor shapes (STC-309) — sidecar semantics", () => {
  test("the helper wrote events-2 and anchors-2, and both validate", () => {
    const ajv = new Ajv({ allErrors: true, strict: true });
    expect(doc.version).toBe(2);
    for (const [d, schema] of [
      [doc, "schema/events-2.schema.json"],
      [anchors, "schema/anchors-2.schema.json"],
    ] as const) {
      const v = ajv.compile(load(schema));
      expect(v(d), JSON.stringify(v.errors, null, 2)).toBe(true);
    }
  });

  test("cursor events are present, and the shapes the watch confirmed are among them", () => {
    expect(cursor.length).toBeGreaterThan(0);
    const seen = new Set(cursor.map((c) => c.shape as string));
    for (const s of seen) expect(enumShapes, `shape ${s} is not in the events-2 enum`).toContain(s);
    for (const s of ["ibeam", "pointingHand", "arrow"]) expect(seen, `${s} never appeared`).toContain(s);
  });

  test("emit only on change: no two consecutive cursor events share a shape", () => {
    for (let i = 1; i < cursor.length; i++) {
      expect(cursor[i].shape, `cursor event ${i} repeats ${cursor[i - 1].shape} at t=${cursor[i].t}`)
        .not.toBe(cursor[i - 1].shape);
    }
  });

  test("a cursor event carries a shape and nothing positional", () => {
    for (const c of cursor) {
      expect(typeof c.shape).toBe("string");
      expect(c.x).toBeUndefined();
      expect(c.y).toBeUndefined();
      expect(c.button).toBeUndefined();
    }
  });

  test("times are integer nanoseconds, non-negative and monotonic across BOTH clocks", () => {
    // Moves carry CGEvent.timestamp and cursor events the sampler's own
    // reading of the same mach clock; the helper orders the file on the way
    // out (orderedEvents), and this is what that promise looks like kept.
    expect(events.every((e) => Number.isInteger(e.t) && e.t >= 0)).toBe(true);
    expect(events.every((e, i) => i === 0 || e.t >= events[i - 1].t)).toBe(true);
  });

  test("cursor events are interleaved with moves, not bunched at either end", () => {
    // The pointer changed shape WHILE it was moving about — a hover is a move
    // followed by a shape change. A file where every cursor event preceded
    // the first move, or followed the last, would be a sampler that ran at
    // the wrong time.
    let withMotionBetween = 0;
    for (let i = 1; i < cursor.length; i++) {
      const between = events.filter((e) => e.kind === "move" && e.t > cursor[i - 1].t && e.t < cursor[i].t);
      if (between.length > 0) withMotionBetween++;
    }
    expect(withMotionBetween, "no motion between any two shape changes").toBeGreaterThan(0);
    const firstMove = events.find((e) => e.kind === "move")!.t;
    const lastMove = [...events].reverse().find((e) => e.kind === "move")!.t;
    expect(cursor.some((c) => c.t > firstMove && c.t < lastMove), "no shape change inside the motion").toBe(true);
  });

  test("presses and releases still pair up with the cursor events in the file", () => {
    const btn = events.filter((e) => e.kind === "down" || e.kind === "up");
    expect(btn.length).toBeGreaterThan(0);
    let depth = 0;
    for (const b of btn) {
      depth += b.kind === "down" ? 1 : -1;
      expect(depth).toBeGreaterThanOrEqual(0);
      expect(depth).toBeLessThanOrEqual(1);
    }
    expect(depth, "recording ended mid-press").toBe(0);
  });

  test("coordinates lie within the captured display", () => {
    const d = anchors.display;
    const out = events.filter((e) => e.kind !== "cursor" && (
      e.x < d.originX - 1 || e.x > d.originX + d.pointWidth + 1 ||
      e.y < d.originY - 1 || e.y > d.originY + d.pointHeight + 1));
    expect(out.length, `${out.length} events outside ${d.pointWidth}x${d.pointHeight}pt`).toBe(0);
  });
});
