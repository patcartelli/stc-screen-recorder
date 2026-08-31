import type { DemuxedVideo } from "./demux.js";
import { withTimeout } from "./timeout.js";
import { decoderPreference } from "./decoder-preference.js";

/**
 * Random-access frame source for the preview sink.
 *
 * The opposite access pattern to ForwardFrameSource, and far more dangerous.
 * PHASE-0 §4b was written from a harness that repeatedly killed the tab doing
 * exactly this, and each of its lessons is load-bearing here:
 *
 *  1. ONE in-flight request. A slider drag fires dozens of input events, and
 *     overlapping decodes against one decoder reset it mid-flight and leak 4K
 *     frames until the tab dies. Requests are serialised and superseded ones
 *     resolve null rather than racing.
 *  2. NEVER "reset on overshoot". The original loop submitted a target, saw an
 *     empty output queue, concluded it had overshot, reset, and repeated — an
 *     infinite loop allocating a fresh VideoDecoder every spin. This decodes
 *     forward from the governing keyframe with a strictly advancing counter and
 *     resets only when the target is genuinely unreachable by going forward.
 *  3. Close frames in the output callback path, retaining at most one. At 4K a
 *     frame is ~30 MB, so even a short backlog is hundreds of megabytes.
 */
export class SeekingFrameSource {
  private decoder: VideoDecoder | null = null;
  private readonly pending: VideoFrame[] = [];
  private current: VideoFrame | null = null;
  private currentIndex = -1;
  private nextFeed = 0;
  private nextOutIndex = 0;
  private wake: (() => void) | null = null;
  private failure: Error | null = null;
  private ticket = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly keyIndices: number[];
  private peakBuffered = 0;
  private decoderGenerations = 0;
  /** A flushed decoder refuses delta chunks until it sees a keyframe again. */
  private needsKeyframe = false;

  private static readonly FEED_AHEAD = 8;

  constructor(private readonly video: DemuxedVideo) {
    this.keyIndices = video.chunks
      .map((c, i) => (c.type === "key" ? i : -1))
      .filter((i) => i >= 0);
    if (this.keyIndices.length === 0) throw new Error("no keyframes: cannot seek");
  }

  /**
   * The decoded frame for `index`, requested in any order. Resolves null when a
   * newer request superseded this one — a scrub only cares about the latest.
   * Out-of-range indices clamp, matching "hold, never interpolate".
   */
  frameAt(index: number): Promise<VideoFrame | null> {
    const mine = ++this.ticket;
    const run = this.chain.then(() => {
      if (mine !== this.ticket) return null;          // superseded while queued
      const clamped = Math.max(0, Math.min(index, this.video.chunks.length - 1));
      return this.seek(clamped, mine);
    });
    this.chain = run.catch(() => {});
    return run;
  }

  private governingKey(index: number): number {
    let lo = 0, hi = this.keyIndices.length - 1, best = this.keyIndices[0]!;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.keyIndices[mid]! <= index) { best = this.keyIndices[mid]!; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best;
  }

  private async seek(index: number, mine: number): Promise<VideoFrame | null> {
    if (this.failure) throw this.failure;
    if (index === this.currentIndex && this.current) return this.current;

    const key = this.governingKey(index);
    // Forward from here is only valid if we are already past the governing
    // keyframe and have not gone beyond the target. Anything else restarts at
    // the keyframe — decided from position, never from "the queue looked empty".
    const canContinue = this.decoder !== null && !this.needsKeyframe &&
                        this.currentIndex < index && this.nextOutIndex > key;
    if (!canContinue) this.restartAt(key);

    while (this.currentIndex < index) {
      if (mine !== this.ticket) return null;          // a newer seek wants the decoder
      if (this.failure) throw this.failure;

      if (this.pending.length > 0) {
        const next = this.pending.shift()!;
        this.current?.close();
        this.current = next;
        this.currentIndex = this.nextOutIndex - this.pending.length - 1;
        continue;
      }
      if (!(await this.pump(index))) break;
    }
    return this.current;
  }

