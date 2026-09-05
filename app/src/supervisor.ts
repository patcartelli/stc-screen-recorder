import { HelperClient, type HelperLine, type SpawnOptions } from "./helper-client.js";

/**
 * Keeps a helper process alive and makes its death legible.
 *
 * The helper holds the capture devices, so its death is never a neutral event:
 * if it dies mid-recording the recording is gone, and the UI must say so rather
 * than quietly returning to an idle-looking state that implies nothing was lost.
 */

export type SupervisorState = "starting" | "idle" | "recording" | "failed" | "stopped";

export interface SupervisorOptions extends SpawnOptions {
  /** restarts tolerated inside `restartWindowMs` before giving up */
  maxRestarts?: number;
  restartWindowMs?: number;
}

type Handler = (payload: any) => void;

export class HelperSupervisor {
  state: SupervisorState = "starting";
  client: HelperClient | undefined;
  pid: number | undefined;

  private readonly handlers = new Map<string, Set<Handler>>();
  private restarts: number[] = [];
  private shuttingDown = false;
  private recordingDir: string | undefined;
  private readyPromise!: Promise<void>;

  private constructor(private readonly bin: string, private readonly opts: SupervisorOptions) {}

  static start(bin: string, opts: SupervisorOptions = {}): HelperSupervisor {
    const s = new HelperSupervisor(bin, opts);
    s.launch();
    return s;
  }

  ready(): Promise<void> { return this.readyPromise; }

  on(ev: string, h: Handler): () => void {
    if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
    this.handlers.get(ev)!.add(h);
    return () => this.handlers.get(ev)?.delete(h);
  }

  async startRecording(dir: string, params: Record<string, unknown> = {}): Promise<HelperLine> {
    if (!this.client) throw new Error("helper is not running");
    const r = await this.client.request("start", { dir, ...params });
    this.recordingDir = dir;
    this.state = "recording";
    return r;
  }

  /**
   * What the helper can record from: displays (with their global origins),
   * cameras and mics. The helper bounds the enumeration itself and answers
   * `stalled: true` if CoreAudio is wedged, so this never hangs the UI.
   */
  async devices(): Promise<HelperLine> {
    if (!this.client) throw new Error("helper is not running");
    return this.client.request("devices");
  }

  async stopRecording(): Promise<HelperLine> {
    if (!this.client) throw new Error("helper is not running");
    const r = await this.client.request("stop");
    this.recordingDir = undefined;
    this.state = "idle";
    return r;
  }

  /**
   * The recording is over without us asking. Distinct from `recording-lost`:
   * there the helper died and the take is gone, here it stopped cleanly and the
   * partial file is valid and playable.
   */
  private endRecording(reason: string, line?: HelperLine): void {
    if (this.state !== "recording") return;
    const dir = this.recordingDir;
    this.recordingDir = undefined;
    this.state = "idle";
    this.emit("recording-ended", { reason, dir, info: line });
  }

  /**
   * Deliberate teardown. Must not look like a crash.
   *
   * A recording in flight is STOPPED first, and waited for. The helper's own
   * `quit` does not wait for its stop to finish — it starts the teardown and
   * exits — and the 2 s grace below is far shorter than the helper's 20 s
   * stop bound, so quitting mid-take used to leave display.mp4 unfinalised
   * (no moov, unplayable) and the sidecars unwritten, with nothing to say so:
   * Cmd-Q during a recording lost the take silently. The request timeout
   * bounds the wait, the same bound every stop already has.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const c = this.client;
    if (!c) { this.state = "stopped"; return; }
    if (this.state === "recording") await this.stopRecording().catch(() => {});
    const exited = c.waitForExit();
    await c.request("quit").catch(() => {});
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
    c.kill();
    this.state = "stopped";
  }

  /** Test seams — a supervisor whose restart path is never exercised is untested. */
  killForTest(): void { this.client?.kill(); }
  markRecordingForTest(dir: string): void { this.recordingDir = dir; this.state = "recording"; }

  private launch(): void {
    const c = HelperClient.spawn(this.bin, this.opts);
    this.client = c;
    this.pid = undefined;
    this.readyPromise = c.ready().then((line) => {
      this.pid = line.pid as number;
      if (this.state !== "recording") this.state = "idle";
      this.emit("ready", line);
    });
    // A helper that dies before `ready` rejects this. Callers who asked
    // (`ready()`) still see the rejection; the death itself is reported
    // through `waitForExit` below. Without a handler here it is an unhandled
    // rejection on every launch nobody awaited — including every respawn.
    this.readyPromise.catch(() => {});

    c.on("*", (line) => this.emit(`helper:${line.ev}`, line));
    c.on("stats", (line) => {
      this.emit("stats", line);
      // The heartbeat carries the helper's own state, which makes it the
      // authority. Reconciling against it heals ANY desync, not just the one
      // we know about — including a `stopped` that never reached us because
      // it raced a respawn.
      if (this.state === "recording" && line.state === "idle") {
        this.endRecording("helper-idle");
      }
    });

    // A stop nobody asked for: the helper decided, typically because the
    // display was reconfigured (AVAssetWriter cannot change output dimensions
    // mid-file, so it stops rather than corrupting the take).
    c.on("stopped", (line) => {
      if (typeof line.seq === "number") return;   // answered a request; already handled
      this.endRecording(String(line.reason ?? "helper-stopped"), line);
    });

    c.waitForExit().then((info) => {
      if (this.shuttingDown) return;

      // A recording in flight when the helper died is lost — the sidecars are
      // written on stop, which never happened. Say so loudly.
      if (this.recordingDir) {
        this.emit("recording-lost", {
          dir: this.recordingDir, ...info,
          // Whatever the helper managed to say on its way out — for a fault
          // signal that is "[helper] FATAL signal SIGSEGV" (STC-254).
          stderr: c.recentStderr.trim() || undefined,
        });
        this.recordingDir = undefined;
      }

      const now = Date.now();
      const windowMs = this.opts.restartWindowMs ?? 10_000;
      this.restarts = this.restarts.filter((t) => now - t < windowMs);
      this.restarts.push(now);

      if (this.restarts.length > (this.opts.maxRestarts ?? 3)) {
        // Respawning forever would turn a reproducible crash into a busy loop
        // that looks like the app merely being slow.
        this.state = "failed";
        // With the helper's last words: a binary that could not be spawned
        // at all says so here ("spawn ENOENT"), and nowhere else.
        this.emit("gave-up", { restarts: this.restarts.length, ...info,
                               stderr: c.recentStderr.trim() || undefined });
        return;
      }

      this.state = "starting";
      this.launch();
      this.emit("respawned", { ...info, restarts: this.restarts.length });
    });
  }

  private emit(ev: string, payload: unknown): void {
    for (const h of this.handlers.get(ev) ?? []) h(payload);
  }
}
