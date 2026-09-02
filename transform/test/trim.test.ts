import { describe, test, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withoutComments } from "./_source-text.js";
import {
  availableFrames, clampTrim, defaultProject, estimateExportMs, exportWindow,
  isFullTake, minTrimNs, parseProject, projectForWrite, EXPORT_MS_PER_FRAME,
} from "../src/trim.js";

const root = join(__dirname, "..", "..");
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

  test("carries cursor.style: circle, and coerces anything else to the default pointer", () => {
    const raw = (style: unknown) => ({
      version: 2, output: { fps: 60, width: 640, height: 360 }, cursor: { style, scale: 2 },
    });
    expect(parseProject(raw("circle"), 640, 360, duration).cursor).toEqual({ style: "circle", scale: 2 });
    expect(parseProject(raw("default"), 640, 360, duration).cursor.style).toBe("default");
    expect(parseProject(raw("dot"), 640, 360, duration).cursor.style).toBe("default");
    expect(parseProject(raw(undefined), 640, 360, duration).cursor.style).toBe("default");
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

  // A camera take recorded by the app has NO project.json — nothing writes one
  // at record time — so without a default it previews with pip: null and an
  // invisible PiP, despite a perfectly good camera.mp4 next to it. That is what
  // made the first real hardware take need a hand-written project.
  test("a take with a camera gets a PiP even with no project.json", () => {
    const p = parseProject(null, 3840, 2160, duration, true);
    expect(p.pip).toEqual({ enabled: true, corner: "bottom-right", widthPct: 0.125, marginPx: 32 });
  });

  test("a take with no camera still gets no PiP", () => {
    expect(parseProject(null, 3840, 2160, duration, false).pip).toBeUndefined();
    // Unchanged for every take that already exists.
    expect(parseProject(null, 1920, 1080, duration)).toEqual(defaultProject(1920, 1080));
  });

  // The default is a DEFAULT, not an override. Someone who turned the PiP off
  // must stay off, or disabling it on a camera take would be impossible.
  test("an explicit pip in the document beats the default", () => {
    const raw = {
      version: 2, output: { fps: 60, width: 640, height: 360 },
      cursor: { style: "default", scale: 1 },
      pip: { enabled: false, corner: "bottom-right", widthPct: 0.125, marginPx: 32 },
    };
    expect(parseProject(raw, 640, 360, duration, true).pip!.enabled).toBe(false);
  });
});

/**
 * CLAUDE.md's standing rule, made enforceable: "callers pass the take's
 * project.json THROUGH parseProject (or null). Assembling a project outside the
 * one parser is how two answers happen. If you add a fourth caller, pass the
 * raw document."
 *
 * A fourth caller was added anyway. harness/sink-identity.ts fetched the take's
 * project and used it VERBATIM, falling back to a literal it assembled itself —
 * a literal with no `pip`, because a hand-rolled object cannot know that
 * parseProject turns the PiP on for a camera take. Every camera take without a
 * project.json therefore rendered with no PiP, and `npm run gate:identity`
 * failed on a real 5.6 MB camera track while CI stayed green, because CI ran
 * that gate on a camera-LESS fixture.
 *
 * Four times is enough. This is the fifth caller's tripwire.
 */
describe("one parser decides a project (STC-232)", () => {
  const SCOPE = ["harness", join("app", "src")];

  const sources = () => SCOPE.flatMap((dir) =>
    readdirSync(join(root, dir), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts"))
      .map((e) => ({
        path: join(dir, e.name),
        // Comments stripped: a guard that greps raw source is asserting
        // something about the documentation. The first draft of the
        // parseProject check below passed against a file with the call REMOVED,
        // because the comment explaining the rule still said the word.
        src: withoutComments(readFileSync(join(root, dir, e.name), "utf8")),
      })));

  test("every file that produces a Project routes it through parseProject", () => {
    const offenders = sources()
      .filter((f) => /:\s*Project\b/.test(f.src) && !f.src.includes("parseProject"))
      .map((f) => f.path);
    expect(offenders,
      "a Project built outside parseProject misses the defaults it applies — " +
      `above all pip.enabled for a camera take:\n${offenders.join("\n")}`).toEqual([]);
  });

  test("no file assembles a project literal of its own", () => {
    // `cursor: { style:` is the tell: only a hand-assembled Project has it.
    const offenders = sources()
      .filter((f) => /cursor:\s*\{\s*style:/.test(f.src))
      .map((f) => f.path);
    expect(offenders,
      `these assemble a project instead of parsing one:\n${offenders.join("\n")}`).toEqual([]);
  });
});
