import { demuxDisplayMp4, type DemuxedVideo } from "./demux.js";
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
}

export interface LoadedSession extends Session {
  video: DemuxedVideo;
}

/**
 * How far the offset recovered from the file may differ from the offset the
 * helper measured. The file stores it as an empty edit quantised to the movie
 * timescale (90 kHz), and AVAssetWriter truncates rather than rounds, so a
 * full tick of disagreement is normal. Anything larger means the reader and the
 * writer disagree about time itself.
 */
const OFFSET_TOLERANCE_NS = 50_000;

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

  // loadSession has no camera input yet (no path to a camera file, no
  // cameraFrames demux) — increment 3 adds that. A v2 session that claims a
  // camera track would otherwise load "successfully" and render() would
  // silently return pip: null with no diagnostic, exactly the class of silent
  // failure the offset check above exists to make loud instead.
  if (anchors.camera?.present === true) {
    throw new SessionLoadError(
      "anchors.camera.present is true, but loadSession does not load camera tracks yet " +
      "(increment 3 adds camera demux). Refusing to silently drop the PiP.",
    );
  }

  const video = await demuxDisplayMp4(input.displayMp4);
  if (video.framesNs.length === 0) {
    throw new SessionLoadError("display.mp4 contains no frames");
  }

  // The helper wrote down what it measured; the file only preserves a quantised
  // version of it. Comparing the two turns a whole class of silent clock bugs
  // into a loud one — a desync of a few frames looks like a rendering fault.
  const measured = (anchors.capture as { firstFrameNs?: number }).firstFrameNs;
  if (typeof measured === "number") {
    const drift = Math.abs(video.framesNs[0]! - measured);
    if (drift > OFFSET_TOLERANCE_NS) {
      throw new SessionLoadError(
        `frame-time offset disagreement: helper measured ${measured} ns, file yields ` +
        `${video.framesNs[0]} ns (${(drift / 1e6).toFixed(1)} ms apart). The cursor would ` +
        `render out of sync with the video by that amount.`,
      );
    }
  }

  return {
    anchors,
    events: [...events.events].sort((a, b) => a.t - b.t),
    frames: video.framesNs,
    video,
  };
}
