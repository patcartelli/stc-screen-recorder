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
 * There are actually TWO windows a `stop` can land in, and review caught the
 * one the ticket's own report did not: `startStream()` assigns `self.stream`
 * SYNCHRONOUSLY, before `SCStream.startCapture`'s own async completion fires
 * — so a `stop` arriving in that gap hits a session with a REAL stream, not
 * the empty one the ticket described, and `CaptureSession.stop()` begins a
 * genuine teardown. If the stray success then also lands while that teardown
 * is still in flight, the fixed guard's else-branch used to call
 * `session.stop()` a SECOND time, concurrently, on the same session —
 * `stream.stopCapture` and `writer.finishWriting` invoked twice is the exact
 * AVAssetWriter race this codebase already crashed on once (STC-254).
 * `CaptureSession.stop()` now coalesces re-entrant callers onto the one real
 * teardown instead of starting another, which is what the crash-watch below
 * and the repeated attempts exist to give a real chance of exercising.
 *
 * Reproducing any of this needs the SUCCESS branch of SCShareableContent's
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

/**
 * `crash` names the signal if the process dies unexpectedly. Without this, a
 * crash mid-race reads only as "timeout waiting for X" from whichever
 * `waitFor` was pending — a diagnostic that does not say a crash happened at
 * all, in a test whose whole point is watching for exactly that.
 */
function spawnHelper() {
  const proc = spawn(BIN, { stdio: ["pipe", "pipe", "pipe", "pipe"] });
  live.push(proc);
  const out: Line[] = [], fd3: Line[] = [];
  const handle = { proc, out, fd3, crash: null as string | null,
    send: (c: object) => proc.stdin!.write(JSON.stringify(c) + "\n") };
  proc.on("exit", (_code, signal) => { if (signal) handle.crash = signal; });
  collect(proc.stdout!, out);
  proc.stderr!.resume();
  collect(proc.stdio[3] as Readable, fd3);
  return handle;
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

/**
 * One race attempt: fresh helper, start immediately followed by stop, no
 * await between them — trying to land `stop` before start's own
 * SCShareableContent callback resolves. Every assertion holds regardless of
 * which of the two windows (or neither) the race actually landed in, which
 * is what makes repeating this non-flaky rather than a test that only means
 * something on a lucky run: each attempt is a real chance to hit the narrow
 * "stream already real, teardown still in flight" window, not a source of
 * intermittent failure.
 */
async function attemptRace(n: number): Promise<{ granted: boolean; startEv: string }> {
  const h = spawnHelper();
  await waitFor(() => find(h.fd3, "ready"), 10_000, `ready (attempt ${n})`);

  const dir = session();
  h.send({ cmd: "start", dir, seq: 1 });
  h.send({ cmd: "stop", seq: 2 });

  // Not 30 s (the client's real request timeout this bug used to exhaust) —
  // bounded tight enough that a regression to "seq 1 never answered" fails
  // this test in seconds, not by waiting out the timeout it exists to catch.
  const startOutcome = await waitFor(() => h.fd3.find((l) => l.seq === 1), 5_000, `seq 1 (start) outcome (attempt ${n})`);
  const stopOutcome = await waitFor(() => h.fd3.find((l) => l.seq === 2), 5_000, `seq 2 (stop) outcome (attempt ${n})`);

  if (startOutcome.ev === "error" && startOutcome.code === "no-displays") {
    return { granted: false, startEv: startOutcome.ev };
  }

  process.stderr.write(
    `[stop-during-start] attempt ${n}: start -> ${startOutcome.ev}${startOutcome.code ? `/${startOutcome.code}` : ""}, ` +
    `stop -> ${stopOutcome.ev}\n`);

  // Both requests answered — the regression was seq 1 (start) never
  // answering at all when the race was hit.
  expect(["started", "error"]).toContain(startOutcome.ev);
  expect(stopOutcome.ev).toBe("stopped");
  expect(h.crash, `helper died with signal ${h.crash} during attempt ${n} — the exact double-teardown class this fix exists to prevent`).toBeNull();

  // Whichever side of the race actually happened, the helper must be back to
  // idle and reusable — not stuck "recording" against a session nothing can
  // reach, and not holding the display so the NEXT start fails with -3805
  // ("application connection being interrupted": our own leaked capture is
  // still holding it — CLAUDE.md's own documented trap).
  h.send({ cmd: "status", seq: 3 });
  const status = await waitFor(() => h.fd3.find((l) => l.seq === 3), 5_000, `status (attempt ${n})`);
  expect(status.state).toBe("idle");

  const dir2 = session();
  h.send({ cmd: "start", dir: dir2, seq: 4 });
  const secondStart = await waitFor(() => h.fd3.find((l) => l.seq === 4), 20_000, `second start outcome (attempt ${n})`);
  expect(secondStart.ev, JSON.stringify(secondStart)).toBe("started");
  h.send({ cmd: "stop", seq: 5 });
  const secondStop = await waitFor(() => h.fd3.find((l) => l.seq === 5), 20_000, `second stop outcome (attempt ${n})`);
  expect(secondStop.ev).toBe("stopped");
  expect(h.crash, `helper died with signal ${h.crash} after attempt ${n}'s race`).toBeNull();

  h.send({ cmd: "quit", seq: 6 });
  await waitFor(() => find(h.fd3, "bye"), 30_000, `bye (attempt ${n})`);
  return { granted: true, startEv: startOutcome.ev };
}

describe("stop arriving during start (STC-305)", () => {
  test("both requests are answered, no leaked stream, no crash, helper reusable afterward", async () => {
    const first = await attemptRace(1);
    if (!first.granted) {
      throw new Error(
        "SKIP-GRANT: this environment has no Screen Recording grant, so the race " +
        "this test exists to exercise (a stop landing after a REAL capture already " +
        "started) cannot be reached — without a grant start always fails before " +
        `that point, which is already handled correctly. start said: ${first.startEv}`,
      );
    }
    // 7 more: cheap against real hardware, and each is an independent roll
    // at landing in the narrow "stream already real, teardown still in
    // flight" window review found — one attempt only exercises whichever
    // window real timing happens to hit, if either.
    for (let n = 2; n <= 8; n++) await attemptRace(n);
  }, 180_000);
});
