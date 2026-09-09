import { describe, test, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSettings, writeSettings, DEFAULT_SETTINGS, DEFAULT_SHARE_SETTINGS, DEFAULT_STILL_SETTINGS,
  DEFAULT_THUMBNAIL_SETTINGS,
} from "../src/settings.js";
import { DEFAULT_SHORTCUTS, HYPER } from "../src/hotkeys.js";

/**
 * The camera preference is opt-in, default off, and sticky (design spec).
 *
 * It lives in the main process rather than the renderer because it decides
 * whether a physical camera LED comes on, and the renderer is not trusted with
 * paths or with being the source of truth for that.
 */
const dir = () => mkdtempSync(join(tmpdir(), "stc-settings-"));

describe("the camera preference", () => {
  test("defaults to off when nothing has been saved", () => {
    expect(readSettings(dir()))
      .toEqual({ camera: false, displayId: null, shortcuts: DEFAULT_SHORTCUTS,
                 shutterSound: true, still: DEFAULT_STILL_SETTINGS,
                 thumbnail: DEFAULT_THUMBNAIL_SETTINGS, share: DEFAULT_SHARE_SETTINGS });
    expect(DEFAULT_SETTINGS.camera).toBe(false);
  });

  test("round-trips", () => {
    const d = dir();
    writeSettings(d, { camera: true });
    expect(readSettings(d).camera).toBe(true);
    writeSettings(d, { camera: false });
    expect(readSettings(d).camera).toBe(false);
  });

  // A corrupt sidecar must not cost a recording — the same rule parseProject
  // follows for a mangled project.json. Throwing here would mean a bad byte in
  // a preferences file makes the app unable to record at all.
  test("corrupt JSON falls back to the default instead of throwing", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"), "{not json");
    expect(readSettings(d)).toEqual(DEFAULT_SETTINGS);
  });

  test("a file of the wrong shape falls back too", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"), JSON.stringify(["nope"]));
    expect(readSettings(d)).toEqual(DEFAULT_SETTINGS);
    writeFileSync(join(d, "settings.json"), JSON.stringify({ camera: "yes" }));
    expect(readSettings(d).camera, "a non-boolean is not a preference").toBe(false);
  });

  // Otherwise a typo in one call silently persists a key nothing reads, and the
  // file becomes a place where wrong things accumulate unnoticed.
  test("unknown keys are dropped rather than persisted", () => {
    const d = dir();
    writeSettings(d, { camera: true, nonsense: 1 } as never);
    expect(JSON.parse(readFileSync(join(d, "settings.json"), "utf8")))
      .toEqual({ camera: true, displayId: null, shortcuts: DEFAULT_SHORTCUTS,
                 shutterSound: true, still: DEFAULT_STILL_SETTINGS,
                 thumbnail: DEFAULT_THUMBNAIL_SETTINGS, share: DEFAULT_SHARE_SETTINGS });
  });

  test("an unwritable directory does not throw — the preference is not worth a crash", () => {
    const d = join(dir(), "readonly");
    mkdirSync(d);
    chmodSync(d, 0o500);
    expect(() => writeSettings(d, { camera: true })).not.toThrow();
    chmodSync(d, 0o700);
  });

  test("a partial update leaves the rest alone", () => {
    const d = dir();
    writeSettings(d, { camera: true });
    writeSettings(d, {});
    expect(readSettings(d).camera).toBe(true);
    expect(existsSync(join(d, "settings.json"))).toBe(true);
  });
});

describe("the display preference (STC-247)", () => {
  test("defaults to automatic — null, which start() turns into no displayId at all", () => {
    expect(readSettings(dir()).displayId).toBeNull();
    expect(DEFAULT_SETTINGS.displayId).toBeNull();
  });

  test("round-trips an id and clears back to automatic", () => {
    const d = dir();
    writeSettings(d, { displayId: 69734662 });
    expect(readSettings(d).displayId).toBe(69734662);
    writeSettings(d, { displayId: null });
    expect(readSettings(d).displayId).toBeNull();
  });

  // A display id is a CGDirectDisplayID: a positive integer. Anything else is
  // not a choice, and passing it to the helper would be an error the user
  // never asked for.
  test("a value that is not a positive integer reads as automatic", () => {
    const d = dir();
    for (const bad of ["2", 0, -1, 1.5, true, {}]) {
      writeFileSync(join(d, "settings.json"), JSON.stringify({ camera: false, displayId: bad }));
      expect(readSettings(d).displayId, `displayId ${JSON.stringify(bad)}`).toBeNull();
    }
  });

  test("a partial update leaves the display choice alone", () => {
    const d = dir();
    writeSettings(d, { displayId: 2 });
    writeSettings(d, { camera: true });
    expect(readSettings(d))
      .toEqual({ camera: true, displayId: 2, shortcuts: DEFAULT_SHORTCUTS,
                 shutterSound: true, still: DEFAULT_STILL_SETTINGS,
                 thumbnail: DEFAULT_THUMBNAIL_SETTINGS, share: DEFAULT_SHARE_SETTINGS });
  });
});

