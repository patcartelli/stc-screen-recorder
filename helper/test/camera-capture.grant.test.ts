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

/**
 * Long enough for a slow camera to open AND warm up AND deliver frames.
 *
 * Measured on this hardware 2026-08-27: an Elgato Facecam 4K on USB2 took
 * **2.246 s** merely to open, and phase 0 measured a further ~1.035 s of
 * warm-up before the first frame. A 4 s recording left roughly 0.7 s for
 * frames and produced a zero-byte camera.mp4 with `present: false` — the test
 * failing for a reason that had nothing to do with the code under test.
 */
const RECORD_MS = 15_000;

describe("camera capture — requires Screen Recording AND Camera", () => {
  test("a real recording produces camera.mp4 and a schema-valid anchors.camera", () => {
    if (!existsSync(APP)) {
      throw new Error(`${APP} is missing — run tools/test-host/build.sh first`);
    }
    const dir = mkdtempSync(join(tmpdir(), "stc-camcap-"));
    execFileSync("open", ["-W", APP, "--args", "--helper", HELPER,
                          "--dir", dir, "--ms", String(RECORD_MS), "--camera",
                          "--out", join(dir, "result.json")],
                 { timeout: 120_000 });

    const anchorsPath = join(dir, "anchors.json");
    if (!existsSync(anchorsPath)) {
      // Distinguish the two causes rather than blaming grants for both. If the
      // test-host wrote its transcript, it RAN — so a missing anchors.json is a
      // recording failure, not a permission one, and saying "grant something"
      // would send the reader after a problem they do not have.
      const resultPath = join(dir, "result.json");
      if (existsSync(resultPath)) {
        throw new Error(
          "the test-host ran but the recording produced no anchors.json — this is NOT " +
          "a grant problem. Its transcript:\n" + readFileSync(resultPath, "utf8").slice(0, 2000));
      }
      throw new Error(
        "SKIP-GRANT: the test-host produced nothing at all, most likely missing " +
        "Screen Recording and/or Camera for STC Signing Probe. The Camera pane only " +
        "lists apps that have already REQUESTED access, so the bundle will not appear " +
        "there until it has. Working procedure: (1) run 'open -W " +
        join(root, "tools/test-host/STCTestHost.app") +
        " --args --camera-request --out /tmp/cam-request.json' to raise the system " +
        "prompt, (2) click Allow, (3) grant Screen Recording to STC Signing Probe in " +
        "System Settings if not already granted, (4) re-run 'npm run test:capture'.");
    }

    const anchors = JSON.parse(readFileSync(anchorsPath, "utf8"));

    if (anchors.camera?.present !== true) {
      throw new Error(
        `SKIP-GRANT: the take has no camera track (present=${anchors.camera?.present}). ` +
        "The Camera pane only lists apps that have already REQUESTED access, " +
        "so the bundle will not appear there until it has. Working procedure: " +
        `(1) run 'open -W ${APP} --args --camera-request --out /tmp/cam-request.json' ` +
        "to raise the system prompt, (2) click Allow, (3) re-run this test " +
        "(or 'npm run test:capture').");
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
    // Camera PTS must be used as-is: already mach host time, already
    // latency-compensated, session-relative like everything else in
    // anchors.json. Phase 0 measured the camera's first frame landing
    // ~1035 ms AFTER the display track's first frame (camera warm-up is much
    // slower than SCK's). Two assertions, not one magic number, because a
    // single loose floor only catches a hard rebase to literal zero and lets
    // a PARTIAL rebase (e.g. to stream-start instead of session t0Ns) pass
    // silently in the tens-to-low-hundreds-of-ms range.
    //
    // 1. A modest floor, which is all a lower bound can honestly be. A rebase
    //    to the camera stream's own start puts the first frame at ~0, or at
    //    most one frame interval (~17 ms); 100 ms clears that by 6x.
    //
    //    MEASURED 2026-08-27, and this is why the bound is not tighter. An
    //    earlier version required first > capture.firstFrameNs + 300 ms and a
    //    500 ms absolute floor, reasoning from phase 0's ~1035 ms warm-up. On
    //    an Elgato Facecam 4K [USB2] a COLD device took 2.246 s merely to
    //    open — but a WARM one delivered its first frame at 604 ms against the
    //    display's 220 ms, clearing those bounds by 83 ms and 104 ms. The
    //    display-to-camera gap is not a stable quantity; a bound built on it
    //    measures warm-up luck, not correctness, and would fail spuriously on
    //    a built-in camera. The upper bound below is the real discriminator.
    expect(cam.firstFramePtsNs).toBeGreaterThan(100_000_000);
    // ~58.8 fps measured; anything outside this is not a camera frame interval.
    expect(cam.frameIntervalNs).toBeGreaterThan(8_000_000);
    expect(cam.frameIntervalNs).toBeLessThan(50_000_000);
    // 3. Upper bound. Every assertion above is a LOWER bound, so deleting the
    //    "- Int64(t0Ns)" in CameraCapture.swift (making the PTS boot-relative
    //    instead of session-relative — ~10^13 ns on real uptime) would still
    //    pass every one of them: greater than firstFrameNs + 300ms, greater
    //    than 500ms, last > first, interval unchanged. This is the assertion
    //    that actually distinguishes a session-relative value from an
    //    additive rebase to boot time (or to stream-start, or to any other
    //    origin later than t0Ns): anchors.stop.t is the session duration in
    //    session-relative ns, measured by this same helper run, so no
    //    session-relative timestamp can legitimately exceed it.
    expect(cam.lastFramePtsNs).toBeLessThanOrEqual(anchors.stop.t);
  }, 180_000);
});
