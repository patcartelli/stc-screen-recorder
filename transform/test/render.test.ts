import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "../src/render.js";
import type { Anchors, Project, Session } from "../src/types.js";

const root = join(__dirname, "..", "..");
const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));

function fixtureSession(): Session {
  return {
    anchors: load("fixtures/basic/anchors.json"),
    events: load("fixtures/basic/events.json").events,
    frames: load("fixtures/basic/frames.json"),
  };
}
const fixtureProject = (): Project => load("fixtures/basic/project.json");

function pipSession(): { project: Project; session: Session } {
  return {
    project: load("fixtures/pip/project.json"),
    session: {
      anchors: load("fixtures/pip/anchors.json"),
      events: load("fixtures/pip/events.json").events,
      frames: load("fixtures/pip/frames.json"),
      cameraFrames: load("fixtures/pip/camera-frames.json"),
    },
  };
}
// Pairs the PiP-enabled project with the v1 basic session (no camera at all)
// so the "no PiP for a v1 session with no camera" test actually reaches
// pipStateAt's `!cam?.present` guard, instead of returning at the earlier
// `!pip?.enabled` guard because fixtures/basic/project.json has no `pip`.
// cameraFrames is deliberately given a non-empty array too — otherwise the
// later `!frames?.length` guard would return null first (frames undefined,
// since the basic fixture never sets cameraFrames), and the test would still
// pass vacuously if `!cam?.present` were deleted.
function basicSessionWithPipProject(): { project: Project; session: Session } {
  return {
    project: load("fixtures/pip/project.json") as Project,
    session: { ...fixtureSession(), cameraFrames: [2_000_000_000] },
  };
}

describe("render(project, session, t) → FrameState", () => {
  test("selects the source frame by greatest PTS <= t and reports its PTS", () => {
    const session = fixtureSession();
    const fs = render(fixtureProject(), session, 17_000_000);
    expect(fs.frameIndex).toBe(1);
    expect(fs.framePtsNs).toBe(session.frames[1]);
  });

  test("holds one frame across an entire VFR stall", () => {
    const session = fixtureSession();
    // fixture stall: find largest gap
    let gi = 0;
    for (let i = 1; i < session.frames.length; i++) {
      if (session.frames[i]! - session.frames[i - 1]! >
          session.frames[gi + 1]! - session.frames[gi]!) gi = i - 1;
    }
    const [a, b] = [session.frames[gi]!, session.frames[gi + 1]!];
    const indices = [a, a + 1, Math.floor((a + b) / 2), b - 1]
      .map((t) => render(fixtureProject(), session, t).frameIndex);
    expect(new Set(indices).size).toBe(1);
    expect(indices[0]).toBe(gi);
  });

  test("cursor position is mapped into output pixel space via display origin and size", () => {
    const anchors: Anchors = {
      version: 1,
      timebase: { numer: 125, denom: 3 },
      t0Ns: "0",
      display: { id: 1, pointWidth: 640, pointHeight: 360, pixelWidth: 1280, pixelHeight: 720,
                 backingScale: 2, originX: 100, originY: 50 },
      capture: { width: 1280, height: 720, codec: "h264" },
      files: { display: "display.mp4" },
    };
    const session: Session = {
      anchors,
      events: [{ t: 0, kind: "move", x: 420, y: 230 }], // display-local points: (320, 180) = centre
      frames: [0],
    };
    const project: Project = {
      version: 1,
      output: { fps: 60, width: 1280, height: 720 },
      cursor: { style: "default", scale: 1 },
    };
    const fs = render(project, session, 2_000_000_000); // long settled
    expect(fs.cursor.visible).toBe(true);
    expect(fs.cursor.x).toBeCloseTo(640, 3); // centre of 1280
    expect(fs.cursor.y).toBeCloseTo(360, 3); // centre of 720
    expect(fs.cursor.scale).toBe(1);
  });

  test("before the first source frame, frame fields are null but cursor still renders", () => {
    const session = fixtureSession();
    session.frames = session.frames.map((t) => t + 200_000_000);
    const fs = render(fixtureProject(), session, 100_000_000);
    expect(fs.frameIndex).toBeNull();
    expect(fs.framePtsNs).toBeNull();
    expect(fs.cursor.visible).toBe(true);
  });

  test("pressed state reaches the FrameState during the fixture click", () => {
    const session = fixtureSession();
    expect(render(fixtureProject(), session, 2_100_000_000).cursor.pressed).toBe(true);
    expect(render(fixtureProject(), session, 1_900_000_000).cursor.pressed).toBe(false);
    expect(render(fixtureProject(), session, 2_300_000_000).cursor.pressed).toBe(false);
  });

  test("does not mutate its inputs", () => {
    const session = fixtureSession();
    const project = fixtureProject();
    const before = JSON.stringify({ project, session });
    for (const t of [0, 1_000_000_000, 4_999_999_999]) render(project, session, t);
    expect(JSON.stringify({ project, session })).toBe(before);
  });
});

