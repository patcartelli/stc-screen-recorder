import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));

/**
 * Sidecars from an actual 8 s recording (display.mp4 omitted at 9.4 MB). These
 * pin the semantics that only real input produces: that a press and its release
 * pair up, that a drag is moves bracketed by down/up rather than its own kind,
 * and that coordinates land in display space. The capture that preceded this
 * one recorded 685 events and zero clicks, which was indistinguishable from a
 * broken button path until a capture with deliberate clicks existed.
 */
const anchors = load("fixtures/real-session/anchors.json");
const events = load("fixtures/real-session/events.json").events as any[];

describe("real captured session — sidecar semantics", () => {
  test("both sidecars validate against their schemas", () => {
    const ajv = new Ajv({ allErrors: true, strict: true });
    // events-2 since STC-309: the helper now writes version 2. This session
    // predates that and carries no cursor events, which is a valid v2 document
    // — the pinned session WITH shape changes is fixtures/real-session-cursor
    // (increment 4, needs a hardware take); until it exists the v2 claim here
    // is only that v1 content is a subset.
    for (const [doc, schema] of [
      [{ version: 2, events }, "schema/events-2.schema.json"],
      [anchors, "schema/anchors-1.schema.json"],
    ] as const) {
      const v = ajv.compile(load(schema));
      expect(v(doc), JSON.stringify(v.errors, null, 2)).toBe(true);
    }
  });

  test("times are integer nanoseconds, non-negative and monotonic", () => {
    expect(events.every((e) => Number.isInteger(e.t) && e.t >= 0)).toBe(true);
    expect(events.every((e, i) => i === 0 || e.t >= events[i - 1].t)).toBe(true);
  });

  test("presses and releases pair up — no orphaned button state", () => {
    const btn = events.filter((e) => e.kind === "down" || e.kind === "up");
    expect(btn.length).toBeGreaterThan(0);
    let depth = 0;
    for (const b of btn) {
      depth += b.kind === "down" ? 1 : -1;
      expect(depth, `button depth went to ${depth} at t=${b.t}`).toBeGreaterThanOrEqual(0);
      expect(depth).toBeLessThanOrEqual(1);
    }
    expect(depth, "recording ended mid-press").toBe(0);
  });

  test("every button event carries a button; moves never do", () => {
    for (const e of events) {
      if (e.kind === "down" || e.kind === "up") expect(Number.isInteger(e.button)).toBe(true);
      else expect(e.button).toBeUndefined();
    }
  });

  test("a drag is move events bracketed by down/up, not a distinct kind", () => {
    expect(new Set(events.map((e) => e.kind))).toEqual(new Set(["move", "down", "up"]));
    const btn = events.filter((e) => e.kind === "down" || e.kind === "up");
    let dragsWithMotion = 0;
    for (let i = 0; i + 1 < btn.length; i++) {
      if (btn[i].kind !== "down" || btn[i + 1].kind !== "up") continue;
      const held = events.filter((e) => e.kind === "move" && e.t > btn[i].t && e.t < btn[i + 1].t);
      if (held.length > 0) dragsWithMotion++;
    }
    expect(dragsWithMotion, "no press had motion while held").toBeGreaterThan(0);
  });

  test("coordinates lie within the captured display", () => {
    const d = anchors.display;
    const out = events.filter((e) =>
      e.x < d.originX - 1 || e.x > d.originX + d.pointWidth + 1 ||
      e.y < d.originY - 1 || e.y > d.originY + d.pointHeight + 1);
    expect(out.length, `${out.length} events outside ${d.pointWidth}x${d.pointHeight}pt`).toBe(0);
  });

  test("anchors records the exact first-frame offset and respects the encode cliff", () => {
    expect(Number.isInteger(anchors.capture.firstFrameNs)).toBe(true);
    expect(anchors.capture.firstFrameNs).toBeGreaterThanOrEqual(0);
    expect(anchors.capture.width).toBeLessThanOrEqual(3840);
    expect(anchors.capture.height).toBeLessThanOrEqual(2160);
    expect(typeof anchors.t0Ns).toBe("string");
  });
});
