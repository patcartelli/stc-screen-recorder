import { describe, test, expect } from "vitest";
import {
  DEFAULT_EXPORT_OPTIONS, DEFAULT_FILENAME_TEMPLATE, DEFAULT_FLATTEN_COLOR, FALLBACK_STEM,
  FILENAME_TOKENS, FORMATS, MAX_STEM_LENGTH, STILL_FORMATS, clampQuality, colorSpaceFor,
  dateToken, flattenPlan, metadataPlan, parseFormat, parseScale, planFileName, planRender,
  renderTemplate, scaleFactor, scaleStillLayout, stillIsBlocked, timeToken, tokensFor,
  uniqueFileName, type ExportOptions,
} from "../src/still-export.js";
import { decorationForMode, layoutStill, pxPerPointOf } from "../src/still-decorate.js";
import { parseShot, type Shot } from "../src/shot.js";

/**
 * STC-293: every decision a still makes on its way out of the app.
 *
 * The two halves that cannot be checked here are named rather than skipped:
 * ImageIO actually writing a HEIC and NSPasteboard actually taking the item
 * are `helper/test/still-export.grant.test.ts` and STC-293's runbook. What IS
 * here is the whole of the acceptance list that is arithmetic — collision-free
 * filenames from a template using every token, and a transparent-mode shot
 * refusing to become a JPEG until somebody has said what should happen.
 */

const shotDoc = (over: Record<string, unknown> = {}): unknown => ({
  version: 1,
  kind: "window",
  capturedAtNs: "1000",
  timebase: { numer: 125, denom: 3 },
  display: {
    id: 1, pointWidth: 1512, pointHeight: 982, pixelWidth: 3024, pixelHeight: 1964,
    backingScale: 2, originX: 0, originY: 0, colorSpace: "kCGColorSpaceDisplayP3",
  },
  window: { id: 7, app: "Safari", title: "stc", bounds: { x: 10, y: 20, width: 400, height: 300 } },
  frame: { file: "frame.png", width: 800, height: 600, alpha: true },
  decoration: { mode: "window-only", canvas: "natural", cursor: false, redactions: [] },
  ...over,
});

const shot = (over: Record<string, unknown> = {}): Shot => parseShot(shotDoc(over));

describe("formats (STC-293)", () => {
  test("every format is complete and its extension is not its UTI", () => {
    for (const f of STILL_FORMATS) {
      const info = FORMATS[f];
      expect(info.ext, f).toMatch(/^[a-z]+$/);
      expect(info.uti, f).toMatch(/^public\./);
      expect(info.uti, `${f}: the UTI is not the extension`).not.toBe(info.ext);
    }
    // The one property the rest of this file leans on.
    expect(FORMATS.jpeg.alpha).toBe(false);
    expect(FORMATS.png.alpha).toBe(true);
    expect(FORMATS.heic.alpha).toBe(true);
  });

  test("an unknown format is the default, never a guess", () => {
    expect(parseFormat("webp")).toBe("png");
    expect(parseFormat(undefined)).toBe("png");
    expect(parseFormat("heic")).toBe("heic");
  });

  test("quality is clamped rather than trusted", () => {
    expect(clampQuality(2)).toBe(1);
    expect(clampQuality(-1)).toBe(0);
    expect(clampQuality(NaN)).toBe(0.9);
    expect(clampQuality("high")).toBe(0.9);
    expect(clampQuality(0.4)).toBe(0.4);
  });
});

