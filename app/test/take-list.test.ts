import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listTakes, setTakeLabel } from "../src/takes.js";

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

describe("listTakes — anchors version support (STC-262)", () => {
  const v2Anchors = (over: any = {}) => ({
    version: 2,
    timebase: { numer: 125, denom: 3 },
    t0Ns: "1000",
    display: { id: 1, pointWidth: 1920, pointHeight: 1080, pixelWidth: 3840, pixelHeight: 2160,
               backingScale: 2, originX: 0, originY: 0 },
    capture: { width: 3840, height: 2160, codec: "h264", firstFrameNs: 200_000_000 },
    files: { display: "display.mp4", camera: "camera.mp4" },
    camera: { present: true, device: "Fixture Camera", width: 1280, height: 720,
              firstFramePtsNs: 1_035_500_000, lastFramePtsNs: 3_024_500_000,
              frameIntervalNs: 17_000_000 },
    stop: { t: 20_000_000_000, reason: "user" },
    ...over,
  });

  // STC-232 increment 3 makes the helper emit v2 anchors. transform/src/session.ts
  // already accepts them; this scanner did not, so every new recording would have
  // been listed as unsupported while the transform loaded it fine.
  test("a v2 take with a camera track is listed, not rejected as unsupported", async () => {
    makeTake("2026-08-27_10-00-00", { anchors: v2Anchors() });
    const { takes, invalid } = await listTakes(env());
    expect(invalid, JSON.stringify(invalid)).toEqual([]);
    expect(takes.length).toBe(1);
    expect(takes[0]!.name).toBe("2026-08-27_10-00-00");
  });

  // The drift itself, pinned. These two gates live in different build units and
  // cannot share a constant, so nothing but this test stops them separating
  // again — which is exactly how STC-262 happened: one was widened, the other
  // was not, and every test stayed green because the fixtures are all v1.
  test("the take scanner and the transform accept the same anchors versions", () => {
    const repo = join(__dirname, "..", "..");
    const takesSrc = readFileSync(join(repo, "app/src/takes.ts"), "utf8");
    const sessionSrc = readFileSync(join(repo, "transform/src/session.ts"), "utf8");

    const listed = takesSrc.match(/SUPPORTED_ANCHORS_VERSIONS[^=]*=\s*\[([^\]]*)\]/)?.[1];
    expect(listed, "SUPPORTED_ANCHORS_VERSIONS not found in app/src/takes.ts — renamed?")
      .toBeDefined();
    const scanner = listed!.split(",").map((n) => Number(n.trim())).filter((n) => !Number.isNaN(n));

    const guard = sessionSrc.match(/anchors\?\.version !== \d+(?:\s*&&\s*anchors\?\.version !== \d+)*/)?.[0];
    expect(guard, "anchors version guard not found in transform/src/session.ts — rewritten?")
      .toBeDefined();
    const transform = [...guard!.matchAll(/!== (\d+)/g)].map((m) => Number(m[1]));

    expect(scanner.slice().sort(),
           `scanner accepts [${scanner}], transform accepts [${transform}]`)
      .toEqual(transform.slice().sort());
  });

  test("a version this build does not know is still rejected, by name", async () => {
    // Widening must not become "accept anything".
    makeTake("2026-08-27_11-00-00", { anchors: v2Anchors({ version: 3 }) });
    const { takes, invalid } = await listTakes(env());
    expect(takes).toEqual([]);
    expect(invalid.length).toBe(1);
    expect(invalid[0]!.reason).toMatch(/version 3 is not supported/);
  });
});

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

describe("take labels", () => {
  test("a take with no label reports none, and keeps its directory name", async () => {
    makeTake("2026-08-24_10-00-00");
    const { takes } = await listTakes(env());
    expect(takes[0]!.label).toBeUndefined();
    expect(takes[0]!.name).toBe("2026-08-24_10-00-00");
  });

  test("a label is read from take.json without disturbing identity", async () => {
    const dir = makeTake("2026-08-24_10-00-00");
    writeFileSync(join(dir, "take.json"), JSON.stringify({ version: 1, label: "Onboarding demo" }));
    const { takes } = await listTakes(env());
    expect(takes[0]!.label).toBe("Onboarding demo");
    // The directory name is the take's identity and its sort key — a label
    // must never become the thing the app orders or addresses takes by.
    expect(takes[0]!.name).toBe("2026-08-24_10-00-00");
  });

  test("labels do not affect ordering", async () => {
    const a = makeTake("2026-08-24_09-00-00");
    makeTake("2026-08-24_11-00-00");
    writeFileSync(join(a, "take.json"), JSON.stringify({ version: 1, label: "zzz last alphabetically" }));
    const { takes } = await listTakes(env());
    expect(takes.map((t) => t.name)).toEqual(["2026-08-24_11-00-00", "2026-08-24_09-00-00"]);
  });

  test("a corrupt take.json costs the label, not the take", async () => {
    const dir = makeTake("2026-08-24_10-00-00");
    writeFileSync(join(dir, "take.json"), "{ broken");
    const { takes, invalid } = await listTakes(env());
    expect(takes.length).toBe(1);
    expect(takes[0]!.label).toBeUndefined();
    expect(invalid).toEqual([]);
  });

  test("an over-long or blank label is rejected at write time", async () => {
    const dir = makeTake("2026-08-24_10-00-00");
    await expect(setTakeLabel(env(), dir, "   ")).rejects.toThrow(/empty/i);
    await expect(setTakeLabel(env(), dir, "x".repeat(300))).rejects.toThrow(/long/i);
  });

  test("setTakeLabel round-trips, and refuses a directory outside the folder", async () => {
    const dir = makeTake("2026-08-24_10-00-00");
    await setTakeLabel(env(), dir, "Bug repro");
    const { takes } = await listTakes(env());
    expect(takes[0]!.label).toBe("Bug repro");
    await expect(setTakeLabel(env(), "/etc", "nope")).rejects.toThrow(/outside/i);
  });
});