  private restartAt(key: number): void {
    this.current?.close();
    this.current = null;
    for (const f of this.pending.splice(0)) f.close();
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.pending.push(frame);
        this.nextOutIndex++;
        this.peakBuffered = Math.max(this.peakBuffered, this.pending.length + (this.current ? 1 : 0));
        this.wake?.();
      },
      error: (e) => { this.failure = e instanceof Error ? e : new Error(String(e)); this.wake?.(); },
    });
    this.decoder.configure({
      codec: this.video.codec,
      codedWidth: this.video.codedWidth,
      codedHeight: this.video.codedHeight,
      description: this.video.description,
      ...decoderPreference(),
      // A scrub wants the frame it asked for NOW, not the throughput a batch
      // decode would prefer. Without this the decoder buffers several frames
      // before its first output, which is the wrong trade for random access.
      optimizeForLatency: true,
    });
    this.decoderGenerations++;
    this.needsKeyframe = false;
    this.nextFeed = key;
    this.nextOutIndex = key;
    this.currentIndex = key - 1;
  }

  private async pump(target: number): Promise<boolean> {
    const d = this.decoder!;
    // Feed up to a bounded distance PAST the target. Bounding by nextFeed and
    // not by nextOutIndex matters: before the first output, nextOutIndex has
    // not moved, so an output-based bound cannot limit anything.
    const feedLimit = target + SeekingFrameSource.FEED_AHEAD;
    while (this.nextFeed < this.video.chunks.length &&
           this.nextFeed <= feedLimit &&
           d.decodeQueueSize < SeekingFrameSource.FEED_AHEAD) {
      const c = this.video.chunks[this.nextFeed++]!;
      d.decode(new EncodedVideoChunk({
        type: c.type, timestamp: c.timestampUs, data: c.data as BufferSource,
      }));
    }
    if (this.pending.length > 0) return true;

    const exhausted = this.nextFeed >= this.video.chunks.length || this.nextFeed > feedLimit;

    // The decoder has swallowed everything and produced nothing. Waiting here
    // deadlocks — no output means no wake-up ever comes. More input is what
    // unblocks it, so loop and feed; only flush once there is nothing left to
    // feed. This is the failure the first gate run caught: queue drained to 0,
    // pending 0, waiting forever with a perfectly healthy decoder.
    if (d.decodeQueueSize === 0) {
      if (!exhausted) return true;
      await withTimeout(d.flush(), 30_000, "decoder flush at end of stream")
        .catch((e) => { this.failure = e instanceof Error ? e : new Error(String(e)); });
      this.needsKeyframe = true;
      return this.pending.length > 0;
    }

    // BOUNDED wait. The queue was full when we checked above and may drain to
    // nothing without emitting, and an unbounded wait then parks forever on a
    // perfectly healthy decoder — exactly what the gate caught. Re-looping
    // re-evaluates: feed more if there is more, flush if there is not.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.wake = null; resolve(); }, 50);
      this.wake = () => { this.wake = null; clearTimeout(timer); resolve(); };
    });
    return true;
  }

  close(): void {
    this.current?.close();
    this.current = null;
    for (const f of this.pending.splice(0)) f.close();
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = null;
  }

  /** Gate instrumentation: what the source is stuck on, if anything. */
  get debug() {
    return {
      decoderState: this.decoder?.state ?? "none",
      decodeQueueSize: this.decoder?.decodeQueueSize ?? -1,
      pending: this.pending.length,
      nextFeed: this.nextFeed,
      nextOutIndex: this.nextOutIndex,
      currentIndex: this.currentIndex,
      needsKeyframe: this.needsKeyframe,
      failure: this.failure ? String(this.failure) : null,
      waiting: this.wake !== null,
    };
  }

  /** Gate instrumentation. */
  get stats() {
    return {
      peakBuffered: this.peakBuffered,
      decoderGenerations: this.decoderGenerations,
      liveFrames: this.pending.length + (this.current ? 1 : 0),
    };
  }
}