describe("determinism — the increment-0 gate at unit level", () => {
  // 200 sample times spread over the fixture, then a deterministic shuffle
  const samples: number[] = [];
  for (let i = 0; i < 200; i++) samples.push(Math.floor((i * 4_999_999_999) / 199));
  const shuffled = [...samples];
  let seed = 0xdecafbad;
  for (let i = shuffled.length - 1; i > 0; i--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }

  test("200 sampled t: ascending order and shuffled order give bit-identical FrameStates", () => {
    const a = fixtureSession();
    const b = fixtureSession();
    const project = fixtureProject();
    const byT = new Map<number, string>();
    for (const t of samples) byT.set(t, JSON.stringify(render(project, a, t)));
    for (const t of shuffled) {
      expect(JSON.stringify(render(project, b, t)), `t=${t}`).toBe(byT.get(t));
    }
  });

  test("re-rendering the same t on the same session is bit-identical", () => {
    const session = fixtureSession();
    const project = fixtureProject();
    const first = JSON.stringify(render(project, session, 3_141_592_653));
    expect(JSON.stringify(render(project, session, 3_141_592_653))).toBe(first);
  });
});

describe("PiP placement and track bounds", () => {
  const CAM_FIRST = 1_035_500_000;
  const CAM_LAST = 3_024_500_000;
  const CAM_INTERVAL = 17_000_000;

  test("no PiP before the camera's first frame", () => {
    const { project, session } = pipSession();
    expect(render(project, session, CAM_FIRST - 1).pip).toBeNull();
  });

  test("PiP appears at the camera's first frame", () => {
    const { project, session } = pipSession();
    const pip = render(project, session, CAM_FIRST).pip;
    expect(pip).not.toBeNull();
    expect(pip!.framePtsNs).toBe(CAM_FIRST);
  });

  test("PiP sits in the bottom-right corner at the configured size", () => {
    const { project, session } = pipSession();   // 3840x2160, widthPct 0.125, margin 32
    const pip = render(project, session, CAM_FIRST).pip!;
    expect(pip.width).toBe(480);                 // 3840 * 0.125
    expect(pip.height).toBe(270);                // 480 * 720/1280
    expect(pip.x).toBe(3840 - 480 - 32);
    expect(pip.y).toBe(2160 - 270 - 32);
  });

  test("the PiP holds the last frame at or before t, never interpolating", () => {
    const { project, session } = pipSession();
    const justBeforeSecond = CAM_FIRST + CAM_INTERVAL - 1;
    expect(render(project, session, justBeforeSecond).pip!.framePtsNs).toBe(CAM_FIRST);
  });

  test("the PiP disappears after the track ends rather than freezing", () => {
    // A camera unplugged mid-take must not leave a frozen face on screen for
    // the rest of the recording. Track end is lastFramePtsNs + frameIntervalNs.
    const { project, session } = pipSession();
    expect(render(project, session, CAM_LAST).pip).not.toBeNull();
    expect(render(project, session, CAM_LAST + CAM_INTERVAL).pip).not.toBeNull();
    expect(render(project, session, CAM_LAST + CAM_INTERVAL + 1).pip).toBeNull();
  });

  test("no PiP when the project disables it", () => {
    const { project, session } = pipSession();
    const off = { ...project, pip: { ...project.pip!, enabled: false } };
    expect(render(off, session, CAM_FIRST).pip).toBeNull();
  });

  test("no PiP for a v1 session that has no camera at all", () => {
    // Deliberately NOT { project: fixtureProject(), session: fixtureSession() }: fixtures/basic/project.json has no
    // `pip` block, so that pairing returns at the `!pip?.enabled` guard and
    // never exercises the camera-absence check — removing `!cam?.present`
    // from render.ts would leave this passing. Pairing the pip-enabled
    // project with the camera-less basic session forces the test through to
    // that guard instead.
    const { project, session } = basicSessionWithPipProject();
    expect(render(project, session, 2_000_000_000).pip).toBeNull();
  });

  test("PiP placement is identical whether reached by stepping or seeking", () => {
    // The determinism property the two sinks depend on. render() memoises the
    // cursor sim per Session, so the comparison must be against a SEPARATELY
    // loaded session with a cold cache — comparing two renders of the same
    // warmed session would pass no matter what the cache did.
    const t = CAM_FIRST + 40 * CAM_INTERVAL;

    const cold = pipSession();
    const seeked = render(cold.project, cold.session, t).pip;

    const warm = pipSession();
    for (let u = 0; u < t; u += 8_333_333) render(warm.project, warm.session, u);
    const stepped = render(warm.project, warm.session, t).pip;

    expect(stepped).toEqual(seeked);
    // Concrete values, not just "not null" — `undefined` also satisfies
    // `not.toBeNull()` and `toEqual`, which is exactly how this test passed
    // vacuously before pipStateAt existed (FrameState.pip was undefined).
    // Accessing .width/.height on a missing pip throws instead of silently
    // passing, so both `undefined` and `null` fail this test.
    expect(seeked!.width).toBe(480);   // 3840 * 0.125
    expect(seeked!.height).toBe(270);  // 480 * 720/1280
  });
});
