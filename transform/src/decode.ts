import type { DemuxedVideo } from "./demux.js";

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
  await Promise.race([decoder.flush(), failure]);
  decoder.close();
  const bitmaps = await Promise.all(bitmapPromises);
  if (bitmaps.length !== video.chunks.length) {
    throw new Error(`decoded ${bitmaps.length} frames, expected ${video.chunks.length}`);
  }
  return bitmaps;
}
