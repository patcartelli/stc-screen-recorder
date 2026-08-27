import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSession } from "../src/session.js";

const root = join(__dirname, "..", "..");
const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const mp4 = (p: string) => {
  const b = readFileSync(join(root, p));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

/**
 * The PiP fixture as a WHOLE session — the thing the browser gate serves.
 *
 * `exportSession` itself needs WebCodecs and a canvas, neither of which exists
 * in Node, so the export sink's camera wiring is verified by the determinism
 * gate rather than here. What this file pins is the fixture: that
 * `fixtures/pip/display.mp4` and `fixtures/pip/anchors.json` genuinely belong
 * to each other, and that the camera track loads with the frame grid the gate
 * will index into. A gate that silently loads a camera-less session would
 * report a clean pass while testing nothing.
 */
describe("the PiP fixture loads as a complete two-track session", () => {
  test("display and camera tracks both load, and agree with the anchors", async () => {
    const s = await loadSession({
      anchors: load("fixtures/pip/anchors.json"),
      events: load("fixtures/pip/events.json"),
      displayMp4: mp4("fixtures/pip/display.mp4"),
      cameraMp4: mp4("fixtures/pip/camera.mp4"),
    });

    // loadSession's checkFrameOffset would have thrown if display.mp4 did not
    // belong to these anchors, so reaching here is the pairing assertion.
    expect(s.frames.length).toBeGreaterThan(0);
    expect(s.cameraVideo, "the sink cannot decode what loadSession did not demux").toBeDefined();
    expect(s.cameraVideo!.chunks.length).toBeGreaterThan(0);
    expect(s.cameraFrames!.length).toBe(118);
    expect(s.cameraFrames![0]).toBe(1_035_500_000);
  });

  test("the camera grid the gate indexes into is strictly increasing", async () => {
    // pip.frameIndex is fed to a FORWARD-only source in the export sink. A grid
    // that ever went backwards would make that source throw mid-export, and it
    // would do so only for takes whose camera hiccuped — the worst way to find
    // out. Cheap to assert, so assert it.
    const s = await loadSession({
      anchors: load("fixtures/pip/anchors.json"),
      events: load("fixtures/pip/events.json"),
      displayMp4: mp4("fixtures/pip/display.mp4"),
      cameraMp4: mp4("fixtures/pip/camera.mp4"),
    });
    const g = s.cameraFrames!;
    for (let i = 1; i < g.length; i++) {
      expect(g[i]!, `camera PTS went backwards at index ${i}`).toBeGreaterThan(g[i - 1]!);
    }
  });

  test("a camera-less session exposes no camera track, so no PiP is drawn", async () => {
    const s = await loadSession({
      anchors: load("fixtures/basic/anchors.json"),
      events: load("fixtures/basic/events.json"),
      displayMp4: mp4("fixtures/basic/display.mp4"),
    });
    expect(s.cameraVideo).toBeUndefined();
    expect(s.cameraFrames).toBeUndefined();
  });
});
