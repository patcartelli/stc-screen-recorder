import type { DemuxedVideo } from "./demux.js";
import { withTimeout } from "./timeout.js";

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
  await withTimeout(Promise.race([decoder.flush(), failure]), 60_000, "decoder flush");
  decoder.close();
  const bitmaps = await withTimeout(Promise.all(bitmapPromises), 60_000,
                                    "decoding frames to bitmaps");
  if (bitmaps.length !== video.chunks.length) {
    throw new Error(`decoded ${bitmaps.length} frames, expected ${video.chunks.length}`);
  }
  return bitmaps;
}