describe("output scale (STC-293)", () => {
  test("native never moves; 1x divides by the capture's own scale", () => {
    expect(scaleFactor("native", 2)).toBe(1);
    expect(scaleFactor("1x", 2)).toBe(0.5);
    expect(scaleFactor("1x", 3)).toBeCloseTo(1 / 3);
  });

  test("1x on a capture that is already 1x is a no-op, not a doubling", () => {
    // The bug this pins: a factor computed as `2 / pxPerPoint` gives 2 here,
    // which would upscale a non-Retina capture to invent detail nobody
    // photographed.
    expect(scaleFactor("1x", 1)).toBe(1);
  });

  test("a nonsense scale is never allowed to enlarge", () => {
    expect(scaleFactor("1x", 0)).toBe(1);
    expect(scaleFactor("1x", -2)).toBe(1);
    expect(scaleFactor("1x", NaN)).toBe(1);
    expect(parseScale("huge")).toBe("native");
  });

  test("scaling the layout scales the geometry and leaves opacity alone", () => {
    // Through `decorationForMode`, not a hand-written decoration block: the
    // preset shadow is filled in there, so a raw `{mode: "window-shadow"}`
    // document has no shadow at all and the layout correctly omits one.
    const l = layoutStill(shot({ decoration: decorationForMode("window-shadow") }));
    expect(l.shadow, "the fixture must actually carry a shadow").toBeDefined();
    const half = scaleStillLayout(l, 0.5);
    expect(half.canvas.width).toBe(Math.round(l.canvas.width / 2));
    expect(half.canvas.height).toBe(Math.round(l.canvas.height / 2));
    expect(half.content.width).toBe(l.content.width / 2);
    expect(half.shadow!.blur).toBe(l.shadow!.blur / 2);
    // An opacity is not a length. Scaling it would fade the shadow on a 1x
    // export, which is the kind of "nearly right" that only shows up by eye.
    expect(half.shadow!.opacity).toBe(l.shadow!.opacity);
    expect(half.alpha).toBe(l.alpha);
  });

  test("a factor of 1 returns the very same layout, not a copy", () => {
    const l = layoutStill(shot());
    expect(scaleStillLayout(l, 1)).toBe(l);
  });

  test("the cursor's own scale moves with the layout", () => {
    const withCursor = shot({
      cursor: { x: 100, y: 120, shape: "arrow" },
      decoration: { mode: "window-only", canvas: "natural", cursor: true, redactions: [] },
    });
    const l = layoutStill(withCursor);
    expect(l.cursor, "the fixture must put the pointer inside the capture").toBeDefined();
    const half = scaleStillLayout(l, 0.5);
    // Otherwise the pointer is drawn at twice its proper size on a 1x export.
    expect(half.cursor!.pxPerPoint).toBe(l.cursor!.pxPerPoint / 2);
    expect(half.cursor!.x).toBe(l.cursor!.x / 2);
  });
});