/**
 * The shutter sound (STC-292). Unlike the camera, this defaults ON — macOS's
 * own screenshot makes a noise, and a capture with no window and no overlay has
 * no other feedback at all. Which is why every fallback here goes to ON, the
 * mirror of the camera's `=== true`.
 */
describe("the shutter sound preference", () => {
  test("defaults to on", () => {
    expect(readSettings(dir()).shutterSound).toBe(true);
  });

  test("round-trips, and being off survives a restart", () => {
    const d = dir();
    writeSettings(d, { shutterSound: false });
    expect(readSettings(d).shutterSound).toBe(false);
    writeSettings(d, { shutterSound: true });
    expect(readSettings(d).shutterSound).toBe(true);
  });

  test("a non-boolean is not a preference, and falls back to ON not to silence", () => {
    const d = dir();
    for (const bad of ["false", 0, null, {}]) {
      writeFileSync(join(d, "settings.json"), JSON.stringify({ shutterSound: bad }));
      expect(readSettings(d).shutterSound, JSON.stringify(bad)).toBe(true);
    }
  });

  test("a partial update leaves it alone", () => {
    const d = dir();
    writeSettings(d, { shutterSound: false });
    writeSettings(d, { camera: true });
    expect(readSettings(d).shutterSound).toBe(false);
  });
});

/**
 * The capture shortcuts (STC-292). Stored here rather than in the renderer for
 * the same reason the camera is: main registers them at launch, before any
 * window exists, so a preference the renderer owned would arrive too late to
 * be the thing that binds.
 */
describe("the capture shortcuts", () => {
  test("default to the hyperkey row when nothing has been saved", () => {
    expect(readSettings(dir()).shortcuts).toEqual({
      region: `${HYPER}+1`, window: `${HYPER}+2`, display: `${HYPER}+3`,
    });
  });

  test("a rebinding round-trips, which is the acceptance criterion", () => {
    const d = dir();
    writeSettings(d, { shortcuts: { ...DEFAULT_SHORTCUTS, region: "Alt+Shift+R" } });
    // Read back through a fresh call, as a relaunch would.
    expect(readSettings(d).shortcuts.region).toBe("Alt+Shift+R");
    expect(readSettings(d).shortcuts.window).toBe(DEFAULT_SHORTCUTS.window);
  });

  test("stored NORMALISED, so the file, the menu bar and the report agree", () => {
    const d = dir();
    writeSettings(d, { shortcuts: { ...DEFAULT_SHORTCUTS, window: "shift+alt+r" } });
    expect(JSON.parse(readFileSync(join(d, "settings.json"), "utf8")).shortcuts.window)
      .toBe("Alt+Shift+R");
  });

  test("an unbound action stays unbound across a restart", () => {
    // `null` is a preference, not an absence: springing back to the default the
    // next time the file is read would silently rebind a key the user cleared.
    const d = dir();
    writeSettings(d, { shortcuts: { ...DEFAULT_SHORTCUTS, display: null } });
    expect(readSettings(d).shortcuts.display).toBeNull();
  });

  test("a binding that no longer parses falls back to the default, not to nothing", () => {
    const d = dir();
    for (const bad of ["Command+Hyper", "A", 7, {}, ["Command+A"]]) {
      writeFileSync(join(d, "settings.json"),
                    JSON.stringify({ shortcuts: { region: bad } }));
      expect(readSettings(d).shortcuts.region, JSON.stringify(bad))
        .toBe(DEFAULT_SHORTCUTS.region);
    }
  });

  test("a hand-edited file naming a system binding falls back rather than storing it", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"), JSON.stringify({ shortcuts: { region: "Command+Shift+4" } }));
    expect(readSettings(d).shortcuts.region).toBe(DEFAULT_SHORTCUTS.region);
  });

  test("a partial update leaves the shortcuts alone", () => {
    const d = dir();
    writeSettings(d, { shortcuts: { ...DEFAULT_SHORTCUTS, region: null } });
    writeSettings(d, { camera: true });
    expect(readSettings(d).shortcuts.region).toBeNull();
  });

  test("only known actions are written — a typo cannot accumulate in the file", () => {
    const d = dir();
    writeSettings(d, { shortcuts: { ...DEFAULT_SHORTCUTS, regoin: "Alt+X" } as never });
    const stored = JSON.parse(readFileSync(join(d, "settings.json"), "utf8"));
    expect(Object.keys(stored.shortcuts).sort()).toEqual(["display", "region", "window"]);
  });
});

