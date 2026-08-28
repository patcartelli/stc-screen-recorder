import type { DemuxedVideo } from "./demux.js";
import { withTimeout, TimeoutError } from "./timeout.js";

/** One constant, so the bound and the message it prints cannot disagree. */
const FLUSH_MS = 60_000;

/**
 * Decode-all frame cache for the increment-0 harness: the fixture is 90 small
 * frames, so every frame is decoded up front into an ImageBitmap and the
 * VideoFrame closed in the output callback (PHASE-0 §4b.3 — never buffer
 * VideoFrames). The product's scrubbing cache (single in-flight request,
 * coalescing queue, GOP-aware seeks) is increment-4 work; do not grow this
 * into it accidentally.
 *
 * No B-frames (cts===dts, verified by test) means output order equals
 * submission order, so frame index k of the output IS framesNs[k].
 */
export async function decodeAll(video: DemuxedVideo): Promise<ImageBitmap[]> {
  const bitmapPromises: Promise<ImageBitmap>[] = [];
  let rejectAll: (e: Error) => void;
  const failure = new Promise<never>((_, rej) => { rejectAll = rej; });

  const decoder = new VideoDecoder({
    output: (frame) => {
      bitmapPromises.push(
        createImageBitmap(frame).then((b) => { frame.close(); return b; },
                                      (e) => { frame.close(); throw e; }),
      );
    },
    error: (e) => rejectAll(e),
  });
  decoder.configure({
    codec: video.codec,
    codedWidth: video.codedWidth,
    codedHeight: video.codedHeight,
    description: video.description,
  });
  for (const c of video.chunks) {
    decoder.decode(new EncodedVideoChunk({
      type: c.type, timestamp: c.timestampUs, data: c.data as BufferSource,
    }));
  }
  // flush() is a promise from the decoder; nothing guarantees it settles. The
  // `failure` side only fires on an error callback, so racing them still leaves
  // both able to hang together.
  //
  // When it does hang, "decoder flush did not complete within 60000ms" does not
  // say WHERE it stopped, and that is the whole question: a decoder that emitted
  // nothing has failed to start, while one that emitted 89 of 90 stalled at the
  // end. Those are different bugs. Measured on CI, this fires on roughly half of
  // master's push runs (STC-259). The counts are gathered only on the failure
  // path, so a healthy run pays nothing for them.
  try {
    await withTimeout(Promise.race([decoder.flush(), failure]), FLUSH_MS, "decoder flush");
  } catch (e) {
    if (!(e instanceof TimeoutError)) throw e;
    throw new Error(
      `decoder flush did not complete within ${FLUSH_MS}ms — submitted ${video.chunks.length} chunks, ` +
      `emitted ${bitmapPromises.length}, decodeQueueSize=${decoder.decodeQueueSize}, ` +
      `state=${decoder.state}, codec=${video.codec} ${video.codedWidth}x${video.codedHeight}` +
      `, ${await describeSupport(video)}`);
  }
  decoder.close();
  const bitmaps = await withTimeout(Promise.all(bitmapPromises), 60_000,
                                    "decoding frames to bitmaps");
  if (bitmaps.length !== video.chunks.length) {
    throw new Error(`decoded ${bitmaps.length} frames, expected ${video.chunks.length}`);
  }
  return bitmaps;
}

/**
 * Which decode paths Chrome claims it can service, asked only when the flush has
 * already hung. `isConfigSupported` is itself a promise settled by the browser,
 * so it gets its own bound: a diagnostic that hangs turns a bad failure into a
 * silent one.
 */
async function describeSupport(video: DemuxedVideo): Promise<string> {
  const base = {
    codec: video.codec,
    codedWidth: video.codedWidth,
    codedHeight: video.codedHeight,
    description: video.description,
  };
  const ask = async (hw: HardwareAcceleration) => {
    try {
      const r = await withTimeout(
        VideoDecoder.isConfigSupported({ ...base, hardwareAcceleration: hw }), 5_000, `probe ${hw}`);
      return `${hw}=${r.supported}`;
    } catch (e) {
      return `${hw}=unknown(${e instanceof Error ? e.name : "?"})`;
    }
  };
  return (await Promise.all([ask("prefer-hardware"), ask("prefer-software")])).join(" ");
}
