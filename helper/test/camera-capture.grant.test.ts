/**
 * Requires BOTH a Screen Recording grant and a Camera grant for the STC Signing
 * Probe bundle. Not part of `npm test` — see vitest.grant.config.ts and
 * `npm run test:capture`.
 *
 * A separate FILE, not a skip: a skipped test reads as covered and quietly
 * rots. This is the first thing in the repo able to measure two things that
 * were previously just opinions — that a real camera track lands with
 * firstFramePtsNs comfortably above zero (phase 0 measured ~1035 ms of
 * warm-up), and that anchors.camera actually validates against anchors-2.
 */
import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AjvImport from "ajv";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const APP = join(root, "tools/test-host/STCTestHost.app");
const HELPER = join(root, "helper/build/stc-helper");

describe("camera capture — requires Screen Recording AND Camera", () => {
  test("a real recording produces camera.mp4 and a schema-valid anchors.camera", () => {
    if (!existsSync(APP)) {
      throw new Error(`${APP} is missing — run tools/test-host/build.sh first`);
    }
    const dir = mkdtempSync(join(tmpdir(), "stc-camcap-"));
    execFileSync("open", ["-W", APP, "--args", "--helper", HELPER,
                          "--dir", dir, "--ms", "4000", "--camera",
                          "--out", join(dir, "result.json")],
                 { timeout: 120_000 });

    const anchorsPath = join(dir, "anchors.json");
    if (!existsSync(anchorsPath)) {
      throw new Error("SKIP-GRANT: no anchors.json — the recording never ran. " +
                      "Grant Screen Recording and Camera to STC Signing Probe.");
    }
    const anchors = JSON.parse(readFileSync(anchorsPath, "utf8"));

    if (anchors.camera?.present !== true) {
      throw new Error(
        `SKIP-GRANT: the take has no camera track (present=${anchors.camera?.present}). ` +
        `Grant Camera to STC Signing Probe, then re-run.`);
    }

    const ajv = new Ajv({ allErrors: true, strict: true });
    const validate = ajv.compile(JSON.parse(
      readFileSync(join(root, "schema/anchors-2.schema.json"), "utf8")));
    expect(validate(anchors), JSON.stringify(validate.errors, null, 2)).toBe(true);

    expect(anchors.version).toBe(2);
    expect(anchors.files.camera).toBe("camera.mp4");
    expect(statSync(join(dir, "camera.mp4")).size).toBeGreaterThan(0);

    const cam = anchors.camera;
    expect(cam.width).toBe(1280);
    expect(cam.height).toBe(720);
    expect(cam.lastFramePtsNs).toBeGreaterThan(cam.firstFramePtsNs);
    // Phase 0 measured the camera's first frame landing ~1035 ms after the
    // screen's, from warm-up. Anything at or near zero means the PTS was
    // rebased somewhere it should not have been.
    expect(cam.firstFramePtsNs).toBeGreaterThan(50_000_000);
    // ~58.8 fps measured; anything outside this is not a camera frame interval.
    expect(cam.frameIntervalNs).toBeGreaterThan(8_000_000);
    expect(cam.frameIntervalNs).toBeLessThan(50_000_000);
  }, 180_000);
});
