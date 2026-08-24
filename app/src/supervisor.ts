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

  async stopRecording(): Promise<HelperLine> {
    if (!this.client) throw new Error("helper is not running");
    const r = await this.client.request("stop");
    this.recordingDir = undefined;
    this.state = "idle";
    return r;
  }

  /** Deliberate teardown. Must not look like a crash. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const c = this.client;
    if (!c) { this.state = "stopped"; return; }
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

    c.on("*", (line) => this.emit(`helper:${line.ev}`, line));
    c.on("stats", (line) => this.emit("stats", line));

    c.waitForExit().then((info) => {
      if (this.shuttingDown) return;

      // A recording in flight when the helper died is lost — the sidecars are
      // written on stop, which never happened. Say so loudly.
      if (this.recordingDir) {
        this.emit("recording-lost", { dir: this.recordingDir, ...info });
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
        this.emit("gave-up", { restarts: this.restarts.length, ...info });
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