/**
 * STC-287. A user who ticks Camera gets no confirmation it worked, no notice
 * when it does not, and a PiP that arrives a beat late — which reads as "the
 * camera didn't work". The camera opens off the critical path deliberately
 * (Capture.swift: startRunning() blocks and must not delay every `started`
 * reply), so the gap is inherent and the fix is to STATE it. Measured across
 * five real takes, the PiP is absent for 1.26-1.39 s of playback.
 *
 * Three states, and they must never collapse into one: no camera asked for, a
 * camera that worked, and a camera that opened and recorded nothing.
 */
describe("listTakes — what the camera actually did (STC-287)", () => {
  const withCamera = (camera: unknown) => ({
    version: 2,
    timebase: { numer: 125, denom: 3 },
    t0Ns: "1000",
    display: { id: 1, pointWidth: 1920, pointHeight: 1080, pixelWidth: 3840, pixelHeight: 2160,
               backingScale: 2, originX: 0, originY: 0 },
    capture: { width: 3840, height: 2160, codec: "h264", firstFrameNs: 490_000_000 },
    camera,
    files: { display: "display.mp4" },
    stop: { t: 20_000_000_000, reason: "user" },
  });

  test("no camera block at all means no camera was asked for", async () => {
    makeTake("2026-01-01_00-00-00");
    const { takes } = await listTakes(env());
    expect(takes[0]!.camera).toBeUndefined();
  });

  test("a working camera reports the device and the gap the viewer will see", async () => {
    // Real numbers from 2026-08-30_09-48-47: the picture starts at 0.49 s and
    // the camera's first frame lands at 1.88 s.
    makeTake("2026-01-01_00-00-01", { anchors: withCamera({
      present: true, device: "FaceTime HD Camera", width: 1280, height: 720,
      firstFramePtsNs: 1_880_000_000, lastFramePtsNs: 7_416_000_000, frameIntervalNs: 33_350_000,
    }) });
    const { takes } = await listTakes(env());
    expect(takes[0]!.camera).toEqual({
      present: true, device: "FaceTime HD Camera", pipStartsAfterMs: 1390,
    });
  });

  // The gap is measured against the PICTURE, not against session zero. The
  // display track starts late too (0.49 s here), and quoting the camera's
  // absolute PTS would overstate the blank corner by half a second — the
  // handoff called this a "1.9 s pop-in" for exactly that reason.
  test("the gap is measured from the first display frame, not from t=0", async () => {
    makeTake("2026-01-01_00-00-02", { anchors: withCamera({
      present: true, device: "cam", firstFramePtsNs: 1_880_000_000,
    }) });
    const { takes } = await listTakes(env());
    expect(takes[0]!.camera!.pipStartsAfterMs).toBe(1390);   // not 1880
  });

  // THE silent failure, and the reason this is not merely cosmetic: the camera
  // opened, wrote nothing, and the take was indistinguishable from one recorded
  // with no camera at all. Observed for real with the laptop in clamshell.
  test("a camera that recorded nothing is reported, not treated as absent", async () => {
    makeTake("2026-01-01_00-00-03", { anchors: withCamera({ present: false }) });
    const { takes } = await listTakes(env());
    expect(takes[0]!.camera, "a present:false block must not be dropped").toBeDefined();
    expect(takes[0]!.camera!.present).toBe(false);
  });

  test("a camera whose first frame precedes the picture never reports a negative gap", async () => {
    makeTake("2026-01-01_00-00-04", { anchors: withCamera({
      present: true, device: "cam", firstFramePtsNs: 1_000_000,
    }) });
    const { takes } = await listTakes(env());
    expect(takes[0]!.camera!.pipStartsAfterMs).toBe(0);
  });
});
