import { describe, test, expect } from "vitest";
import { composite } from "../src/compositor.js";
import type { FrameState } from "../src/render.js";
import { CIRCLE_PT, CLICK_HIGHLIGHT_PT } from "../src/cursor-art.js";
import { recorder } from "./_canvas-recorder.js";

/**
 * Node has no canvas, so this cannot check pixels — the browser gates do that,
 * and they compare the two sinks' pixels for real. What a recording context
 * CAN pin is the drawing ORDER and the numbers handed to the context: where
 * the hotspot lands, that the click highlight is under the pointer and sized
 * from the same scale, and that an invisible cursor draws nothing at all.
 */
function frameState(over: Partial<FrameState["cursor"]> = {}): FrameState {
  return {
    tick: 0, frameIndex: null, framePtsNs: null, pip: null,
    cursor: {
      x: 300.5, y: 200.25, vx: 0, vy: 0, pressed: false, visible: true,
      shape: "arrow", style: "default", pxPerPoint: 1.5, ...over,
    },
  };
}

function draw(fs: FrameState) {
  const { ctx, ops } = recorder();
  composite(ctx as unknown as OffscreenCanvasRenderingContext2D, null, null, fs, 640, 360);
  return ops;
}

describe("composite() draws the pointer at the hotspot", () => {
  test("the artwork is translated to exactly (cursor.x, cursor.y) and scaled by pxPerPoint", () => {
    const ops = draw(frameState());
    expect(ops).toContain("translate(300.5,200.25)");
    expect(ops).toContain("scale(1.5,1.5)");
  });

  test("an invisible cursor draws nothing after the frame", () => {
    const ops = draw(frameState({ visible: false }));
    expect(ops.filter((o) => /^(translate|arc|moveTo|stroke)\(/.test(o))).toEqual([]);
  });

  test("a click draws the highlight UNDER the pointer, centred on the hotspot, sized in points", () => {
    const ops = draw(frameState({ pressed: true }));
    const arc = ops.findIndex((o) => o.startsWith("arc("));
    const translate = ops.indexOf("translate(300.5,200.25)");
    expect(arc).toBeGreaterThan(-1);
    expect(arc).toBeLessThan(translate);
    expect(ops[arc]).toBe(`arc(300.5,200.25,${CLICK_HIGHLIGHT_PT * 1.5},0,${Math.PI * 2})`);
  });

  test("no highlight when no button is held", () => {
    const ops = draw(frameState({ pressed: false }));
    expect(ops.some((o) => o.startsWith("arc("))).toBe(false);
  });

  test("style: circle draws the placeholder disc at the hotspot and no artwork", () => {
    const ops = draw(frameState({ style: "circle", shape: "ibeam" }));
    expect(ops).toContain(`arc(300.5,200.25,${CIRCLE_PT * 1.5},0,${Math.PI * 2})`);
    expect(ops.some((o) => /^(translate|moveTo)\(/.test(o))).toBe(false);
    // white disc, black ring, ring width in points
    expect(ops.indexOf("fillStyle=#ffffff")).toBeLessThan(ops.indexOf("fill()"));
    expect(ops.indexOf("strokeStyle=#000000")).toBeLessThan(ops.indexOf("stroke()"));
    expect(ops).toContain(`lineWidth=${2 * 1.5}`);
  });

  test("style: circle still draws the click highlight under the disc", () => {
    const ops = draw(frameState({ style: "circle", pressed: true }));
    const arcs = ops.filter((o) => o.startsWith("arc("));
    expect(arcs[0]).toBe(`arc(300.5,200.25,${CLICK_HIGHLIGHT_PT * 1.5},0,${Math.PI * 2})`);
    expect(arcs[1]).toBe(`arc(300.5,200.25,${CIRCLE_PT * 1.5},0,${Math.PI * 2})`);
  });

  test("the FrameState's shape decides which artwork is traced", () => {
    // A compositor that ignored `shape` and always drew the arrow would pass
    // every positional test above. Two shapes must produce two traces.
    const outline = (ops: string[]) => ops.filter((o) => /^(moveTo|lineTo|quadraticCurveTo)\(/.test(o)).join(";");
    expect(outline(draw(frameState({ shape: "ibeam" })))).not.toBe(outline(draw(frameState({ shape: "arrow" }))));
  });
});
