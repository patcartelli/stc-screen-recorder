import { demuxTrack } from "@transform/demux";
import { SeekingFrameSource } from "@transform/seeking-frame-source";

/**
 * Seek gate driver. Every returned frame is PIXEL-PROBED for the 12-bit index
 * block row that fixtures/gen-display.swift draws into each frame, so a seek
 * proves it returned the frame that was asked for — not merely a plausible one.
 * Without that, a source that returned a neighbouring frame would pass.
 */

/** Mirrors gen-display.swift: 12 blocks, 16px, at x = 8 + bit*20, top row. */
function readFrameIndex(ctx: OffscreenCanvasRenderingContext2D): number {
  let value = 0;
  for (let bit = 0; bit < 12; bit++) {
    const px = ctx.getImageData(16 + bit * 20, 16, 1, 1).data;
    if (px[0]! > 128) value |= 1 << (11 - bit);
  }
  return value;
}

(window as any).runSeekGate = async (mp4Url: string) => {
  try {
    return await gateBody(mp4Url);
  } catch (e: any) {
    // Report rather than reject: a rejection from inside the page surfaces as
    // "resulting promise was garbage collected", which says nothing at all.
    return { fatal: String(e?.stack ?? e) };
  }
};

const gateBody = async (mp4Url: string) => {
  const buf = await fetch(mp4Url).then((r) => r.arrayBuffer());
  const video = await demuxTrack(buf, mp4Url);
  const source = new SeekingFrameSource(video);
  const n = video.chunks.length;
  const ctx = new OffscreenCanvas(video.codedWidth, video.codedHeight)
    .getContext("2d", { alpha: false, willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;

  // Prove the very first seek completes before running a hundred more.
  const first = await Promise.race([
    source.frameAt(0).then(() => "ok"),
    new Promise((r) => setTimeout(() => r("STUCK"), 8000)),
  ]);
  if (first === "STUCK") return { stuckOnFirstSeek: true, debug: source.debug };

  const failures: string[] = [];
  const check = async (want: number, label: string, expect = want) => {
    console.log(`SEEKGATE probe ${label} -> ${want}`);
    const frame = await source.frameAt(want);
    if (!frame) { failures.push(`${label}: seek(${want}) returned null`); return; }
    ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0);
    const got = readFrameIndex(ctx);
    if (got !== expect) failures.push(`${label}: seek(${want}) gave frame ${got}, wanted ${expect}`);
  };

  // forward, backward, repeated, boundaries, and a long random walk
  for (const i of [0, 1, 2, 5, 10, 44, 45, 46, 89]) await check(i, "forward");
  for (const i of [89, 60, 46, 45, 44, 10, 3, 0]) await check(i, "backward");
  for (const i of [30, 30, 30]) await check(i, "repeated");
  await check(-5, "below range", 0);
  await check(n + 100, "above range", n - 1);
  for (const i of [0, 89, 1, 88, 2, 87, 44, 45]) await check(i, "alternating ends");

  let seed = 0x5eed;
  for (let k = 0; k < 60; k++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    await check(seed % n, "random walk");
  }

  // A scrub: many requests without awaiting, only the last must be honoured.
  const inFlight: Promise<VideoFrame | null>[] = [];
  for (let i = 0; i < 40; i++) inFlight.push(source.frameAt(i * 2));
  const settled = await Promise.all(inFlight);
  const last = settled[settled.length - 1];
  let scrubIndex = -1;
  if (last) { ctx.drawImage(last as unknown as CanvasImageSource, 0, 0); scrubIndex = readFrameIndex(ctx); }
  const superseded = settled.slice(0, -1).filter((f) => f === null).length;

  const stats = source.stats;
  source.close();
  const after = source.stats;

  return {
    frames: n,
    failures,
    scrubLastIndex: scrubIndex,
    scrubExpected: 78,
    scrubSuperseded: superseded,
    peakBuffered: stats.peakBuffered,
    decoderGenerations: stats.decoderGenerations,
    liveFramesAfterClose: after.liveFrames,
  };
};
(window as any).__seekReady = true;
