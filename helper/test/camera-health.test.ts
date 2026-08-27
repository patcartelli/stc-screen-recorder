import { describe, test, expect } from "vitest";
import { classifyCameraTrack } from "./_camera-health.js";

/**
 * A starved camera and a mistimed one trip the same frame-interval bound, and
 * they mean opposite things. This is the discriminator, tested against numbers
 * actually recorded on this hardware on 2026-08-27 rather than invented ones.
 *
 * It lives in a NON-grant file on purpose: the classifier is pure, so it can
 * run in CI where the camera it reasons about cannot.
 */

/** Real run, quiet machine: Elgato Facecam 4K, 887 frames over 14.78 s. */
const HEALTHY = {
  frames: 887,
  device: "Elgato Facecam 4K [USB2]",
  firstFramePtsNs: 504_677_778,
  lastFramePtsNs: 15_287_744_444,
  stopTNs: 15_400_000_000,
};

/**
 * CONSTRUCTED, not observed: a physical device at a low rate.
 *
 * The numbers are from the real 16:25 run, but its device field is not — that
 * run actually opened "Elgato Virtual Camera" (see the virtual-camera test
 * below, which is the observed case). No run has yet been seen where a
 * genuinely physical camera under-delivered, so this case exists to pin the
 * OTHER branch of the message rather than to record a measurement. Labelled as
 * such so nobody later cites it as evidence that it happens.
 */
const PHYSICAL_LOW_RATE = {
  frames: 12,
  device: "Elgato Facecam 4K [USB2]",
  firstFramePtsNs: 4_061_977_778,
  lastFramePtsNs: 15_060_207_778,
  stopTNs: 15_268_000_000,
};

describe("telling a starved camera from a mistimed one", () => {
  test("a full-rate track is healthy", () => {
    expect(classifyCameraTrack(HEALTHY).kind).toBe("healthy");
  });

  test("12 frames in 11 s with sane timestamps is the DEVICE, not the clock", () => {
    const v = classifyCameraTrack(PHYSICAL_LOW_RATE);
    expect(v.kind).toBe("starved");
    if (v.kind !== "starved") throw new Error("unreachable");
    // The message has to say which one it is, or it is no better than the
    // assertion it replaced.
    expect(v.message).toMatch(/12 frames/);
    expect(v.message).toMatch(/NOT a clock bug/i);
  });

  // THE case that must never be excused as starvation. Deleting the
  // "- Int64(t0Ns)" in CameraCapture.swift makes PTS boot-relative (~10^13 ns
  // on real uptime), which is the regression the upper bound exists to catch.
  // If a low frame rate could mask it, this test file would have made the
  // suite weaker rather than clearer.
  test("boot-relative PTS is mistimed even when the rate is also low", () => {
    const bootRelative = {
      frames: 12,
      device: "Elgato Facecam 4K [USB2]",
      firstFramePtsNs: 245_346_000_000_000,
      lastFramePtsNs: 245_357_000_000_000,
      stopTNs: 15_268_000_000,
    };
    expect(classifyCameraTrack(bootRelative).kind).toBe("mistimed");
  });

  test("boot-relative PTS at a NORMAL rate is mistimed too", () => {
    expect(classifyCameraTrack({
      ...HEALTHY,
      firstFramePtsNs: 245_346_000_000_000,
      lastFramePtsNs: 245_357_000_000_000,
    }).kind).toBe("mistimed");
  });

  // A rebase to the camera stream's own start puts the first frame at ~0.
  test("a track starting at zero is mistimed, not healthy", () => {
    expect(classifyCameraTrack({ ...HEALTHY, firstFramePtsNs: 0 }).kind).toBe("mistimed");
  });

  // Measured 2026-08-27: three consecutive runs at EXACTLY 1 fps because the
  // physical Facecam stopped being enumerated and capture fell through to
  // Elgato's virtual device. Blaming machine load would have sent the reader
  // hunting the wrong thing entirely.
  test("a virtual camera at 1 fps says so, instead of blaming machine load", () => {
    const v = classifyCameraTrack({
      frames: 12,
      device: "Elgato Virtual Camera",
      firstFramePtsNs: 3_400_000_000,
      lastFramePtsNs: 14_400_000_000,
      stopTNs: 15_268_000_000,
    });
    expect(v.kind).toBe("starved");
    if (v.kind !== "starved") throw new Error("unreachable");
    expect(v.message).toMatch(/VIRTUAL camera/);
    expect(v.message).toMatch(/Elgato Virtual Camera/);
    expect(v.message, "must not send the reader after machine load").not.toMatch(/Check machine load/);
  });

  test("a real device at a low rate DOES point at load", () => {
    const v = classifyCameraTrack(PHYSICAL_LOW_RATE);
    if (v.kind !== "starved") throw new Error("expected starved");
    expect(v.message).toMatch(/Check machine load/);
    expect(v.message).not.toMatch(/VIRTUAL camera/);
  });

  test("a single frame cannot be called healthy — there is no rate to check", () => {
    expect(classifyCameraTrack({ ...HEALTHY, frames: 1 }).kind).toBe("starved");
  });
});