/**
 * STC-242: where a shared take goes. Same rules as every other block — an
 * unknown shape falls back whole, each field is validated on its own terms.
 */
describe("the share preferences (STC-242)", () => {
  test("defaults to no site folder and the network slug", () => {
    const s = readSettings(dir()).share;
    // Null rather than a guess: this app cannot know where someone keeps a
    // site checkout, and a wrong default writes a file somewhere unasked.
    expect(s.destination).toBeNull();
    expect(s.slug).toBe("network");
    expect(s.embedTemplate).toContain("{src}");
  });

  test("the site folder is sticky and survives an unrelated change", () => {
    const d = dir();
    writeSettings(d, { share: { ...readSettings(d).share, destination: "/Users/me/site/public" } });
    writeSettings(d, { camera: true });
    expect(readSettings(d).share.destination).toBe("/Users/me/site/public");
  });

  test("changing the slug does NOT drop the site folder", () => {
    const d = dir();
    writeSettings(d, { share: { ...readSettings(d).share, destination: "/Users/me/site" } });
    writeSettings(d, { share: { slug: "vividly" } as never });
    const s = readSettings(d).share;
    expect(s.slug).toBe("vividly");
    expect(s.destination).toBe("/Users/me/site");
  });

  /**
   * The one that is a decision rather than plumbing: a stored slug that no
   * longer validates falls back to the DEFAULT rather than being repaired into
   * something adjacent. Turning "My Demo" into "my-demo" would publish to a
   * path the user never chose and never saw, while the page embedding the old
   * one broke silently.
   */
  test("an invalid stored slug falls back rather than being repaired", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"),
                  JSON.stringify({ share: { slug: "My Demo", destination: "/s" } }));
    const s = readSettings(d).share;
    expect(s.slug).toBe("network");
    expect(s.slug).not.toBe("my-demo");
    // The destination beside it is still honoured — one bad field does not
    // cost the whole block.
    expect(s.destination).toBe("/s");
  });

  test("a relative destination is treated as unset, not resolved against cwd", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"), JSON.stringify({ share: { destination: "site/public" } }));
    expect(readSettings(d).share.destination).toBeNull();
  });

  test("an empty template falls back rather than pasting nothing", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"), JSON.stringify({ share: { embedTemplate: "   " } }));
    expect(readSettings(d).share.embedTemplate).toContain("{src}");
  });
});

/**
 * STC-293: the still export preferences. One destination folder and one
 * filename template, shared by every exit out of the app — the ticket's Note
 * forbids the thumbnail growing its own.
 */
