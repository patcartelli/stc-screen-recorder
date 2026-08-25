import { render } from "./render.js";
import { tickTimeNs, frameIndexAt } from "./time.js";
import { ForwardFrameSource } from "./frame-source.js";
import { composite } from "./compositor.js";
import type { LoadedSession } from "./session.js";
import type { Project } from "./types.js";
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { withTimeout } from "./timeout.js";

/**
 * The export sink. ONE implementation, called by both the CLI gates and the
 * app — if the UI had its own copy, the gate comparing them would be comparing
 * two programs rather than verifying one.
 *
 * A sink behind the transform: every output frame is render() composited by the
 * shared compositor, the same two functions preview calls.
 */

export interface ExportOptions {
  fromFrame?: number;
  maxFrames?: number;
  /** Pre-encode hashing. Gate-only: it costs a full pixel read-back per frame. */
  hash?: boolean;
  /** Forces software rasterisation. Both backends are byte-identical; software is slower. */
  softwareRaster?: boolean;
  encode?: boolean;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

export interface ExportResult {
  frames: number;
  hash: string;
  encodedBytes: number;
  encoded?: Uint8Array;
  peakBufferedFrames: number;
  decodedFrames: number;
  durationMs: number;
  cancelled: boolean;
}

export class ExportCancelled extends Error {
  constructor() { super("export cancelled"); this.name = "ExportCancelled"; }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function exportSession(
  session: LoadedSession, project: Project, opts: ExportOptions = {},
): Promise<ExportResult> {
  const t0 = performance.now();
  const source = new ForwardFrameSource(session.video);
  const { width, height, fps } = project.output;
  const wantHash = opts.hash ?? false;

  const ctx = new OffscreenCanvas(width, height).getContext("2d", {
    alpha: false,
    willReadFrequently: opts.softwareRaster ?? wantHash,
  }) as OffscreenCanvasRenderingContext2D;

  const lastFrameNs = session.frames[session.frames.length - 1]!;
  const available = Math.floor((lastFrameNs * fps) / 1_000_000_000) + 1;
  const from = Math.max(0, Math.min(opts.fromFrame ?? 0, available - 1));
  const total = Math.min(opts.maxFrames ?? Number.MAX_SAFE_INTEGER, available - from);
  // An exported clip is its own file and its timeline starts at zero. render()
  // still receives SESSION time — cursor state depends on where we are in the
  // recording, not where this clip begins.
  const originNs = tickTimeNs(2 * from);

  const encode = opts.encode ?? true;
  let muxer: Muxer<ArrayBufferTarget> | undefined;
  let encoder: VideoEncoder | undefined;
  let encoderError: Error | null = null;
  if (encode) {
    muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: "avc", width, height }, fastStart: "in-memory" });
    encoder = new VideoEncoder({
      output: (chunk, meta) => muxer!.addVideoChunk(chunk, meta),
      error: (e) => { encoderError = e instanceof Error ? e : new Error(String(e)); },
    });
    // High @ L5.2 (PHASE-0 §8). NOT L4.0: its 2 Mpixel coded-area cap rejects 4K.
    encoder.configure({ codec: "avc1.640034", width, height, framerate: fps, bitrate: 12_000_000 });
  }

  const rolling = new Uint8Array(32);
  let peakBuffered = 0;
  let cancelled = false;

  try {
    for (let k = 0; k < total; k++) {
      if (opts.signal?.aborted) { cancelled = true; break; }
      if (encoderError) throw encoderError;

      const tNs = tickTimeNs(2 * (from + k));
      const fs = render(project, session, tNs);
      const idx = frameIndexAt(session.frames, tNs);
      const frame = idx === null ? null : await source.frameAt(idx);
      peakBuffered = Math.max(peakBuffered, source.bufferedCount);
      composite(ctx, frame as unknown as ImageBitmap | null, fs, width, height);

      if (wantHash) {
        const rgba = ctx.getImageData(0, 0, width, height).data;
        const h = new Uint8Array(await crypto.subtle.digest("SHA-256", rgba as unknown as BufferSource));
        for (let i = 0; i < 32; i++) rolling[i]! ^= h[i]! + ((k * 31 + i) & 0xff);
      }

      if (encoder) {
        const vf = new VideoFrame(ctx.canvas, { timestamp: Math.round((tNs - originNs) / 1000) });
        encoder.encode(vf, { keyFrame: k % fps === 0 });
        vf.close();
        // Bounded. An encoder that stops draining — no hardware encoder on the
        // machine, a codec it cannot actually service — would otherwise spin
        // here forever. Observed on a CI runner: 21 of 300 frames, then ten
        // minutes of nothing. Fail with a reason instead.
        const queueDeadline = performance.now() + 30_000;
        while (encoder.encodeQueueSize > 30) {
          if (opts.signal?.aborted) break;
          if (performance.now() > queueDeadline) {
            throw new Error(
              `encoder stopped draining at frame ${k} of ${total} ` +
              `(queue stuck at ${encoder.encodeQueueSize}) — no usable H.264 encoder?`,
            );
          }
          await new Promise((r) => setTimeout(r, 1));
        }
      }
      // Yield periodically so a cancel click and the progress bar are not
      // starved by a loop that can run for minutes.
      if (k % 10 === 0) {
        opts.onProgress?.(k + 1, total);
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    let encodedBytes = 0;
    let encoded: Uint8Array | undefined;
    if (encoderError) throw encoderError;
    if (encoder && muxer && !cancelled) {
      // The per-frame back-pressure loop is bounded; this final flush was not.
      // An encoder that accepts every frame and then never finishes would hang
      // the export at 100% with the file unwritten — the worst moment to hang.
      await withTimeout(encoder.flush(), 120_000, "encoder flush at end of export");
      muxer.finalize();
      const buf = (muxer.target as ArrayBufferTarget).buffer;
      encodedBytes = buf.byteLength;
      encoded = new Uint8Array(buf);
    }
    if (encoder && encoder.state !== "closed") encoder.close();
    opts.onProgress?.(total, total);

    return {
      frames: cancelled ? 0 : total,
      hash: wantHash && !cancelled ? await sha256Hex(rolling) : "",
      encodedBytes, encoded,
      peakBufferedFrames: peakBuffered,
      decodedFrames: source.decodedCount,
      durationMs: Math.round(performance.now() - t0),
      cancelled,
    };
  } finally {
    source.close();
    if (encoder && encoder.state !== "closed") encoder.close();
  }
}
