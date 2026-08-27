/**
 * Was the camera track badly TIMED, or was the camera simply not fed?
 *
 * Both produce a frame interval far outside the plausible 8-50 ms band, and
 * they call for opposite responses: one is a regression in
 * `CameraCapture.swift`, the other is a busy machine. Before this existed they
 * were indistinguishable — a starved run reported as
 * "expected 999990000 to be less than 50000000" against `anchors.camera`,
 * which reads as a clock bug and is not one. Same shape as STC-259, and this
 * repo has already paid for that confusion once.
 *
 * The separation is the FRAME COUNT. A units or rebase bug computes wrong
 * timestamps over a normal number of frames; a starved device produces few
 * frames whose timestamps are perfectly correct. So the rate is derived from
 * frames actually present in the file, never from `frameIntervalNs` — that is
 * the number under suspicion.
 *
 * Pure, so it runs in CI where the camera it reasons about cannot.
 */

export type CameraVerdict =
  | { kind: "healthy" }
  | { kind: "starved"; message: string }
  | { kind: "mistimed" };

export interface CameraTrackFacts {
  /** Frames actually demuxed from camera.mp4. */
  frames: number;
  /** `anchors.camera.device` — which device was actually opened. */
  device: string;
  firstFramePtsNs: number;
  lastFramePtsNs: number;
  /** `anchors.stop.t` — the session duration, in the same session-relative ns. */
  stopTNs: number;
}

/** Below this, the device did not keep up. Real hardware measures ~58.8 fps. */
const STARVED_FPS = 20;

/**
 * A rebase to the camera stream's own start puts the first frame at ~0, or at
 * most one frame interval (~17 ms); 100 ms clears that by 6x.
 */
const MIN_PLAUSIBLE_FIRST_NS = 100_000_000;

export function classifyCameraTrack(f: CameraTrackFacts): CameraVerdict {
  // Timestamps are judged FIRST and on their own terms. A boot-relative rebase
  // must never be excused as "the camera was slow" — that would let the exact
  // regression the upper bound exists to catch hide behind a busy machine.
  const clockSane =
    f.firstFramePtsNs > MIN_PLAUSIBLE_FIRST_NS &&
    f.lastFramePtsNs > f.firstFramePtsNs &&
    f.lastFramePtsNs <= f.stopTNs;
  if (!clockSane) return { kind: "mistimed" };

  const spanS = (f.lastFramePtsNs - f.firstFramePtsNs) / 1e9;
  // One frame spans nothing, so there is no rate to judge — and a track that
  // short is not evidence the pipeline works either way.
  const fps = spanS > 0 ? f.frames / spanS : 0;
  if (fps >= STARVED_FPS) return { kind: "healthy" };

  // Name the device. Measured 2026-08-27: three consecutive runs produced
  // EXACTLY 1 fps because the physical "Elgato Facecam 4K [USB2]" had stopped
  // being enumerated and capture fell through to "Elgato Virtual Camera" — a
  // software device that emits ~1 fps with nothing feeding it. A message that
  // blamed machine load would have sent the reader hunting the wrong thing;
  // the device name makes the real cause obvious at a glance.
  const virtualish = /virtual|obs|camo|ndi|snap|loopback/i.test(f.device);
  return {
    kind: "starved",
    message:
      `ENVIRONMENT: camera "${f.device}" delivered ${f.frames} frames in ${spanS.toFixed(1)} s ` +
      `(${fps.toFixed(1)} fps), and its first frame took ` +
      `${(f.firstFramePtsNs / 1e6).toFixed(0)} ms to arrive. The timestamps are internally ` +
      `consistent — first frame past ${MIN_PLAUSIBLE_FIRST_NS / 1e6} ms, last frame within ` +
      `anchors.stop.t — so this is the DEVICE not delivering, NOT a clock bug in ` +
      `CameraCapture.swift. The camera-track assertions never ran.` +
      (virtualish
        ? ` \n\nThat device name looks like a VIRTUAL camera. A virtual camera with no ` +
          `source behind it idles at about 1 fps, which is exactly this. Check that the ` +
          `physical camera is still enumerated (system_profiler SPCameraDataType) — if it ` +
          `has dropped off, reconnect it or quit whatever claimed it, then re-run.`
        : ` Check machine load and anything else holding the camera, then re-run.`),
  };
}