describe("the still export preferences (STC-293)", () => {
  test("defaults are PNG, native scale, metadata kept, and no chosen folder", () => {
    const s = readSettings(dir()).still;
    expect(s.format).toBe("png");
    expect(s.scale).toBe("native");
    expect(s.stripMetadata).toBe(false);
    // Null, not a hardcoded ~/Desktop: an unconfigured still belongs beside
    // the shot.json it was rendered from.
    expect(s.destination).toBeNull();
    expect(s.template).toContain("{date}");
  });

  test("the destination folder is sticky", () => {
    const d = dir();
    writeSettings(d, { still: { ...readSettings(d).still, destination: "/Users/me/Shots" } });
    expect(readSettings(d).still.destination).toBe("/Users/me/Shots");
  });

  test("changing the format does NOT drop the destination folder", () => {
    // The bug a shallow spread would introduce: a preference the user set
    // months ago resetting because an unrelated one was touched.
    const d = dir();
    writeSettings(d, { still: { ...readSettings(d).still, destination: "/Users/me/Shots" } });
    writeSettings(d, { still: { format: "jpeg" } as never });
    const s = readSettings(d).still;
    expect(s.format).toBe("jpeg");
    expect(s.destination).toBe("/Users/me/Shots");
  });

  test("a still preference survives an unrelated camera change", () => {
    const d = dir();
    writeSettings(d, { still: { ...readSettings(d).still, format: "heic" } });
    writeSettings(d, { camera: true });
    expect(readSettings(d).still.format).toBe("heic");
  });

  test("a relative destination is treated as unset, never resolved against the cwd", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"),
                  JSON.stringify({ still: { destination: "Shots" } }));
    expect(readSettings(d).still.destination).toBeNull();
  });

  test("an unknown format or scale falls back rather than reaching the encoder", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"),
                  JSON.stringify({ still: { format: "webp", scale: "4x", quality: 99 } }));
    const s = readSettings(d).still;
    expect(s.format).toBe("png");
    expect(s.scale).toBe("native");
    expect(s.quality).toBe(1);
  });

  test("an empty template falls back, so a save is never named \".png\"", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"), JSON.stringify({ still: { template: "   " } }));
    expect(readSettings(d).still.template).toBe(DEFAULT_SETTINGS.still.template);
  });

  test("a still block of the wrong shape falls back whole", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"), JSON.stringify({ still: "png please" }));
    expect(readSettings(d).still).toEqual(DEFAULT_SETTINGS.still);
  });
});

/**
 * The post-capture floating thumbnail's preferences (STC-296): where it sits,
 * how long it waits, and what ignoring it does. `thumbnail.ts` owns the
 * validation rules (the timeout floor, the corner enum); this only checks that
 * `settings.ts` applies them the same way every other block here is applied —
 * falls back field by field, and a partial update leaves the rest alone.
 */
describe("the thumbnail preferences (STC-296)", () => {
  test("defaults: bottom-right, 6 s, save, not skipped", () => {
    const t = readSettings(dir()).thumbnail;
    expect(t).toEqual({ corner: "bottom-right", timeoutMs: 6000, settleAction: "save", skip: false });
  });

  test("round-trips a full change", () => {
    const d = dir();
    writeSettings(d, { thumbnail: { corner: "top-left", timeoutMs: 4000, settleAction: "copy", skip: true } });
    expect(readSettings(d).thumbnail)
      .toEqual({ corner: "top-left", timeoutMs: 4000, settleAction: "copy", skip: true });
  });

  test("changing one field does not drop the others", () => {
    const d = dir();
    writeSettings(d, { thumbnail: { ...readSettings(d).thumbnail, corner: "top-right" } });
    writeSettings(d, { thumbnail: { ...readSettings(d).thumbnail, skip: true } });
    const t = readSettings(d).thumbnail;
    expect(t.corner).toBe("top-right");
    expect(t.skip).toBe(true);
  });

  test("a timeout below the floor is raised to it, never stored as given", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"), JSON.stringify({ thumbnail: { timeoutMs: 500 } }));
    expect(readSettings(d).thumbnail.timeoutMs).toBe(3000);
  });

  test("an unknown corner or settle action falls back rather than reaching the window", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"),
                  JSON.stringify({ thumbnail: { corner: "middle", settleAction: "delete" } }));
    const t = readSettings(d).thumbnail;
    expect(t.corner).toBe("bottom-right");
    expect(t.settleAction).toBe("save");
  });

  test("a non-boolean skip is not a preference, and falls back to off", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"), JSON.stringify({ thumbnail: { skip: "yes" } }));
    expect(readSettings(d).thumbnail.skip).toBe(false);
  });

  test("a thumbnail block of the wrong shape falls back whole", () => {
    const d = dir();
    writeFileSync(join(d, "settings.json"), JSON.stringify({ thumbnail: "bottom-right please" }));
    expect(readSettings(d).thumbnail).toEqual(DEFAULT_SETTINGS.thumbnail);
  });

  test("a still-preference change leaves the thumbnail preference alone, and vice versa", () => {
    const d = dir();
    writeSettings(d, { thumbnail: { ...readSettings(d).thumbnail, skip: true } });
    writeSettings(d, { still: { ...readSettings(d).still, format: "heic" } });
    expect(readSettings(d).thumbnail.skip).toBe(true);
    expect(readSettings(d).still.format).toBe("heic");
  });
});
