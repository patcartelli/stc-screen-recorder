/**
 * End-to-end overflow: stall a real consumer until the OS pipe fills, the ring
 * overflows, and a `stats-dropped` notice is emitted.
 *
 * The ring's SEMANTICS are covered fast and deterministically by
 * helper/test/ring.test.ts. What only this can cover is the WIRING — that
 * the writer thread actually reports a gap rather than swallowing it.
 *
 * It is slow and machine-dependent by nature: how long a stall must last
 * before anything drops is a property of the kernel's pipe buffer. It timed
 * out on CI at 180 s, so it lives in `npm run test:slow` rather than gating
 * every push. Named, not silently skipped.
 */
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

describe("lossy channel — end-to-end overflow", () => {
  test("stalled consumer: drops are reported, and backlog is bounded by capacity not stall length", async () => {
    // How long a stall must last before anything is dropped depends on the
    // KERNEL's pipe buffer, not on us. A fixed stall calibrated to one machine
    // is a portability bug: 4 s overflowed the author's pipe and never
    // overflowed CI's, where this test failed on the first run it ever had.
    // So find the threshold instead of assuming it.
    const measure = async (stallMs: number) => {
      const h = spawnHelper({ drainStdout: false, statsIntervalMs: 1 });
      await waitFor(() => find(h.fd3, "ready"));
      await sleep(stallMs);
      h.drainStdout();
      const note = await waitFor(() => find(h.out, "stats-dropped"), 20_000, `drop notice after ${stallMs}ms`)
        .catch(() => undefined);
      await sleep(400);
      const survived = h.out.filter((l) => l.ev === "stats").length;
      h.kill();
      return note ? { dropped: note.n as number, survived } : undefined;
    };

    let stall = 2000;
    let short: { dropped: number; survived: number } | undefined;
    for (let attempt = 0; attempt < 5 && !short; attempt++) {
      short = await measure(stall);
      if (!short) stall *= 2;          // bigger pipe than expected — stall longer
    }
    expect(short, `no drops even after a ${stall}ms stall — the ring may not be dropping at all`)
      .toBeDefined();

    // Twice the stall, same bounded backlog. An unbounded queue would deliver
    // roughly twice as much from the longer window.
    const long = await measure(stall * 2);
    expect(long).toBeDefined();
    expect(long!.dropped).toBeGreaterThan(short!.dropped);
    expect(long!.survived).toBeLessThan(short!.survived * 1.5 + 300);
  }, 180_000);
});
