import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSession, SessionLoadError } from "../src/session.js";
import type { Anchors } from "../src/types.js";

const root = join(__dirname, "..", "..");
const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const mp4 = (p: string) => {
  const b = readFileSync(join(root, p));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

/** anchors describing the offset fixture: frames begin 250 ms in */
function offsetAnchors(over: Partial<Anchors> = {}): any {
  return {
    version: 1,
    timebase: { numer: 125, denom: 3 },
    t0Ns: "1000",
    display: { id: 1, pointWidth: 640, pointHeight: 360, pixelWidth: 640, pixelHeight: 360,
               backingScale: 1, originX: 0, originY: 0 },
    capture: { width: 640, height: 360, codec: "h264", firstFrameNs: 250_000_000 },
    files: { display: "display.mp4" },
    ...over,
  };
}

describe("loadSession", () => {
  test("builds a session whose frame grid comes from the file, edit list included", async () => {
    const s = await loadSession({
      anchors: offsetAnchors(),
      events: { version: 1, events: [{ t: 0, kind: "move", x: 1, y: 2 }] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
    });
    expect(s.frames[0]).toBe(250_000_000);
    expect(s.frames.length).toBeGreaterThan(10);
    expect(s.events.length).toBe(1);
    expect(s.anchors.capture.width).toBe(640);
  });

  test("rejects a schema version it was not written for", async () => {
    await expect(loadSession({
      anchors: offsetAnchors({ version: 3 as any }),
      events: { version: 1, events: [] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
    })).rejects.toThrow(SessionLoadError);
  });

  test("rejects an events document of the wrong version", async () => {
    await expect(loadSession({
      anchors: offsetAnchors(),
      events: { version: 99, events: [] } as any,
      displayMp4: mp4("fixtures/offset/display.mp4"),
    })).rejects.toThrow(SessionLoadError);
  });

  test("cross-checks the recovered frame offset against what the helper measured", async () => {
    // The file carries the offset only as a timescale-quantised empty edit, so
    // a small disagreement is expected and fine. A large one means the reader
    // and the writer disagree about time — the exact bug that desynced the
    // cursor by 231 ms — and must not be papered over.
    await expect(loadSession({
      anchors: offsetAnchors({ capture: { width: 640, height: 360, codec: "h264",
                                          firstFrameNs: 900_000_000 } as any }),
      events: { version: 1, events: [] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
    })).rejects.toThrow(/offset/i);
  });

  test("tolerates quantisation-sized disagreement without complaint", async () => {
    const s = await loadSession({
      anchors: offsetAnchors({ capture: { width: 640, height: 360, codec: "h264",
                                          firstFrameNs: 250_000_000 + 9_000 } as any }),
      events: { version: 1, events: [] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
    });
    expect(s.frames[0]).toBe(250_000_000);
  });

  test("events are sorted by time even if the file is not", async () => {
    const s = await loadSession({
      anchors: offsetAnchors(),
      events: { version: 1, events: [
        { t: 500, kind: "move", x: 1, y: 1 },
        { t: 100, kind: "move", x: 2, y: 2 },
      ] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
    });
    expect(s.events.map((e) => e.t)).toEqual([100, 500]);
  });
});

describe("loader accepts v1 and v2 anchors", () => {
  // The helper does not emit v2 until increment 3. A loader that demanded v2
  // would break every grant test in the gap between increments.
  test("a version 1 anchors document still loads", async () => {
    const s = await loadSession({
      anchors: offsetAnchors({ version: 1 }),
      events: { version: 1, events: [{ t: 0, kind: "move", x: 1, y: 2 }] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
    });
    expect(s).toBeDefined();
  });

  test("a version 2 anchors document loads", async () => {
    const s = await loadSession({
      anchors: offsetAnchors({ version: 2 }),
      events: { version: 1, events: [{ t: 0, kind: "move", x: 1, y: 2 }] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
    });
    expect(s).toBeDefined();
  });

  test("a version 3 anchors document is rejected by name", async () => {
    await expect(loadSession({
      anchors: offsetAnchors({ version: 3 as any }),
      events: { version: 1, events: [{ t: 0, kind: "move", x: 1, y: 2 }] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
    })).rejects.toThrow(/version 3 is not supported/);
  });
});
