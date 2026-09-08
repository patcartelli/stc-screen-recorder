import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLIPBOARD_SUBDIR, destinationDir, exportStill, namesIn, resolveExportOptions,
} from "../src/still-io.js";
import { DEFAULT_STILL_SETTINGS, type StillSettings } from "../src/settings.js";

/**
 * STC-293: the one funnel every still takes out of the app.
 *
 * The helper is a stand-in here — a function that records what it was asked
 * and reports what a real one would — because the thing under test is the
 * ORCHESTRATION: where the file goes, what it is called, that the pixels
 * actually reach the encoder, and that the 33 MB scratch copy does not outlive
 * the call. ImageIO and NSPasteboard are the Mac's to prove
 * (`docs/STC-293-RUNBOOK.md`); everything above them is proved here.
 *
 * The stand-in is not a shortcut: a fake that could not be true — one that
 * claimed to have written a file it did not — is the seam this codebase has
 * already been bitten by (CLAUDE.md, the supervisor's crash-mid-recording
 * test). So it WRITES the file it says it wrote, and the assertions read the
 * disk rather than the call log wherever they can.
 */

let dir = "";
let cache = "";
const settings = (over: Partial<StillSettings> = {}): StillSettings =>
  ({ ...DEFAULT_STILL_SETTINGS, ...over });

/** A stand-in helper that actually writes what it is told to write. */
function fakeHelper() {
  const calls: Record<string, unknown>[] = [];
  const send = async (params: Record<string, unknown>) => {
    calls.push(params);
    const rgba = await readFile(String(params.rgba));
    const out: Record<string, unknown> = {
      width: params.width, height: params.height, format: params.format,
      alpha: params.alpha, colorSpace: params.colorSpace,
      premultiplied: false,
      metadata: params.capturedAt === undefined ? "stripped" : "kept",
    };
    if (params.file) {
      const path = String(params.file);
      await mkdir(join(path, ".."), { recursive: true });
      // Stands in for the encode: the same bytes, so a test can prove the
      // pixels reached the encoder rather than trusting the call log.
      await writeFile(path, rgba);
      out.file = path;
      out.bytes = rgba.length;
    }
    if (params.clipboard) out.clipboard = ["png", "tiff", "fileURL"];
    return out;
  };
  return { send, calls };
}

/** 2x2 of RGBA, distinguishable so a wrong buffer is visible. */
const pixels = () => {
  const a = new Uint8Array(2 * 2 * 4);
  for (let i = 0; i < a.length; i++) a[i] = i * 7;
  return a;
};
const still = (over: Record<string, unknown> = {}) => ({
  bytes: pixels().buffer as ArrayBuffer,
  width: 2, height: 2, alpha: true, colorSpace: "srgb" as const,
  ...over,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "stc-still-io-"));
  cache = await mkdtemp(join(tmpdir(), "stc-still-cache-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(cache, { recursive: true, force: true });
});

describe("where a still goes (STC-293)", () => {
  const both = { file: true, clipboard: true };
  const copyOnly = { file: false, clipboard: true };

  test("a save with no chosen destination lands beside the shot", () => {
    expect(destinationDir(settings(), { file: true, clipboard: false }, "/takes/shot-1", cache))
      .toBe("/takes/shot-1");
  });

  test("a chosen destination wins over the shot's own directory", () => {
    expect(destinationDir(settings({ destination: "/Users/me/Shots" }),
                          { file: true, clipboard: false }, "/takes/shot-1", cache))
      .toBe("/Users/me/Shots");
  });

  test("a COPY never writes into the user's folders", () => {
    // It writes a file only so the pasteboard's URL points at something real.
    // Landing that in the shots folder would leave the user a file to tidy up
    // after every paste, which is not what they asked for.
    expect(destinationDir(settings({ destination: "/Users/me/Shots" }), copyOnly, "/takes/shot-1", cache))
      .toBe(join(cache, CLIPBOARD_SUBDIR));
  });

  test("a directory that does not exist is empty, not an error", async () => {
    expect(await namesIn(join(dir, "nope"))).toEqual(new Set());
  });
});

