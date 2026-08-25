import { describe, test, expect } from "vitest";
import {
  availableFrames, clampTrim, defaultProject, estimateExportMs, exportWindow,
  isFullTake, minTrimNs, parseProject, projectForWrite, EXPORT_MS_PER_FRAME,
} from "../src/trim.js";

const FPS = 60;
const NS = 1_000_000_000;
const duration = 5 * NS;

describe("clampTrim", () => {
  test("keeps a valid in/out as-is", () => {
    expect(clampTrim(1 * NS, 3 * NS, duration)).toEqual({ startNs: 1 * NS, endNs: 3 * NS });
  });

  test("will not let the handles cross or sit closer than one output frame", () => {
    const min = minTrimNs(FPS);
    const t = clampTrim(2 * NS, 2 * NS, duration);
    expect(t.endNs - t.startNs).toBe(min);
  });

  test("clamps to the take", () => {
    expect(clampTrim(-1, duration + NS, duration)).toEqual({ startNs: 0, endNs: duration });
  });
});

describe("exportWindow", () => {
  test("no trim is the full take, matching export's available-frame count", () => {
    const project = defaultProject(640, 360);
    const w = exportWindow(project, duration);
    expect(w.fromFrame).toBe(0);
    expect(w.maxFrames).toBe(availableFrames(duration, FPS));
    expect(isFullTake(project, duration)).toBe(true);
  });

  test("a 1-second in/out at t=2s is 60 frames starting at frame 120", () => {
    const project = defaultProject(640, 360, { startNs: 2 * NS, endNs: 3 * NS });
    const w = exportWindow(project, duration);
    expect(w.fromFrame).toBe(120);
    expect(w.maxFrames).toBe(61); // inclusive of the frame at 3.000s
  });

  test("endNs on the last frame includes it", () => {
    const last = 4_983_333_349;
    const project = defaultProject(640, 360);
    const full = exportWindow(project, last);
    const trimmed = exportWindow(
      defaultProject(640, 360, { startNs: 0, endNs: last }), last,
    );
    expect(trimmed.maxFrames).toBe(full.maxFrames);
    expect(trimmed.fromFrame).toBe(0);
  });
});

describe("parseProject", () => {
  test("absent or malformed documents become a default, not an error", () => {
    expect(parseProject(null, 1920, 1080, duration)).toEqual(defaultProject(1920, 1080));
    expect(parseProject("{nope}", 1920, 1080, duration)).toEqual(defaultProject(1920, 1080));
    expect(parseProject({ version: 2 }, 1920, 1080, duration)).toEqual(defaultProject(1920, 1080));
  });

  test("round-trips a valid trim", () => {
    const raw = defaultProject(640, 360, { startNs: NS, endNs: 2 * NS });
    const p = parseProject(raw, 3840, 2160, duration);
    expect(p.trim).toEqual({ startNs: NS, endNs: 2 * NS });
    expect(p.output.width).toBe(640);
  });
});

describe("projectForWrite", () => {
  test("omits trim when the range is the whole take, so a reset is a no-op sidecar", () => {
    const p = defaultProject(640, 360, { startNs: 0, endNs: duration });
    expect(projectForWrite(p, duration).trim).toBeUndefined();
  });

  test("keeps a real trim", () => {
    const p = defaultProject(640, 360, { startNs: NS, endNs: 2 * NS });
    expect(projectForWrite(p, duration).trim).toEqual(p.trim);
  });
});

describe("estimateExportMs", () => {
  test("is the measured 11 ms/frame", () => {
    expect(estimateExportMs(60)).toBe(60 * EXPORT_MS_PER_FRAME);
  });
});
