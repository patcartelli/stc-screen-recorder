import { render } from "./render.js";
import { tickTimeNs, tickOf, frameIndexAt, SIM_HZ } from "./time.js";
import { SeekingFrameSource } from "./seeking-frame-source.js";
import { composite } from "./compositor.js";
import type { LoadedSession } from "./session.js";
import type { Project } from "./types.js";

/**
 * The preview sink. A sink, not a renderer: every frame is render() composited
 * by the shared compositor, exactly as export does. The only difference is
 * where frames come from — seeking rather than forward-only.
 */
export class PreviewPlayer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly source: SeekingFrameSource;
  private raf = 0;
  private playing = false;
  private tNs = 0;
  private playAnchorWallMs = 0;
  private playAnchorTNs = 0;
  private rendering = false;
  private closed = false;
  private lateFrames = 0;
  private renderedFrames = 0;

  onTime: ((tNs: number, playing: boolean) => void) | undefined;

  constructor(canvas: HTMLCanvasElement,
              private readonly session: LoadedSession,
              private readonly project: Project) {
    canvas.width = project.output.width;
    canvas.height = project.output.height;
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.source = new SeekingFrameSource(session.video);
  }

  get durationNs(): number {
    return this.session.frames[this.session.frames.length - 1] ?? 0;
  }

  /**
   * The earliest time that actually shows a frame.
   *
   * Not the first frame's PTS: seek() floors time to a 120 Hz tick, and the
   * floor of a first frame at 209.1 ms is 208.33 ms — before the frame exists,
   * so frame selection correctly reports "nothing yet" and paints black. Round
   * UP to the first tick that lands at or after it.
   */
  get firstRenderableNs(): number {
    const first = this.session.frames[0] ?? 0;
    return tickTimeNs(Math.ceil((first * SIM_HZ) / 1_000_000_000));
  }
  get currentNs(): number { return this.tNs; }
  get isPlaying(): boolean { return this.playing; }
  /** Frames the clock ran past before they could be drawn. */
  get stats() { return { lateFrames: this.lateFrames, renderedFrames: this.renderedFrames }; }

  async seek(tNs: number): Promise<void> {
    this.tNs = Math.max(0, Math.min(tNs, this.durationNs));
    if (this.playing) {
      this.playAnchorWallMs = performance.now();
      this.playAnchorTNs = this.tNs;
    }
    await this.draw();
    this.onTime?.(this.tNs, this.playing);
  }

  play(): void {
    if (this.playing || this.closed) return;
    if (this.tNs >= this.durationNs) this.tNs = 0;
    this.playing = true;
    this.playAnchorWallMs = performance.now();
    this.playAnchorTNs = this.tNs;
    const tick = () => {
      if (!this.playing || this.closed) return;
      // Time comes from the WALL CLOCK, not from a frame counter. If decoding
      // cannot keep up, playback drops frames and stays time-accurate rather
      // than sliding into slow motion — a preview that drifts from real time is
      // lying about the recording it is previewing.
      const elapsedNs = (performance.now() - this.playAnchorWallMs) * 1e6;
      this.tNs = this.playAnchorTNs + elapsedNs;
      if (this.tNs >= this.durationNs) {
        this.tNs = this.durationNs;
        this.pause();
        void this.draw();
        this.onTime?.(this.tNs, false);
        return;
      }
      void this.draw();
      this.onTime?.(this.tNs, true);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause(): void {
    this.playing = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** One in flight at a time; a request arriving mid-draw is simply dropped. */
  private async draw(): Promise<void> {
    if (this.rendering || this.closed) { this.lateFrames++; return; }
    this.rendering = true;
    try {
      const tick = tickOf(this.tNs);
      const t = tickTimeNs(tick);
      const fs = render(this.project, this.session, t);
      const idx = frameIndexAt(this.session.frames, t);
      const frame = idx === null ? null : await this.source.frameAt(idx);
      if (this.closed) return;
      composite(this.ctx as unknown as OffscreenCanvasRenderingContext2D,
                frame as unknown as ImageBitmap | null, fs,
                this.project.output.width, this.project.output.height);
      this.renderedFrames++;
    } finally {
      this.rendering = false;
    }
  }

  close(): void {
    this.closed = true;
    this.pause();
    this.source.close();
  }
}