describe("the export funnel (STC-293)", () => {
  test("a save writes the composited pixels under a templated name", async () => {
    const h = fakeHelper();
    const r = await exportStill(h.send, {
      still: still(),
      target: { file: true, clipboard: false },
      options: { ...DEFAULT_STILL_SETTINGS, template: "{app} {date}" },
      info: { app: "Safari", mode: "window-only" },
      fallbackDir: dir,
      at: new Date(2026, 8, 8, 14, 23, 5),
    }, settings(), cache);

    expect(r.file).toBe(join(dir, "Safari 2026-09-08.png"));
    // Read back from disk, not from the call log: this proves the bytes made
    // the whole trip, which is the one thing a call-log assertion cannot.
    expect(new Uint8Array(await readFile(r.file!))).toEqual(pixels());
    expect(r.clipboard).toBeUndefined();
  });

  test("a copy still writes a file, so the pasteboard's URL points somewhere", async () => {
    const h = fakeHelper();
    const r = await exportStill(h.send, {
      still: still(),
      target: { file: false, clipboard: true },
      options: DEFAULT_STILL_SETTINGS,
      info: { app: "Safari", mode: "window-only" },
      fallbackDir: dir,
    }, settings(), cache);

    expect(r.clipboard).toEqual(["png", "tiff", "fileURL"]);
    expect(r.file).toBeDefined();
    expect(existsSync(r.file!)).toBe(true);
    // ...and not in the shot's directory.
    expect(r.file!.startsWith(join(cache, CLIPBOARD_SUBDIR))).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a second save of the same name gets a suffix rather than overwriting", async () => {
    const h = fakeHelper();
    const req = {
      still: still(),
      target: { file: true, clipboard: false },
      options: { ...DEFAULT_STILL_SETTINGS, template: "Shot" },
      info: { app: "Safari", mode: "window-only" },
      fallbackDir: dir,
    };
    const first = await exportStill(h.send, req, settings(), cache);
    const second = await exportStill(h.send, req, settings(), cache);
    expect(first.file).toBe(join(dir, "Shot.png"));
    expect(second.file).toBe(join(dir, "Shot-2.png"));
    expect(readdirSync(dir).sort()).toEqual(["Shot-2.png", "Shot.png"]);
  });

  test("the format decides the extension and reaches the encoder", async () => {
    const h = fakeHelper();
    const r = await exportStill(h.send, {
      still: still(),
      target: { file: true, clipboard: false },
      options: { ...DEFAULT_STILL_SETTINGS, format: "heic", quality: 0.5, template: "Shot" },
      info: { mode: "window-only" },
      fallbackDir: dir,
    }, settings(), cache);
    expect(r.file!.endsWith(".heic")).toBe(true);
    expect(h.calls[0]!.format).toBe("heic");
    expect(h.calls[0]!.quality).toBe(0.5);
  });

  test("stripping metadata withholds the timestamp and keeps the profile", async () => {
    const h = fakeHelper();
    await exportStill(h.send, {
      still: still({ colorSpace: "display-p3" }),
      target: { file: true, clipboard: false },
      options: DEFAULT_STILL_SETTINGS,
      info: { mode: "window-only" },
      fallbackDir: dir,
    }, settings({ stripMetadata: true }), cache);

    expect(h.calls[0]!.capturedAt).toBeUndefined();
    // The profile is not covered by the strip — it is what makes the numbers
    // mean colours, and dropping it is the visible P3 shift the acceptance
    // list forbids.
    expect(h.calls[0]!.colorSpace).toBe("display-p3");
  });

  test("keeping metadata sends an ISO timestamp", async () => {
    const h = fakeHelper();
    await exportStill(h.send, {
      still: still(),
      target: { file: true, clipboard: false },
      options: DEFAULT_STILL_SETTINGS,
      info: { mode: "window-only" },
      fallbackDir: dir,
      at: new Date("2026-09-08T14:23:05.000Z"),
    }, settings({ stripMetadata: false }), cache);
    expect(h.calls[0]!.capturedAt).toBe("2026-09-08T14:23:05.000Z");
  });

  test("an export with nowhere to go is refused rather than quietly doing nothing", async () => {
    const h = fakeHelper();
    await expect(exportStill(h.send, {
      still: still(),
      target: { file: false, clipboard: false },
      options: DEFAULT_STILL_SETTINGS,
      info: { mode: "window-only" },
      fallbackDir: dir,
    }, settings(), cache)).rejects.toThrow(/somewhere to go/);
    expect(h.calls).toHaveLength(0);
  });

  test("the scratch RGBA is removed, on the failure path too", async () => {
    // A 4K still is 33 MB. Leaking one per export fills a disk quietly, and
    // the failure path is where a `finally` is usually missing.
    const paths: string[] = [];
    const failing = async (params: Record<string, unknown>) => {
      paths.push(String(params.rgba));
      throw new Error("encode-failed");
    };
    await expect(exportStill(failing, {
      still: still(),
      target: { file: true, clipboard: false },
      options: DEFAULT_STILL_SETTINGS,
      info: { mode: "window-only" },
      fallbackDir: dir,
    }, settings(), cache)).rejects.toThrow(/encode-failed/);
    expect(paths).toHaveLength(1);
    expect(existsSync(paths[0]!)).toBe(false);
  });

  test("the helper is told the truth about alpha", async () => {
    const h = fakeHelper();
    await exportStill(h.send, {
      still: still({ alpha: false }),
      target: { file: true, clipboard: false },
      options: DEFAULT_STILL_SETTINGS,
      info: { mode: "selected-area" },
      fallbackDir: dir,
    }, settings(), cache);
    expect(h.calls[0]!.alpha).toBe(false);
  });
});

