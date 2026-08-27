import { demuxTrack, type DemuxedVideo } from "./demux.js";
import type { Anchors, Session, SessionEvent } from "./types.js";

/**
 * Turns a recorded session on disk into the Session the transform consumes.
 *
 * Environment-agnostic on purpose: it takes already-read data rather than
 * paths, so the same code serves Node tests and the browser export sink.
 */

export class SessionLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionLoadError";
  }
}

export interface SessionInput {
  anchors: Anchors;
  events: { version: number; events: SessionEvent[] };
  displayMp4: ArrayBuffer;
  cameraMp4?: ArrayBuffer;
}

export interface LoadedSession extends Session {
  video: DemuxedVideo;
  cameraVideo?: DemuxedVideo;
}

/**
 * How far the offset recovered from the file may differ from the offset the
 * helper measured. The file stores it as an empty edit quantised to the movie
 * timescale (90 kHz), and AVAssetWriter truncates rather than rounds, so a
 * full tick of disagreement is normal. Anything larger means the reader and the
 * writer disagree about time itself.
 */
const OFFSET_TOLERANCE_NS = 50_000;

/**
 * The helper wrote down what it measured; the file only preserves a
 * timescale-quantised version of it (an empty edit, 90 kHz). Comparing the
 * two turns a whole class of silent clock bugs into a loud one — on the
 * display track a few frames of desync looks like a rendering fault; on the
 * camera track (~1 s empty edit) an unchecked gap is seconds of PiP desync,
 * invisible in a still frame. Shared by both tracks so the two checks cannot
 * drift apart.
 */
function checkFrameOffset(what: string, measuredNs: number | undefined, demuxedFirstNs: number): void {
  if (typeof measuredNs !== "number") return;
  const drift = Math.abs(demuxedFirstNs - measuredNs);
  if (drift > OFFSET_TOLERANCE_NS) {
    throw new SessionLoadError(
      `${what} frame-time offset disagreement: helper measured ${measuredNs} ns, file yields ` +
      `${demuxedFirstNs} ns (${(drift / 1e6).toFixed(1)} ms apart). Render would desync by that amount.`,
    );
  }
}

export async function loadSession(input: SessionInput): Promise<LoadedSession> {
  const { anchors, events } = input;

  // v1 and v2 differ only by additions the transform treats as optional
  // (camera track, pip geometry), so v1 loads as a v2 with both absent. The
  // helper does not emit v2 until increment 3; refusing v1 here would break
  // every grant test in the gap.
  if (anchors?.version !== 1 && anchors?.version !== 2) {
    throw new SessionLoadError(`anchors.json version ${anchors?.version} is not supported (expected 1 or 2)`);
  }
  if (events?.version !== 1) {
    throw new SessionLoadError(`events.json version ${events?.version} is not supported (expected 1)`);
  }

  // A claimed camera with no file supplied, and a file supplied with no
  // claim, are both cases where the two sources disagree about what was
  // recorded — guessing which one is right is worse than refusing. Silently
  // loading either mismatch as camera-less would leave render() reporting
  // pip: null for a take that has one, or vice versa.
  const claimsCamera = anchors.camera?.present === true;
  if (claimsCamera && !input.cameraMp4) {
    throw new SessionLoadError(
      "anchors.camera.present is true but no camera.mp4 was supplied for this take. " +
      "Refusing to silently drop the PiP.",
    );
  }
  if (input.cameraMp4 && !claimsCamera) {
    throw new SessionLoadError(
      "a camera.mp4 was supplied but anchors.camera.present is not true — the anchors and " +
      "the file disagree about whether this take has a camera track.",
    );
  }

  const video = await demuxTrack(input.displayMp4, "display.mp4");
  if (video.framesNs.length === 0) {
    throw new SessionLoadError("display.mp4 contains no frames");
  }
  checkFrameOffset("display.mp4", (anchors.capture as { firstFrameNs?: number }).firstFrameNs, video.framesNs[0]!);

  let cameraVideo: DemuxedVideo | undefined;
  if (claimsCamera && input.cameraMp4) {
    cameraVideo = await demuxTrack(input.cameraMp4, "camera.mp4");
    if (cameraVideo.framesNs.length === 0) {
      throw new SessionLoadError("camera.mp4 contains no frames");
    }
    checkFrameOffset("camera.mp4", anchors.camera!.firstFramePtsNs, cameraVideo.framesNs[0]!);
  }

  return {
    anchors,
    events: [...events.events].sort((a, b) => a.t - b.t),
    frames: video.framesNs,
    cameraFrames: cameraVideo?.framesNs,
    video,
    cameraVideo,
  };
}
