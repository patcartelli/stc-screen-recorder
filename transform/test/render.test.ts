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
