import type { DemuxedVideo } from "./demux.js";

/**
 * Forward-only streaming frame source for export.
 *
 * increment 0's decode-all cache is fine for a 90-frame fixture and impossible
 * for a real one: a 60 s 4K recording is ~3400 frames at ~30 MB decoded, so
 * decoding up front would ask for ~100 GB. Export samples time monotonically,
 * so frames can be streamed and released as they are passed.
 *
 * PHASE-0 §4b, all three lessons, apply here:
 *  - exactly one in-flight decode pipeline, never overlapping requests
 *  - VideoFrames are closed as soon as they are superseded, never buffered
 *  - decode order equals presentation order ONLY because the writer sets
 *    AVVideoAllowFrameReorderingKey=false (verified: cts === dts), which is
 *    what lets the Nth output frame be index N without a PTS sort
 */
export class ForwardFrameSource {
  private decoder: VideoDecoder;
  private readonly pending: VideoFrame[] = [];
  private nextChunk = 0;
  private outputCount = 0;
  private current: VideoFrame | null = null;
  private currentIndex = -1;
  private wake: (() => void) | null = null;
  private failure: Error | null = null;
  private flushed = false;

  /** Chunks kept in flight. Enough to keep the decoder busy, small enough to bound memory. */
  private static readonly QUEUE_TARGET = 8;

  constructor(private readonly video: DemuxedVideo) {
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.pending.push(frame);
        this.outputCount++;
        this.wake?.();
      },
      error: (e) => { this.failure = e instanceof Error ? e : new Error(String(e)); this.wake?.(); },
    });
    this.decoder.configure({
      codec: video.codec,
      codedWidth: video.codedWidth,
      codedHeight: video.codedHeight,
      description: video.description,
    });
  }

  /**
   * The decoded frame for `index`, which must never go backwards. Returns the
   * last frame once the stream is exhausted (hold, never interpolate) and null
   * only if nothing has decoded at all.
   */
  async frameAt(index: number): Promise<VideoFrame | null> {
    if (index < this.currentIndex) {
      throw new Error(`ForwardFrameSource is forward-only: asked for ${index} after ${this.currentIndex}`);
    }
    while (this.currentIndex < index) {
      if (this.failure) throw this.failure;

      if (this.pending.length > 0) {
        const next = this.pending.shift()!;
        this.current?.close();          // superseded — release immediately
        this.current = next;
        this.currentIndex++;
        continue;
      }
      if (!(await this.pump())) break;   // stream exhausted: hold the last frame
    }
    return this.current;
  }

  /** Feeds the decoder and waits for at least one output. False when exhausted. */
  private async pump(): Promise<boolean> {
    while (this.nextChunk < this.video.chunks.length &&
           this.decoder.decodeQueueSize < ForwardFrameSource.QUEUE_TARGET) {
      const c = this.video.chunks[this.nextChunk++]!;
      this.decoder.decode(new EncodedVideoChunk({
        type: c.type, timestamp: c.timestampUs, data: c.data as BufferSource,
      }));
    }

    if (this.pending.length > 0) return true;

    if (this.nextChunk >= this.video.chunks.length && !this.flushed) {
      this.flushed = true;
      await this.decoder.flush();
      return this.pending.length > 0;
    }
    if (this.flushed && this.pending.length === 0) return false;

    // BOUNDED wait, for the same reason SeekingFrameSource needs one: a decoder
    // can swallow everything it was given and emit nothing (it buffers before
    // its first output), and an unbounded wait then parks forever on a perfectly
    // healthy decoder. Re-looping feeds more, which is what actually unblocks it.
    //
    // This never fired at 4K, where frames are large enough that output starts
    // almost immediately. It deadlocks reliably on small frames — found by
    // pointing the export at the 640x360 fixture.
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
    if (this.decoder.state !== "closed") this.decoder.close();
  }

  /** Frames decoded so far — used by the gate to assert memory stays bounded. */
  get decodedCount(): number { return this.outputCount; }
  get bufferedCount(): number { return this.pending.length + (this.current ? 1 : 0); }
}
