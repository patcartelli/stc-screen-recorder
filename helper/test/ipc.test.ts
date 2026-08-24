import { describe, test, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

const root = join(__dirname, "..", "..");
const BIN = join(root, "helper", "build", "stc-helper");

// helper binary is built once by vitest.global-setup.ts

interface Line { ev: string; seq?: number; [k: string]: unknown }

interface Helper {
  proc: ChildProcess;
  out: Line[];   // stdout — lossy channel
  fd3: Line[];   // fd3 — reliable channel
  send(cmd: object): void;
  drainStdout(): void;
  kill(): void;
}

function collect(stream: Readable, sink: Line[]): void {
  let buf = "";
  // resume() is required, not decorative: on a child's stdio pipe that was
  // explicitly paused, attaching a "data" listener alone does NOT re-enable
  // reading, and the stream silently delivers nothing forever.
  stream.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) { try { sink.push(JSON.parse(line)); } catch { /* not JSON */ } }
    }
  });
  stream.resume();
}

const live: ChildProcess[] = [];

function spawnHelper(opts: { fd3?: boolean; drainStdout?: boolean; statsIntervalMs?: number } = {}): Helper {
  const withFd3 = opts.fd3 ?? true;
  const drain = opts.drainStdout ?? true;
  const stdio: any[] = ["pipe", "pipe", "pipe"];
  if (withFd3) stdio.push("pipe");
  const argv = opts.statsIntervalMs ? ["--stats-interval-ms", String(opts.statsIntervalMs)] : [];
  const proc = spawn(BIN, argv, { stdio });
  live.push(proc);
  const out: Line[] = [];
  const fd3: Line[] = [];
  if (drain) collect(proc.stdout!, out);
  else proc.stdout!.pause();          // simulate a stalled consumer: OS pipe fills
  proc.stderr!.resume();               // never let stderr back up
  if (withFd3) collect(proc.stdio[3] as Readable, fd3);
  return {
    proc, out, fd3,
    send: (cmd) => proc.stdin!.write(JSON.stringify(cmd) + "\n"),
    drainStdout: () => collect(proc.stdout!, out),
    kill: () => proc.kill("SIGKILL"),
  };
}

afterEach(() => { for (const p of live.splice(0)) p.kill("SIGKILL"); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | undefined | false, ms = 5000, what = "condition"): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(10);
  }
}

const find = (ls: Line[], ev: string) => ls.find((l) => l.ev === ev);
const tmpSession = () => mkdtempSync(join(tmpdir(), "stc-ipc-"));

describe("reliable channel — fd3, request/response with sequence numbers", () => {
  test("ready is a reliable lifecycle event on fd3, not lossy stdout", async () => {
    const h = spawnHelper();
    const ready = await waitFor(() => find(h.fd3, "ready"), 5000, "ready");
    expect(ready.protocol).toBe(1);
    expect(find(h.out, "ready")).toBeUndefined();
  });

  test("a command's response echoes its seq on fd3", async () => {
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    h.send({ cmd: "status", seq: 7 });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 7), 5000, "seq 7");
    expect(r.ev).toBe("status");
    expect(r.state).toBe("idle");
  });

  test("concurrent commands each get their own seq back, none on stdout", async () => {
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    for (const seq of [1, 2, 3]) h.send({ cmd: "status", seq });
    await waitFor(() => h.fd3.filter((l) => l.ev === "status").length === 3, 5000, "3 status");
    expect(h.fd3.filter((l) => l.ev === "status").map((l) => l.seq)).toEqual([1, 2, 3]);
    expect(h.out.some((l) => l.ev === "status")).toBe(false);
  });

  test("errors are reliable and carry the offending command's seq", async () => {
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    h.send({ cmd: "nonsense", seq: 42 });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 42), 5000, "seq 42");
    expect(r.ev).toBe("error");
    expect(r.code).toBe("unknown-command");
  });

  test("malformed JSON produces a reliable error without wedging the stream", async () => {
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    h.proc.stdin!.write("{not json\n");
    await waitFor(() => h.fd3.find((l) => l.ev === "error" && l.code === "bad-json"), 5000, "bad-json");
    h.send({ cmd: "status", seq: 5 });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 5), 5000, "seq 5 after bad json");
    expect(r.ev).toBe("status");
  });

  test("start's outcome is always reliable and correlated, granted or not", async () => {
    // Deliberately agnostic about whether capture can start here: without a
    // Screen Recording grant `start` answers "error", with one it answers
    // "started". Either way the answer must be on fd3, carry the seq, and
    // never appear on the lossy channel. Capture success is covered by
    // capture.test.ts, which requires the grant.
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    h.send({ cmd: "start", dir: tmpSession(), seq: 10 });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 10), 15_000, "start outcome");
    expect(["started", "error"]).toContain(r.ev);
    expect(h.out.some((l) => l.seq === 10)).toBe(false);
  }, 25_000);
});

describe("lossy channel — stdout stats never back-pressure the capture graph", () => {
  test("stats go to stdout, never to fd3", async () => {
    const h = spawnHelper({ statsIntervalMs: 5 });
    await waitFor(() => find(h.fd3, "ready"));
    await waitFor(() => find(h.out, "stats"), 5000, "stats on stdout");
    expect(find(h.fd3, "stats")).toBeUndefined();
  });

  test("a stalled stdout consumer does not stall the control plane", async () => {
    const h = spawnHelper({ drainStdout: false, statsIntervalMs: 1 });
    await waitFor(() => find(h.fd3, "ready"));
    // hammer the undrained pipe until the OS buffer is full and the ring overflows
    await sleep(2500);
    h.send({ cmd: "status", seq: 99 });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 99), 5000, "status while stdout blocked");
    expect(r.ev).toBe("status");
  }, 20_000);

  test("stalled consumer: drops are reported, and backlog is bounded by capacity not stall length", async () => {
    // One experiment, two conclusions. Measured capacity is ~2615 idle stat
    // lines (pipe ~122 KB at 48 B/line, plus the 256-entry ring), so a stall
    // must exceed ~3 s to overflow at all — that number is the kernel's, not
    // ours, which is why the bound below is relative rather than absolute:
    // doubling the stall must NOT double what survives.
    const measure = async (stallMs: number) => {
      const h = spawnHelper({ drainStdout: false, statsIntervalMs: 1 });
      await waitFor(() => find(h.fd3, "ready"));
      await sleep(stallMs);
      h.drainStdout();
      const note = await waitFor(() => find(h.out, "stats-dropped"), 15_000, `drop notice after ${stallMs}ms`);
      await sleep(400);
      const survived = h.out.filter((l) => l.ev === "stats").length;
      h.kill();
      return { dropped: note.n as number, survived };
    };

    const short = await measure(4000);
    const long = await measure(8000);

    expect(short.dropped).toBeGreaterThan(0);
    expect(long.dropped).toBeGreaterThan(short.dropped);   // 2x the stall, more lost...
    expect(long.survived).toBeLessThan(short.survived * 1.5 + 300); // ...same bounded backlog
  }, 60_000);
});

describe("no fd3 — a bare terminal run still works", () => {
  test("responses fall back to stdout so the documented smoke test holds", async () => {
    const h = spawnHelper({ fd3: false });
    const ready = await waitFor(() => find(h.out, "ready"), 5000, "ready on stdout");
    expect(ready.protocol).toBe(1);
    h.send({ cmd: "status", seq: 3 });
    const r = await waitFor(() => h.out.find((l) => l.seq === 3), 5000, "status on stdout");
    expect(r.ev).toBe("status");
  });
});