/**
 * STC-293: what a caller may decide about one export.
 *
 * This is the seam that broke on the PR's first CI run. The IPC handler
 * resolved options as `{ ...stored, ...requested, template: stored.template }`
 * — pinning the template — so the preview's frame grab, which names its file
 * after the take and the millisecond it came from, saved under the stored
 * still template instead. Three E2E assertions went red saying only "expected
 * [] to have a length of 1", which is a symptom two processes away from the
 * cause. The logic lived in an `ipcMain.handle` closure where no test could
 * reach it; it lives in `still-io.ts` now, and these are the assertions that
 * would have named it.
 */
describe("what a caller may decide about an export (STC-293)", () => {
  const stored: StillSettings = {
    ...DEFAULT_STILL_SETTINGS,
    destination: "/Users/me/Shots",
    template: "{app} {date}",
    stripMetadata: true,
    format: "png",
  };

  test("a caller's template wins over the stored one", () => {
    // The regression: an artifact whose name carries information no
    // user-authored template can express — here, where in a take the frame
    // came from — must be allowed to name itself.
    expect(resolveExportOptions(stored, { template: "frame-take-437ms" }).template)
      .toBe("frame-take-437ms");
  });

  test("no template means the stored one", () => {
    expect(resolveExportOptions(stored, {}).template).toBe("{app} {date}");
    expect(resolveExportOptions(stored, undefined).template).toBe("{app} {date}");
    // An empty or blank template is not a choice, it is a missing one.
    expect(resolveExportOptions(stored, { template: "   " }).template).toBe("{app} {date}");
  });

  test("format, quality and scale are the caller's for this one export", () => {
    const o = resolveExportOptions(stored, { format: "jpeg", quality: 0.5, scale: "1x" });
    expect(o.format).toBe("jpeg");
    expect(o.quality).toBe(0.5);
    expect(o.scale).toBe("1x");
  });

  test("a caller cannot turn off the metadata strip", () => {
    // It is a privacy preference. A caller that could clear it would silently
    // re-attach a timestamp the user asked to have withheld.
    expect(resolveExportOptions(stored, { stripMetadata: false } as never).stripMetadata).toBe(true);
  });

  test("a caller cannot name a destination, even by sending the settings back", () => {
    // The exact shape of the original bug: the renderer is handed the settings
    // to populate its controls and sends them back, so a
    // `{ ...stored, ...requested }` spread let it choose where main writes.
    const o = resolveExportOptions(stored, { destination: "/tmp/anywhere" } as never);
    expect((o as unknown as Record<string, unknown>).destination).toBeUndefined();
    // ...and the real destination still comes from the stored settings.
    expect(destinationDir(stored, { file: true, clipboard: false }, "/takes/shot-1", "/cache"))
      .toBe("/Users/me/Shots");
  });

  test("a nonsense format or scale falls back rather than reaching the encoder", () => {
    const o = resolveExportOptions(stored, { format: "webp" as never, scale: "4x" as never });
    expect(o.format).toBe("png");
    expect(o.scale).toBe("native");
  });

  test("a flatten colour is carried through only when one was chosen", () => {
    expect(resolveExportOptions(stored, {}).flattenColor).toBeUndefined();
    expect(resolveExportOptions(stored, { flattenColor: "#ff0000" }).flattenColor).toBe("#ff0000");
  });
});
