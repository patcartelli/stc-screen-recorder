import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listTakes } from "../src/takes.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "stc-lib-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const env = () => ({ STC_RECORDINGS_DIR: root } as NodeJS.ProcessEnv);

function makeTake(name: string, over: { anchors?: any; events?: any; mp4?: boolean } = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const anchors = over.anchors !== undefined ? over.anchors : {
    version: 1,
    timebase: { numer: 125, denom: 3 },
    t0Ns: "1000",
    display: { id: 1, pointWidth: 1920, pointHeight: 1080, pixelWidth: 3840, pixelHeight: 2160,
               backingScale: 2, originX: 0, originY: 0 },
    capture: { width: 3840, height: 2160, codec: "h264", firstFrameNs: 200_000_000 },
    files: { display: "display.mp4" },
    stop: { t: 20_000_000_000, reason: "user" },
  };
  if (anchors !== null) {
    writeFileSync(join(dir, "anchors.json"),
      typeof anchors === "string" ? anchors : JSON.stringify(anchors));
  }
  const events = over.events !== undefined ? over.events : { version: 1, events: [
    { t: 1, kind: "move", x: 1, y: 1 }, { t: 2, kind: "move", x: 2, y: 2 },
  ] };
  if (events !== null) writeFileSync(join(dir, "events.json"), JSON.stringify(events));
  if (over.mp4 !== false) writeFileSync(join(dir, "display.mp4"), Buffer.alloc(4096));
  return dir;
}

describe("listTakes", () => {
  test("reads metadata from the sidecars", async () => {
    makeTake("2026-08-24_10-00-00");
    const { takes, invalid } = await listTakes(env());
    expect(invalid).toEqual([]);
    expect(takes.length).toBe(1);
    const t = takes[0]!;
    expect(t.name).toBe("2026-08-24_10-00-00");
    expect(t.durationMs).toBe(20_000);
    expect(t.width).toBe(3840);
    expect(t.height).toBe(2160);
    expect(t.events).toBe(2);
    expect(t.bytes).toBeGreaterThan(4000);
  });

  test("newest first, so the take you just made is at the top", async () => {
    makeTake("2026-08-24_09-00-00");
    makeTake("2026-08-24_11-00-00");
    makeTake("2026-08-24_10-00-00");
    const { takes } = await listTakes(env());
    expect(takes.map((t) => t.name)).toEqual([
      "2026-08-24_11-00-00", "2026-08-24_10-00-00", "2026-08-24_09-00-00",
    ]);
  });

  test("a missing recordings folder is empty, not an error", async () => {
    const { takes, invalid } = await listTakes({ STC_RECORDINGS_DIR: join(root, "nope") });
    expect(takes).toEqual([]);
    expect(invalid).toEqual([]);
  });

  test("a stray file in the folder is ignored, not treated as a take", async () => {
    makeTake("2026-08-24_10-00-00");
    writeFileSync(join(root, ".DS_Store"), "junk");
    const { takes, invalid } = await listTakes(env());
    expect(takes.length).toBe(1);
    expect(invalid).toEqual([]);
  });
});

describe("listTakes — broken takes are reported, never fatal", () => {
  test("one unreadable take does not hide the good ones", async () => {
    makeTake("2026-08-24_10-00-00");
    makeTake("2026-08-24_11-00-00", { anchors: "{ not json" });
    const { takes, invalid } = await listTakes(env());
    expect(takes.map((t) => t.name)).toEqual(["2026-08-24_10-00-00"]);
    expect(invalid.length).toBe(1);
    expect(invalid[0]!.name).toBe("2026-08-24_11-00-00");
    expect(invalid[0]!.reason).toMatch(/anchors/i);
  });

  test("a directory with no anchors.json is reported as not a recording", async () => {
    makeTake("2026-08-24_10-00-00", { anchors: null });
    const { takes, invalid } = await listTakes(env());
    expect(takes).toEqual([]);
    expect(invalid[0]!.reason).toMatch(/anchors/i);
  });

  test("a take whose video is missing is reported, not silently listed", async () => {
    // The interrupted-start case: sidecars written, capture never produced a file.
    makeTake("2026-08-24_10-00-00", { mp4: false });
    const { takes, invalid } = await listTakes(env());
    expect(takes).toEqual([]);
    expect(invalid[0]!.reason).toMatch(/display\.mp4|video/i);
  });

  test("an unsupported schema version is reported rather than guessed at", async () => {
    makeTake("2026-08-24_10-00-00", { anchors: { version: 99, capture: {}, stop: {} } });
    const { takes, invalid } = await listTakes(env());
    expect(takes).toEqual([]);
    expect(invalid[0]!.reason).toMatch(/version/i);
  });

  test("missing events.json degrades to zero rather than discarding the take", async () => {
    // The video is the recording; events are an overlay. A take with a readable
    // video is still worth listing and playing.
    makeTake("2026-08-24_10-00-00", { events: null });
    const { takes, invalid } = await listTakes(env());
    expect(takes.length).toBe(1);
    expect(takes[0]!.events).toBe(0);
    expect(invalid).toEqual([]);
  });
});
