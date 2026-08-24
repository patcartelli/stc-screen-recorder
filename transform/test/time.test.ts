import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tickOf, tickTimeNs, frameIndexAt } from "../src/time.js";

const fixtureFrames: number[] = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "fixtures", "basic", "frames.json"), "utf8"),
);

describe("tickOf — 120 Hz sim tick from session-relative ns", () => {
  test("t=0 is tick 0", () => {
    expect(tickOf(0)).toBe(0);
  });

  test("last ns of tick 0 / first ns of tick 1 (boundary is exact integer math)", () => {
    // tick 1 begins at the first t where t*120 >= 1e9, i.e. t = ceil(1e9/120) = 8_333_334
    expect(tickOf(8_333_333)).toBe(0);
    expect(tickOf(8_333_334)).toBe(1);
  });

  test("one second is exactly 120 ticks", () => {
    expect(tickOf(1_000_000_000)).toBe(120);
    expect(tickOf(999_999_999)).toBe(119);
  });

  test("30-minute session stays in exact integer range", () => {
    const t = 1_800_000_000_000; // 30 min in ns
    expect(tickOf(t)).toBe(216_000);
    expect(Number.isSafeInteger(t * 120)).toBe(true);
  });

  test("tickTimeNs is the inverse floor: tickOf(tickTimeNs(n)) === n", () => {
    for (const n of [0, 1, 2, 119, 120, 599, 216_000]) {
      expect(tickOf(tickTimeNs(n))).toBe(n);
      if (n > 0) expect(tickOf(tickTimeNs(n) - 1)).toBe(n - 1);
    }
  });
});

describe("frameIndexAt — greatest source PTS <= t, hold, never interpolate", () => {
  const frames = [0, 16_666_667, 33_333_333, 100_000_000];

  test("exact PTS hit returns that frame", () => {
    expect(frameIndexAt(frames, 16_666_667)).toBe(1);
  });

  test("between frames holds the earlier frame", () => {
    expect(frameIndexAt(frames, 16_666_666)).toBe(0);
    expect(frameIndexAt(frames, 33_333_334)).toBe(2);
  });

  test("inside a long VFR gap keeps holding — never jumps ahead", () => {
    expect(frameIndexAt(frames, 99_999_999)).toBe(2);
    expect(frameIndexAt(frames, 100_000_000)).toBe(3);
  });

  test("before the first frame there is no frame", () => {
    expect(frameIndexAt([10, 20], 9)).toBeNull();
  });

  test("after the last frame holds the last frame forever", () => {
    expect(frameIndexAt(frames, 9_999_999_999)).toBe(3);
  });

  test("empty frame list yields null", () => {
    expect(frameIndexAt([], 0)).toBeNull();
  });

  test("fixture: every t inside the second 50 ms stall holds the same frame", () => {
    // find the largest inter-frame gap in the fixture's first second
    let gi = 0;
    for (let i = 1; i < fixtureFrames.length && fixtureFrames[i]! < 1_000_000_000; i++) {
      if (fixtureFrames[i]! - fixtureFrames[i - 1]! >
          fixtureFrames[gi + 1]! - fixtureFrames[gi]!) gi = i - 1;
    }
    const [a, b] = [fixtureFrames[gi]!, fixtureFrames[gi + 1]!];
    expect(b - a).toBeGreaterThanOrEqual(50_000_000);
    for (const t of [a, a + 1, Math.floor((a + b) / 2), b - 1]) {
      expect(frameIndexAt(fixtureFrames, t)).toBe(gi);
    }
    expect(frameIndexAt(fixtureFrames, b)).toBe(gi + 1);
  });
});
