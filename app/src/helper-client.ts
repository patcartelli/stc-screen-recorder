import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

/**
 * Client for the Swift helper's two-channel protocol.
 *
 *   fd3    reliable  — responses (seq-correlated) and lifecycle events
 *   stdout lossy     — stats only; may be dropped under back-pressure and
 *                      arrive with `stats-dropped` notices in between
 *
 * The split is the point: nothing this client does on the stats path can ever
 * back-pressure the helper's capture graph, and nothing on the stats path can
 * satisfy a pending request.
 */

/**
 * How long a request waits for its answer before the client gives up.
 *
 * Named rather than left a literal because it is the OUTERMOST link in the stop
 * chain: the helper's own teardown backstops (CaptureSession.stopTimeoutSeconds
 * and CameraCapture.stopTimeoutSeconds) must both answer inside it, or the app
 * is left holding a recording it cannot end — which is exactly what a CI runner
 * reported as `request "stop" (seq 2) timed out after 30000ms`.
 * `helper/test/stop-bounds.test.ts` asserts the chain.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface HelperLine {
  ev: string;
  seq?: number;
  t?: number;
  [k: string]: unknown;
}

export class HelperError extends Error {
  constructor(readonly code: string, readonly detail: string) {
    super(`${code}: ${detail}`);
    this.name = "HelperError";
  }
}

type Handler = (line: HelperLine) => void;

interface Pending {
  resolve(line: HelperLine): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

export interface SpawnOptions {
  statsIntervalMs?: number;
  /** default per-request timeout; `start` can legitimately take seconds */
  defaultTimeoutMs?: number;
}

export class HelperClient {
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly defaultTimeoutMs: number;
  /** Bounded: a chatty helper must not grow this without limit. */
  private static readonly STDERR_KEEP = 16 * 1024;
  private seq = 0;
  private exitInfo: { code: number | null; signal: string | null } | undefined;
  private readonly exitWaiters: ((v: { code: number | null; signal: string | null }) => void)[] = [];
  private readyLine: HelperLine | undefined;
  private stderrTail = "";
  private readyWaiters: ((l: HelperLine) => void)[] = [];

  private constructor(private readonly proc: ChildProcess, opts: SpawnOptions) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    // fd3 = reliable. Responses and lifecycle both arrive here; a line with a
    // seq answers a request, a line without one is an unsolicited event.
    this.readLines(proc.stdio[3] as Readable, (line) => {
      if (line.ev === "ready") {
        this.readyLine = line;
        this.readyWaiters.splice(0).forEach((w) => w(line));
      }
      const seq = line.seq;
      if (typeof seq === "number" && this.pending.has(seq)) {
        const p = this.pending.get(seq)!;
        this.pending.delete(seq);
        clearTimeout(p.timer);
        if (line.ev === "error") {
          p.reject(new HelperError(String(line.code ?? "unknown"), String(line.detail ?? "")));
        } else {
          p.resolve(line);
        }
        return;
      }
      this.emit(line);
    });

    // stdout = lossy stats. Deliberately cannot resolve a pending request:
    // a dropped stat must never look like a lost response.
    this.readLines(proc.stdout!, (line) => this.emit(line));

    // Keep the helper's last words. Three crashes on CI produced only a signal
    // number — SIGTRAP, then a hung stop, then SIGSEGV — with no stack and no
    // message, because stderr was drained and discarded here. A dying child
    // process's stderr is usually the only thing that explains it (STC-254).
    proc.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-HelperClient.STDERR_KEEP);
    });
    proc.stderr?.resume();

    proc.on("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      const err = new Error(
        `helper exited (code ${code}, signal ${signal})` +
        (this.stderrTail.trim() ? `\nhelper stderr:\n${this.stderrTail.trim()}` : ""),
      );
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
      this.pending.clear();
      this.exitWaiters.splice(0).forEach((w) => w(this.exitInfo!));
    });
  }

  static spawn(binPath: string, opts: SpawnOptions = {}): HelperClient {
    const argv = opts.statsIntervalMs ? ["--stats-interval-ms", String(opts.statsIntervalMs)] : [];
    const proc = spawn(binPath, argv, { stdio: ["pipe", "pipe", "pipe", "pipe"] });
    return new HelperClient(proc, opts);
  }

  /** The helper's most recent stderr, kept for when it dies without explaining itself. */
  get recentStderr(): string { return this.stderrTail; }

  /** Resolves with the helper's `ready` line (immediately if already seen). */
  ready(timeoutMs = 10_000): Promise<HelperLine> {
    if (this.readyLine) return Promise.resolve(this.readyLine);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("helper never reported ready")), timeoutMs);
      this.readyWaiters.push((l) => { clearTimeout(timer); resolve(l); });
    });
  }

  request(cmd: string, params: Record<string, unknown> = {},
          opts: { timeoutMs?: number } = {}): Promise<HelperLine> {
    if (this.exitInfo) {
      return Promise.reject(new Error(
        `helper already exited (code ${this.exitInfo.code}, signal ${this.exitInfo.signal})` +
        (this.stderrTail.trim() ? `\nhelper stderr:\n${this.stderrTail.trim()}` : ""),
      ));
    }
    const seq = ++this.seq;
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`request "${cmd}" (seq ${seq}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(seq, { resolve, reject, timer });
      this.proc.stdin!.write(JSON.stringify({ ...params, cmd, seq }) + "\n");
    });
  }

  on(ev: string, handler: Handler): () => void {
    if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
    this.handlers.get(ev)!.add(handler);
    return () => this.handlers.get(ev)?.delete(handler);
  }

  /**
   * Resolves when the helper exits. Deliberately UNBOUNDED: a helper that is
   * running normally should never resolve this, and the supervisor uses it as a
   * long-lived crash signal. Callers that need an answer within a deadline must
   * race it themselves, as `shutdown()` does.
   */
  waitForExit(): Promise<{ code: number | null; signal: string | null }> {
    if (this.exitInfo) return Promise.resolve(this.exitInfo);
    return new Promise((resolve) => this.exitWaiters.push(resolve));
  }

  kill(): void {
    if (!this.exitInfo) this.proc.kill("SIGKILL");
  }

  private emit(line: HelperLine): void {
    for (const h of this.handlers.get(line.ev) ?? []) h(line);
    for (const h of this.handlers.get("*") ?? []) h(line);
  }

  private readLines(stream: Readable, onLine: (l: HelperLine) => void): void {
    let buf = "";
    stream.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!raw) continue;
        try { onLine(JSON.parse(raw) as HelperLine); } catch { /* not our line */ }
      }
    });
    // Explicit: on a child's stdio pipe a "data" listener alone does not
    // re-enable reading if the stream was ever paused, and it silently
    // delivers nothing forever.
    stream.resume();
  }
}
