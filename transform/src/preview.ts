import { render } from "./render.js";
import { tickTimeNs, tickOf, SIM_HZ, exportFrameOf } from "./time.js";
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
  private readonly cameraSource: SeekingFrameSource | null;
  private raf = 0;
  private playing = false;
  private tNs = 0;
  private playAnchorWallMs = 0;
  private playAnchorTNs = 0;
  private rendering = false;
  /** A draw asked for while one was in flight; served once that one lands. */
  private redrawWanted = false;
  /** The draw in flight, redraw included, so a coalesced caller can await the paint. */
  private inFlight: Promise<void> | null = null;
  private closed = false;
  private lateFrames = 0;
  private renderedFrames = 0;
  private cameraRenderedFrames = 0;

  onTime: ((tNs: number, playing: boolean) => void) | undefined;

  constructor(private readonly canvas: HTMLCanvasElement,
              private readonly session: LoadedSession,
              private readonly project: Project) {
    canvas.width = project.output.width;
    canvas.height = project.output.height;
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.source = new SeekingFrameSource(session.video);
    // A second SeekingFrameSource, not a shared one. Each serialises its own
    // requests (ticket/chain), so the one-in-flight-per-decoder rule holds by
    // construction — sharing one decoder across two tracks is exactly the
    // accident PHASE-0 §4b warns about.
    this.cameraSource = session.cameraVideo ? new SeekingFrameSource(session.cameraVideo) : null;
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
  get stats() {
    return {
      lateFrames: this.lateFrames,
      renderedFrames: this.renderedFrames,
      cameraRenderedFrames: this.cameraRenderedFrames,
    };
  }

  /**
   * Re-read `project.output` onto the canvas and repaint (STC-335).
   *
   * The canvas is sized once in the constructor, but `composite` reads
   * `project.output` on EVERY draw — so a caller that changes the export size
   * on the project this player was given would otherwise draw at the new size
   * onto a canvas still at the old one, which is a scaled, offset picture
   * rather than an error. This is the one call that keeps the two in step.
   *
   * The preview genuinely rendering at the export's resolution is the point,
   * not a side effect: `#stage` is `width: 100%`, so nothing on screen moves,
   * and what changes is how much detail is actually there — which is the
   * question STC-318 is about and the reason to look before exporting.
   */
  async outputResized(): Promise<void> {
    this.canvas.width = this.project.output.width;
    this.canvas.height = this.project.output.height;
    // Resizing a canvas clears it, so a repaint is required rather than tidy.
    await this.seek(this.tNs);
  }

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

  /**
   * One in flight at a time. A request arriving mid-draw is COALESCED, not
   * dropped: it is served once the in-flight draw lands, at whatever `tNs` is
   * by then — the latest, which is the only one a scrub cares about.
   *
   * Dropping it was wrong for a paused player. A scrub is a burst of input
   * events, the last of which very often lands while the previous draw is
   * still awaiting the decoder; dropped, nothing ever drew that final t, so
   * the canvas showed an earlier frame while the clock — and a mark-in set
   * from `currentNs` — said the later one. During playback the next tick
   * papered over it, which is why it only showed when scrubbing paused.
   */
  private draw(): Promise<void> {
    if (this.closed) return Promise.resolve();
    // A coalesced caller waits for the in-flight draw AND the redraw it
    // queues, so that when seek() resolves the frame for its t has been
    // painted — captureFrame() depends on exactly that.
    if (this.rendering) { this.lateFrames++; this.redrawWanted = true; return this.inFlight!; }
    this.inFlight = this.drawNow();
    return this.inFlight;
  }

  private async drawNow(): Promise<void> {
    this.rendering = true;
    try {
      const tick = tickOf(this.tNs);
      const t = tickTimeNs(tick);
      const fs = render(this.project, this.session, t);
      // render()'s answer, not re-derived here — see export.ts.
      const idx = fs.frameIndex;
      // Both decoders are driven concurrently. They are independent decoders
      // with independent in-flight guards, and `this.rendering` already
      // serialises whole draws — so a superseded seek can never pair a display
      // frame from one t with a camera frame from another.
      const [frame, cameraFrame] = await Promise.all([
        idx === null ? null : this.source.frameAt(idx),
        fs.pip && this.cameraSource ? this.cameraSource.frameAt(fs.pip.frameIndex) : null,
      ]);
      if (this.closed) return;
      composite(this.ctx as unknown as OffscreenCanvasRenderingContext2D,
                frame as unknown as ImageBitmap | null,
                cameraFrame as unknown as ImageBitmap | null, fs,
                this.project.output.width, this.project.output.height);
      this.renderedFrames++;
      if (cameraFrame) this.cameraRenderedFrames++;
    } finally {
      this.rendering = false;
    }
    if (this.redrawWanted && !this.closed) {
      this.redrawWanted = false;
      await this.drawNow();
    }
  }

  /**
   * The composited frame the playhead is on, as PNG bytes — STC-298.
   *
   * Snapped to the export grid: a paused preview can sit on an odd 120 Hz tick
   * that no export visits, and a still taken there would differ from the video
   * export's frame at the same timestamp by half a tick of cursor motion. So
   * this seeks to the output frame containing `currentNs`, waits for it to be
   * painted, and reads the stage back. While playing it pauses for the seek
   * and resumes from that frame; the hiccup is one frame.
   *
   * It is the frame the viewer sees, produced by the same render() and
   * composite() the export uses, on the export's own grid — which is the
   * whole of the identity claim.
   */
  /**
   * The frame under the playhead, as raw RGBA.
   *
   * Pixels rather than an encoded PNG (STC-298, changed by STC-293): the
   * canvas used to `toBlob("image/png")` here, which made this the second
   * encoder in the app. Every still now leaves through one ImageIO path that
   * also has to be able to write HEIC and JPEG and to embed a colour profile,
   * and handing it a PNG would mean this method had already chosen the format.
   *
   * The buffer is `width * height * 4` bytes, unpremultiplied, top row first —
   * what `getImageData` is specified to give and what the helper's encoder
   * expects.
   */
  async captureFrame(): Promise<{
    frame: number; tNs: number; rgba: ArrayBuffer; width: number; height: number;
  }> {
    if (this.closed) throw new Error("preview is closed");
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    const { frame, tNs } = exportFrameOf(this.tNs);
    await this.seek(tNs);
    const { width, height } = this.canvas;
    const data = this.ctx.getImageData(0, 0, width, height).data;
    // Sliced to the exact bytes: a Uint8ClampedArray view may sit inside a
    // larger buffer, and sending the whole one would ship the slack to the
    // main process and fail the encoder's size check on arrival.
    const rgba = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    if (wasPlaying) this.play();
    return { frame, tNs, rgba: rgba as ArrayBuffer, width, height };
  }

  close(): void {
    this.closed = true;
    this.pause();
    this.source.close();
    this.cameraSource?.close();
  }
}
