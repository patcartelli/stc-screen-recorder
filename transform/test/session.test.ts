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

  // "a version 2 anchors document loads" above already covers a v2 anchors
  // document WITHOUT a camera block loading fine (offsetAnchors carries none).

  test("a v2 anchors document with camera.present:true is refused rather than silently dropping the PiP", async () => {
    // loadSession has no camera input yet (no camera file path, no cameraFrames
    // demux — that's increment 3). Loading this "successfully" would leave
    // render() quietly returning pip: null forever, which is exactly the class
    // of silent failure the offset-drift check above exists to make loud.
    await expect(loadSession({
      anchors: offsetAnchors({
        version: 2,
        camera: {
          present: true,
          device: "Fixture Camera",
          width: 1280,
          height: 720,
          firstFramePtsNs: 0,
          lastFramePtsNs: 1_000_000_000,
          frameIntervalNs: 17_000_000,
        },
      } as any),
      events: { version: 1, events: [{ t: 0, kind: "move", x: 1, y: 2 }] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
    })).rejects.toThrow(/camera/i);
  });
});

describe("loading a camera track", () => {
  const camAnchors = (over: any = {}) => offsetAnchors({
    version: 2,
    camera: {
      present: true, device: "Fixture Camera", width: 320, height: 180,
      firstFramePtsNs: 1_035_500_000, lastFramePtsNs: 3_024_500_000,
      frameIntervalNs: 17_000_000,
    },
    files: { display: "display.mp4", camera: "camera.mp4" },
    ...over,
  });

  test("a camera track becomes session.cameraFrames", async () => {
    const s = await loadSession({
      anchors: camAnchors(),
      events: { version: 1, events: [] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
      cameraMp4: mp4("fixtures/pip/camera.mp4"),
    });
    expect(s.cameraFrames?.length).toBe(118);
    expect(s.cameraFrames?.[0]).toBe(1_035_500_000);
  });

  test("a session claiming a camera but given no camera.mp4 is refused", async () => {
    // Silently loading it as camera-less would leave render() returning
    // pip: null for a take that has one, which looks like a rendering bug.
    await expect(loadSession({
      anchors: camAnchors(),
      events: { version: 1, events: [] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
    })).rejects.toThrow(/camera/i);
  });

  test("a camera whose demuxed start disagrees with the anchors is refused", async () => {
    // Same reasoning as the display track's existing offset check: the helper
    // wrote down what it measured, the file preserves a quantised version, and
    // comparing them turns a silent seconds-long desync into a loud failure.
    await expect(loadSession({
      anchors: camAnchors({ camera: { ...camAnchors().camera, firstFramePtsNs: 5_000_000_000 } }),
      events: { version: 1, events: [] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
      cameraMp4: mp4("fixtures/pip/camera.mp4"),
    })).rejects.toThrow(/camera.*offset|offset.*camera/i);
  });

  test("a v2 session with no camera still loads", async () => {
    const s = await loadSession({
      anchors: offsetAnchors({ version: 2, camera: { present: false } } as any),
      events: { version: 1, events: [] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
    });
    expect(s.cameraFrames).toBeUndefined();
  });
});
