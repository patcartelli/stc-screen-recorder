import { render } from "@transform/render";
import { tickTimeNs, frameIndexAt } from "@transform/time";
import { loadSession } from "@transform/session";
import { ForwardFrameSource } from "@transform/frame-source";
import { composite } from "@transform/compositor";
import type { Project } from "@transform/types";
import { Muxer, ArrayBufferTarget } from "mp4-muxer";

/**
 * Export sink for a REAL recorded session. Behind the transform, not beside it:
 * every output frame is `render(project, session, t)` composited by the shared
 * compositor — the same two functions the preview sink calls. A sink that
 * reimplemented either would defeat the whole point of the contract.
 */

export interface ExportResult {
  frames: number;
  hash: string;
  encodedBytes: number;
  /** base64 of the encoded MP4, when the caller asked to keep it */
  encodedBase64?: string;
  peakBufferedFrames: number;
  decodedFrames: number;
  durationMs: number;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function exportSession(
  dir: string,
  project: Project,
  opts: { maxFrames?: number; encode?: boolean; returnFile?: boolean } = {},
): Promise<ExportResult> {
  const t0 = performance.now();
  const [anchors, events, displayMp4] = await Promise.all([
    fetch(`${dir}/anchors.json`).then((r) => r.json()),
    fetch(`${dir}/events.json`).then((r) => r.json()),
    fetch(`${dir}/display.mp4`).then((r) => r.arrayBuffer()),
  ]);

  const session = await loadSession({ anchors, events, displayMp4 });
  const source = new ForwardFrameSource(session.video);

  const { width, height, fps } = project.output;
  const ctx = new OffscreenCanvas(width, height)
    .getContext("2d", { alpha: false, willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;

  // CFR at export: the output grid is uniform, sampling every other 120 Hz sim
  // tick for 60 fps. The SOURCE grid stays variable — frame selection picks the
  // greatest PTS <= t and holds, never interpolating.
  const lastFrameNs = session.frames[session.frames.length - 1]!;
  const total = Math.min(
    opts.maxFrames ?? Number.MAX_SAFE_INTEGER,
    Math.floor((lastFrameNs * fps) / 1_000_000_000) + 1,
  );

  const encode = opts.encode ?? true;
  let muxer: Muxer<ArrayBufferTarget> | undefined;
  let encoder: VideoEncoder | undefined;
  // Thrown from the error callback, a codec failure only surfaces later as
  // "cannot encode on a closed codec" — which hides the real cause. Keep it.
  let encoderError: Error | null = null;
  if (encode) {
    const target = new ArrayBufferTarget();
    muxer = new Muxer({ target, video: { codec: "avc", width, height }, fastStart: "in-memory" });
    encoder = new VideoEncoder({
      output: (chunk, meta) => muxer!.addVideoChunk(chunk, meta),
      error: (e) => { encoderError = e instanceof Error ? e : new Error(String(e)); },
    });
    // High @ L5.2 (PHASE-0 §8). NOT L4.0 (…0028): its 2 Mpixel coded-area cap
    // rejects 4K outright, and the capture ceiling is 3840x2160.
    encoder.configure({ codec: "avc1.640034", width, height, framerate: fps, bitrate: 12_000_000 });
  }

  // One rolling hash over every pre-encode buffer: the gate compares this, not
  // the encoded file. Container timestamps and encoder state are not
  // contractually deterministic; the RGBA that goes IN is.
  const rolling = new Uint8Array(32);
  let peakBuffered = 0;

  for (let k = 0; k < total; k++) {
    const tNs = tickTimeNs(2 * k);
    const fs = render(project, session, tNs);
    const idx = frameIndexAt(session.frames, tNs);
    const frame = idx === null ? null : await source.frameAt(idx);
    peakBuffered = Math.max(peakBuffered, source.bufferedCount);

    composite(ctx, frame as unknown as ImageBitmap | null, fs, width, height);
    const rgba = ctx.getImageData(0, 0, width, height).data;

    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", rgba as unknown as BufferSource));
    for (let i = 0; i < 32; i++) rolling[i]! ^= h[i]! + ((k * 31 + i) & 0xff);

    if (encoder) {
      if (encoderError) throw encoderError;
      const vf = new VideoFrame(ctx.canvas, { timestamp: Math.round(tNs / 1000) });
      encoder.encode(vf, { keyFrame: k % fps === 0 });
      vf.close();
      // Never let the encoder queue grow without bound on a long export.
      while (encoder.encodeQueueSize > 30) await new Promise((r) => setTimeout(r, 1));
    }
  }

  let encodedBytes = 0;
  let encodedBase64: string | undefined;
  if (encoderError) throw encoderError;
  if (encoder && muxer) {
    await encoder.flush();
    muxer.finalize();
    encoder.close();
    const out = (muxer.target as ArrayBufferTarget).buffer;
    encodedBytes = out.byteLength;
    if (opts.returnFile) {
      // Chunked: String.fromCharCode(...bytes) blows the argument limit well
      // below the size of any real export.
      const bytes = new Uint8Array(out);
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      encodedBase64 = btoa(bin);
    }
  }
  const decodedFrames = source.decodedCount;
  source.close();

  return {
    frames: total,
    hash: await sha256Hex(rolling),
    encodedBytes,
    encodedBase64,
    peakBufferedFrames: peakBuffered,
    decodedFrames,
    durationMs: Math.round(performance.now() - t0),
  };
}

(window as any).exportSession = exportSession;
(window as any).__exportReady = true;
