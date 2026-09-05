import { describe, test, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, writeSettings, DEFAULT_SETTINGS } from "../src/settings.js";

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
    expect(readSettings(dir())).toEqual({ camera: false, displayId: null });
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
    expect(JSON.parse(readFileSync(join(d, "settings.json"), "utf8"))).toEqual({ camera: true, displayId: null });
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
    expect(readSettings(d)).toEqual({ camera: true, displayId: 2 });
  });
});
