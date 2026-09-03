/**
 * STC-305 — a stop arriving before start's own SCShareableContent callback
 * resolves must not leak a running capture or leave the start unanswered.
 *
 * `App.start`'s success branch used to `guard self.state == .starting else {
 * return }` — silently. If a stop arrived first, that guard failed and the
 * branch returned without sending anything: seq 1 (start) then sat unanswered
 * until the client's own 30 s request timeout, while the stream and event
 * tap this branch had just started kept running for the rest of the
 * process's life (the tap thread holds the session strongly inside
 * CFRunLoopRun — nothing ever frees it).
 *
 * Reproducing that needs the SUCCESS branch of SCShareableContent's
 * callback, which needs a Screen Recording grant — without one `start`
 * always takes the `.failure` branch instead (no grant → no displays →
 * -3801, in ~10 ms per PHASE-0 §6), which has no such guard and already
 * answers correctly. So unlike most of this file family, an UNGRANTED run
 * cannot even reach the regression to demonstrate it is fixed; it can only
 * confirm the already-correct failure path still works, which is the
 * SKIP-GRANT case below. Grant test: `npm run test:capture`.
 */
import { describe, test, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

const root = join(__dirname, "..", "..");
const BIN = join(root, "helper", "build", "stc-helper");

interface Line { ev: string; seq?: number; [k: string]: unknown }
const live: ChildProcess[] = [];
afterEach(() => { for (const p of live.splice(0)) p.kill("SIGKILL"); });

function collect(stream: Readable, sink: Line[]): void {
  let buf = "";
  stream.on("data", (c: Buffer) => {
    buf += c.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (l) { try { sink.push(JSON.parse(l)); } catch { /* not JSON */ } }
    }
  });
  stream.resume();
}

function spawnHelper() {
  const proc = spawn(BIN, { stdio: ["pipe", "pipe", "pipe", "pipe"] });
  live.push(proc);
  const out: Line[] = [], fd3: Line[] = [];
  collect(proc.stdout!, out);
  proc.stderr!.resume();
  collect(proc.stdio[3] as Readable, fd3);
  return { proc, out, fd3, send: (c: object) => proc.stdin!.write(JSON.stringify(c) + "\n") };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | false, ms: number, what: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(20);
  }
}
const find = (ls: Line[], ev: string) => ls.find((l) => l.ev === ev);
const session = () => mkdtempSync(join(tmpdir(), "stc-stopstart-"));

describe("stop arriving during start (STC-305)", () => {
  test("both requests are answered, no leaked stream, and the helper is usable afterward", async () => {
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");

    const dir = session();
    // Sent back-to-back, no await between them: the whole point is trying to
    // land `stop` before start's own SCShareableContent callback resolves.
    // Whether it actually wins that race depends on real timing — every
    // assertion below holds regardless of which side of the race actually
    // happened, which is what makes this non-flaky rather than a test that
    // only means something on a lucky run.
    h.send({ cmd: "start", dir, seq: 1 });
    h.send({ cmd: "stop", seq: 2 });

    // Not 30 s (the client's real request timeout this bug used to exhaust)
    // — bounded tight enough that a regression to "seq 1 never answered"
    // fails this test in seconds, not by waiting out the timeout it exists
    // to catch.
    const startOutcome = await waitFor(() => h.fd3.find((l) => l.seq === 1), 5_000, "seq 1 (start) outcome");
    const stopOutcome = await waitFor(() => h.fd3.find((l) => l.seq === 2), 5_000, "seq 2 (stop) outcome");

    if (startOutcome.ev === "error" && startOutcome.code === "no-displays") {
      throw new Error(
        "SKIP-GRANT: this environment has no Screen Recording grant, so the race " +
        "this test exists to exercise (a stop landing after a REAL capture already " +
        "started) cannot be reached — without a grant start always fails before " +
        `that point, which is already handled correctly. start said: ${JSON.stringify(startOutcome)}`,
      );
    }

    process.stderr.write(
      `[stop-during-start] start -> ${startOutcome.ev}${startOutcome.code ? `/${startOutcome.code}` : ""}, ` +
      `stop -> ${stopOutcome.ev}\n`);

    // Both requests answered — the regression was seq 1 (start) never
    // answering at all when the race was hit.
    expect(["started", "error"]).toContain(startOutcome.ev);
    expect(stopOutcome.ev).toBe("stopped");

    // Whichever side of the race actually happened, the helper must be back
    // to idle and reusable — not stuck "recording" against a session nothing
    // can reach, and not holding the display so the NEXT start fails with
    // -3805 ("application connection being interrupted": our own leaked
    // capture is still holding it — CLAUDE.md's own documented trap).
    h.send({ cmd: "status", seq: 3 });
    const status = await waitFor(() => h.fd3.find((l) => l.seq === 3), 5_000, "status");
    expect(status.state).toBe("idle");

    const dir2 = session();
    h.send({ cmd: "start", dir: dir2, seq: 4 });
    const secondStart = await waitFor(() => h.fd3.find((l) => l.seq === 4), 20_000, "second start outcome");
    expect(secondStart.ev, JSON.stringify(secondStart)).toBe("started");
    h.send({ cmd: "stop", seq: 5 });
    const secondStop = await waitFor(() => h.fd3.find((l) => l.seq === 5), 20_000, "second stop outcome");
    expect(secondStop.ev).toBe("stopped");

    h.send({ cmd: "quit", seq: 6 });
    await waitFor(() => find(h.fd3, "bye"), 30_000, "bye");
  }, 60_000);
});