describe("alpha meeting a format that has none (STC-293)", () => {
  test("PNG and HEIC keep transparency, so there is nothing to say", () => {
    expect(flattenPlan(true, "png")).toEqual({ kind: "none" });
    expect(flattenPlan(true, "heic")).toEqual({ kind: "none" });
  });

  test("an opaque shot as JPEG is not a conflict", () => {
    expect(flattenPlan(false, "jpeg")).toEqual({ kind: "none" });
  });

  test("a transparent shot as JPEG is a conflict the caller must resolve", () => {
    const plan = flattenPlan(true, "jpeg");
    expect(plan.kind).toBe("conflict");
    if (plan.kind !== "conflict") throw new Error("unreachable");
    // "must say what will happen ... never silently fill black": the message
    // has to name both ways out, and the offered default must not be black.
    expect(plan.message).toMatch(/transparen/i);
    expect(plan.suggestFormat).toBe("png");
    expect(plan.defaultColor).toBe(DEFAULT_FLATTEN_COLOR);
    expect(plan.defaultColor).not.toMatch(/^#000/);
  });

  test("a chosen colour resolves it", () => {
    expect(flattenPlan(true, "jpeg", "#ff0000")).toEqual({ kind: "flatten", color: "#ff0000" });
  });
});

describe("the render plan (STC-293)", () => {
  const opts = (over: Partial<ExportOptions> = {}): ExportOptions =>
    ({ ...DEFAULT_EXPORT_OPTIONS, ...over });

  test("a window-only shot as PNG keeps its alpha", () => {
    const s = shot();
    const plan = planRender(opts(), { layout: layoutStill(s), pxPerPoint: pxPerPointOf(s) });
    expect(plan.alpha).toBe(true);
    expect(stillIsBlocked(plan)).toBe(false);
  });

  test("the same shot as JPEG is blocked until the question is answered", () => {
    const s = shot();
    const inputs = { layout: layoutStill(s), pxPerPoint: pxPerPointOf(s) };
    const blocked = planRender(opts({ format: "jpeg" }), inputs);
    expect(stillIsBlocked(blocked)).toBe(true);
    // Blocked or not, it must never claim an alpha a JPEG cannot carry.
    expect(blocked.alpha).toBe(false);

    const answered = planRender(opts({ format: "jpeg", flattenColor: "#ffffff" }), inputs);
    expect(stillIsBlocked(answered)).toBe(false);
    expect(answered.alpha).toBe(false);
  });

  test("a display crop is opaque, so JPEG never blocks it", () => {
    const s = shot({
      kind: "display-crop",
      window: undefined,
      crop: { x: 0, y: 0, width: 400, height: 300 },
      frame: { file: "frame.png", width: 800, height: 600, alpha: false },
      decoration: { mode: "selected-area", canvas: "natural", cursor: false, redactions: [] },
    });
    const plan = planRender(opts({ format: "jpeg" }),
                            { layout: layoutStill(s), pxPerPoint: pxPerPointOf(s) });
    expect(stillIsBlocked(plan)).toBe(false);
    expect(plan.alpha).toBe(false);
  });

  test("a background ends the transparency, so JPEG does not block either", () => {
    const s = shot({
      decoration: decorationForMode("window-shadow-background"),
    });
    const layout = layoutStill(s);
    expect(layout.alpha, "a background fills every pixel").toBe(false);
    const plan = planRender(opts({ format: "jpeg" }), { layout, pxPerPoint: pxPerPointOf(s) });
    expect(stillIsBlocked(plan)).toBe(false);
  });

  test("1x halves a 2x capture's output", () => {
    const s = shot();
    // 800 px of frame over 400 points of window: a 2x capture.
    expect(pxPerPointOf(s)).toBe(2);
    const inputs = { layout: layoutStill(s), pxPerPoint: pxPerPointOf(s) };
    const native = planRender(opts(), inputs);
    const one = planRender(opts({ scale: "1x" }), inputs);
    expect(one.factor).toBe(0.5);
    expect(one.layout.canvas.width).toBe(Math.round(native.layout.canvas.width / 2));
  });
});

describe("the filename template (STC-293)", () => {
  const at = new Date(2026, 8, 8, 14, 23, 5);

  test("date and time tokens are filename-safe and local", () => {
    expect(dateToken(at)).toBe("2026-09-08");
    // Colons would be a path separator on the classic filesystem and are shown
    // as "/" by Finder; dots would read as a second extension.
    expect(timeToken(at)).toBe("14-23-05");
  });

  test("the default template renders", () => {
    const stem = renderTemplate(DEFAULT_FILENAME_TEMPLATE,
                                tokensFor({ app: "Safari", width: 1, height: 1, mode: "window-only" }, at));
    expect(stem).toBe("Safari 2026-09-08 at 14-23-05");
  });

  test("a template containing EVERY token produces a valid, collision-free name", () => {
    // The acceptance list, literally.
    const template = FILENAME_TOKENS.map((t) => `{${t}}`).join(" ");
    const tokens = tokensFor({
      app: "Safari", title: "stc recorder", width: 800, height: 600,
      mode: "window-shadow", counter: 4,
    }, at);
    const name = planFileName({ ...DEFAULT_EXPORT_OPTIONS, template },
                              { tokens, taken: new Set() });
    expect(name.endsWith(".png")).toBe(true);
    expect(name).not.toMatch(/[/:\\]/);
    expect(name).not.toMatch(/^\./);
    // Every token resolved: an unreplaced `{...}` would mean one was declared
    // in the list and not handled.
    expect(name).not.toMatch(/[{}]/);
  });

  test("a region shot has no app, and gets a word rather than a hole", () => {
    const stem = renderTemplate("{app} {date}", tokensFor({ width: 1, height: 1, mode: "selected-area" }, at));
    expect(stem).toBe("Screen 2026-09-08");
    expect(stem.startsWith(" ")).toBe(false);
  });

  test("an unknown token is left visible rather than silently dropped", () => {
    // So a typo in a hand-edited setting shows up in the filename, instead of
    // vanishing and leaving the user guessing which tokens the app knows.
    expect(renderTemplate("{sequence}-{date}", tokensFor({ width: 1, height: 1, mode: "m" }, at)))
      .toBe("{sequence}-2026-09-08");
  });

  test("path separators in a window title cannot escape the folder", () => {
    const stem = renderTemplate("{title}", tokensFor({
      title: "../../etc/passwd", width: 1, height: 1, mode: "m",
    }, at));
    // The property that matters is that no SEPARATOR survives: ".." can only
    // walk up a path when something splits the string on "/", and there is no
    // "/" left to split on. The dots themselves are just characters in a name.
    expect(stem).not.toMatch(/[/:\\]/);
    expect(stem).toContain("etc");
  });

  test("a title that is nothing but dots cannot become \"..\"", () => {
    // The one case where the dots WOULD matter — a stem of exactly ".." names
    // the parent directory. The leading-dot strip empties it and the fallback
    // takes over, so it never reaches a `join`.
    expect(renderTemplate("{title}", tokensFor({ title: "..", width: 1, height: 1, mode: "m" }, at)))
      .toBe(FALLBACK_STEM);
    expect(renderTemplate("{title}", tokensFor({ title: ".", width: 1, height: 1, mode: "m" }, at)))
      .toBe(FALLBACK_STEM);
  });

  test("a leading dot is stripped, so a save is never invisible", () => {
    expect(renderTemplate("{title}", tokensFor({ title: ".hidden", width: 1, height: 1, mode: "m" }, at)))
      .toBe("hidden");
  });

  test("a template that renders to nothing falls back rather than producing \".png\"", () => {
    expect(renderTemplate("{title}", tokensFor({ width: 1, height: 1, mode: "m" }, at))).toBe(FALLBACK_STEM);
    expect(renderTemplate("   ", {})).toBe(FALLBACK_STEM);
  });

  test("an absurd title is truncated rather than rejected by the filesystem", () => {
    const stem = renderTemplate("{title}", tokensFor({
      title: "x".repeat(500), width: 1, height: 1, mode: "m",
    }, at));
    expect(stem.length).toBeLessThanOrEqual(MAX_STEM_LENGTH);
  });

  test("collisions get a suffix, and keep getting one", () => {
    expect(uniqueFileName("Shot", "png", new Set())).toBe("Shot.png");
    expect(uniqueFileName("Shot", "png", new Set(["Shot.png"]))).toBe("Shot-2.png");
    expect(uniqueFileName("Shot", "png", new Set(["Shot.png", "Shot-2.png"]))).toBe("Shot-3.png");
    // A name taken in a different format is a different name.
    expect(uniqueFileName("Shot", "jpg", new Set(["Shot.png"]))).toBe("Shot.jpg");
  });

  test("the format decides the extension", () => {
    const tokens = tokensFor({ app: "Safari", width: 1, height: 1, mode: "m" }, at);
    for (const f of STILL_FORMATS) {
      const name = planFileName({ ...DEFAULT_EXPORT_OPTIONS, format: f }, { tokens, taken: new Set() });
      expect(name.endsWith(`.${FORMATS[f].ext}`), `${f} -> ${name}`).toBe(true);
    }
  });

  test("a counter in the template does not make the collision check optional", () => {
    // The counter comes from a directory listing and is correct only until two
    // exports race or a file is deleted in the middle. Uniqueness has to hold
    // for the name actually written.
    const tokens = tokensFor({ app: "Safari", width: 1, height: 1, mode: "m", counter: 2 }, at);
    const opts = { ...DEFAULT_EXPORT_OPTIONS, template: "{app}-{counter}" };
    expect(planFileName(opts, { tokens, taken: new Set(["Safari-2.png"]) })).toBe("Safari-2-2.png");
  });
});

describe("colour and metadata (STC-293)", () => {
  test("a P3 display is recognised however CoreGraphics spelled it", () => {
    expect(colorSpaceFor("kCGColorSpaceDisplayP3")).toBe("display-p3");
    expect(colorSpaceFor("Display P3")).toBe("display-p3");
  });

  test("anything unrecognised is sRGB, which is the safe wrong answer", () => {
    // An sRGB image tagged P3 is washed out on EVERY viewer; a P3 image shown
    // as sRGB is oversaturated only on wide-gamut ones.
    expect(colorSpaceFor("kCGColorSpaceSRGB")).toBe("srgb");
    expect(colorSpaceFor(undefined)).toBe("srgb");
    expect(colorSpaceFor("")).toBe("srgb");
  });

  test("stripping metadata drops the timestamp and KEEPS the colour profile", () => {
    const at = new Date("2026-09-08T14:23:05Z");
    const kept = metadataPlan("display-p3", at, false);
    expect(kept.capturedAt).toBe(at.toISOString());
    expect(kept.colorSpace).toBe("display-p3");

    const stripped = metadataPlan("display-p3", at, true);
    expect(stripped.capturedAt).toBeUndefined();
    // The profile is not metadata — it is what makes the numbers mean colours,
    // and dropping it is the visible P3 shift the acceptance list forbids.
    expect(stripped.colorSpace).toBe("display-p3");
  });
});
