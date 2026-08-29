import { demuxTrack } from "@transform/demux";

/**
 * Per-frame mean luminance of a track, with its session-relative PTS.
 *
 * The camera-to-display sync measurement needs ONE physical event visible in
 * both tracks. A screen flash is that event: the display track records it
 * directly, and the camera — facing the user — sees the room and the face
 * change brightness. Both tracks carry session-relative ns from the same mach
 * clock, so the difference between when each SEES the flash is the camera's
 * latency, with no shared reference needed beyond the clock the helper already
 * guarantees.
 *
 * Luma is read off a tiny canvas (64x36). Full-resolution pixels would be
 * exact and pointless: a flash is a whole-frame step, and downsampling costs
 * nothing while keeping a 4K decode affordable.
 */
async function seriesFor(url: string, maxFrames: number): Promise<{ ptsNs: number; luma: number }[]> {
  const buf = await fetch(url).then((r) => r.arrayBuffer());
  const v = await demuxTrack(buf, url);
  const cv = new OffscreenCanvas(64, 36);
  const ctx = cv.getContext("2d", { alpha: false, willReadFrequently: true })!;
  const out: { ptsNs: number; luma: number }[] = [];

  let i = 0;
  const dec = new VideoDecoder({
    output: (frame) => {
      // Closed in the output callback, never buffered — a 4K frame is ~30 MB
      // and this decodes a whole take.
      try {
        if (i < v.framesNs.length && out.length < maxFrames) {
          ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0, 64, 36);
          const d = ctx.getImageData(0, 0, 64, 36).data;
          let sum = 0;
          for (let p = 0; p < d.length; p += 4) {
            sum += 0.2126 * d[p]! + 0.7152 * d[p + 1]! + 0.0722 * d[p + 2]!;
          }
          out.push({ ptsNs: v.framesNs[i]!, luma: sum / (64 * 36) });
        }
      } finally { frame.close(); i++; }
    },
    error: (e) => { throw e; },
  });
  dec.configure({ codec: v.codec, codedWidth: v.codedWidth, codedHeight: v.codedHeight,
                  description: v.description });

  for (const c of v.chunks) {
    dec.decode(new EncodedVideoChunk({ type: c.type, timestamp: c.timestampUs, data: c.data as BufferSource }));
    // Bounded queue: feeding a whole take at once makes the decoder hold every
    // chunk, and on a large track that is where memory goes.
    while (dec.decodeQueueSize > 16) await new Promise((r) => setTimeout(r, 1));
  }
  await dec.flush();
  dec.close();
  return out;
}

(window as any).lumaSeries = async (url: string, maxFrames = 5000) => {
  try { return { series: await seriesFor(url, maxFrames) }; }
  catch (e: any) { return { fatal: String(e?.stack ?? e) }; }
};
(window as any).__lumaReady = true;
