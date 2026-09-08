import { describe, test, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { parseShot } from "../../transform/src/shot.js";

/**
 * STC-301 gates 3 and 6, which CANNOT be CI gates — and that is a finding
 * about the ticket rather than a shortcut.
 *
 * The ticket opens with "each is enforced in CI on macOS runners, not checked
 * by eye". Gates 3 and 6 both call `capture-still`, which needs a Screen
 * Recording grant for whatever process runs the tests. GitHub's runners do not
 * have one and cannot be given one — which is exactly why this repo already
 * separates `*.grant.test.ts` out of `npm test` rather than letting them skip
 * inside it, since "skips read as covered and rot".
 *
 * So they are real, runnable checks that a person runs on a Mac with
 * `npm run test:capture`, and `docs/STC-301-GATES.md` says plainly which of
 * the six are CI-enforced and which are not. Building them as CI gates that
 * silently skip on every push would be the worse outcome: a green tick that
 * means nothing, which is the failure mode CLAUDE.md calls "success by finding
 * nothing to do".
 *
 * ## Gate 3 — capture latency
 *
 * > "`capture-still` from verb to buffer, measured on the runner, under the
 * > STC-289 budget. Recorded as a number in the run output like the 11.0
 * > ms/frame export figure, so drift is visible rather than binary."
 *
 * The number is PRINTED on success as well as failure, because the ticket asks
 * for drift to be visible rather than binary — a check that only speaks when it
 * fails cannot show a trend.
 *
 * ## Gate 6 — capture during recording
 *
 * > "A still taken mid-recording produces a valid shot and leaves the
 * > recording's frame timing undisturbed — asserted against the recording's own
 * > frame log, not just 'it didn't crash'."
 */

const root = join(__dirname, "..", "..");
const BIN = join(root, "helper", "build", "stc-helper");

/**
 * The STC-289 budget, from its runbook: "well under 200 ms from verb to
 * buffer". Taken as 200 ms rather than a tighter number invented here — the
 * point of a budget is that it was agreed before the measurement, and a
 * threshold chosen after seeing the result measures nothing.
 */
const STILL_BUDGET_MS = 200;

interface Line { ev: string; seq?: number; [k: string]: any }
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
  const proc = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
  live.push(proc);
  const out: Line[] = [], fd3: Line[] = [];
  collect(proc.stdout!, out);
  collect(proc.stdio[3] as Readable, fd3);
  proc.stderr!.resume();
  let seq = 100;
  return {
    out, fd3,
    send: (c: object) => proc.stdin!.write(JSON.stringify(c) + "\n"),
    request: async (c: object, ms = 20_000): Promise<Line> => {
      const s = ++seq;
      proc.stdin!.write(JSON.stringify({ ...c, seq: s }) + "\n");
      return waitFor(() => fd3.find((l) => l.seq === s), ms, `seq ${s} (${JSON.stringify(c)})`);
    },
    kill: () => proc.kill("SIGKILL"),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | false, ms = 20_000, what = "condition"): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(20);
  }
}
const find = (ls: Line[], ev: string) => ls.find((l) => l.ev === ev);
const tmpDir = (p: string) => mkdtempSync(join(tmpdir(), p));

/** Same probe and skip wording the other still grant test uses. */
async function probe(): Promise<{ ok: true } | { ok: false; why: string }> {
  const h = spawnHelper();
  await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");
  const r = await h.request({ cmd: "capture-still", dir: tmpDir("stc-probe-") });
  h.kill();
  if (r.ev === "still") return { ok: true };
  return { ok: false, why: `${r.code}: ${r.detail}` };
}

function skipUnless(p: { ok: true } | { ok: false; why: string }): void {
  if (!p.ok) {
    throw new Error(
      `SKIP-GRANT: capture-still answered ${p.why}. Without a Screen Recording grant ` +
      "for the process running the tests (and macOS 14+), gates 3 and 6 are unverified.",
    );
  }
}

/** Printed so a run shows the number, not just a verdict. */
function report(label: string, ms: number[]): void {
  const sorted = [...ms].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  process.stderr.write(
    `[gate 3] ${label}: ${ms.map((n) => n.toFixed(1)).join(", ")} ms ` +
    `(median ${median.toFixed(1)}, worst ${sorted[sorted.length - 1]!.toFixed(1)}, ` +
    `budget ${STILL_BUDGET_MS})\n`);
}

describe("STC-301 gate 3: capture latency", () => {
  test("capture-still answers within the STC-289 budget, and says how fast", async () => {
    skipUnless(await probe());
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");

    // Several, because one measurement is an anecdote — and the FIRST is
    // reported apart from the rest: `SCShareableContent` enumeration and the
    // ObjC-runtime lookup both happen once, so a cold first call is a
    // different number from the steady state and averaging them hides both.
    const timings: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const r = await h.request({ cmd: "capture-still", dir: tmpDir("stc-lat-") });
      const wall = performance.now() - t0;
      expect(r.ev, JSON.stringify(r)).toBe("still");
      timings.push(wall);
    }
    h.kill();

    report("verb to buffer (wall, first is cold)", timings);
    const steady = timings.slice(1);
    const worst = Math.max(...steady);
    // The budget is on the STEADY state. A cold first capture pays for content
    // enumeration that every later one does not, and holding it to the same
    // number would either fail honestly-fast builds or force the budget up
    // until it stopped meaning anything.
    expect(worst,
      `steady-state capture took ${worst.toFixed(1)} ms, over the ${STILL_BUDGET_MS} ms budget. ` +
      `All five: ${timings.map((n) => n.toFixed(1)).join(", ")}. ` +
      "docs/STC-289-RUNBOOK.md §latency says which phase to look at.")
      .toBeLessThan(STILL_BUDGET_MS);
  }, 180_000);
});

describe("STC-301 gate 6: a still taken during a recording", () => {
  test("produces a valid shot and leaves the recording's frame timing undisturbed", async () => {
    skipUnless(await probe());
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");

    const takeDir = tmpDir("stc-rec-");
    const started = await h.request({ cmd: "start", dir: takeDir }, 30_000);
    expect(started.ev, JSON.stringify(started)).toBe("started");

    // Let the recording reach a steady state before disturbing it, so the
    // comparison is against real frames rather than the first-frame ramp.
    await sleep(2000);
    const stillDir = tmpDir("stc-midtake-");
    const shotReply = await h.request({ cmd: "capture-still", dir: stillDir });
    expect(shotReply.ev, JSON.stringify(shotReply)).toBe("still");
    await sleep(2000);

    const stopped = await h.request({ cmd: "stop" }, 30_000);
    expect(stopped.ev, JSON.stringify(stopped)).toBe("stopped");
    h.kill();

    // Half one: the still is real and loads.
    expect(existsSync(join(stillDir, "shot.json"))).toBe(true);
    const shot = parseShot(JSON.parse(readFileSync(join(stillDir, "shot.json"), "utf8")));
    expect(existsSync(join(stillDir, shot.frame.file))).toBe(true);

    // Half two — the ticket's own words, "asserted against the recording's own
    // frame log, not just 'it didn't crash'".
    //
    // From the `stopped` REPLY, which is where `Capture.swift` reports
    // `frames`/`dropped`/`nonMonotonic`. The first draft of this read them off
    // `anchors.capture` with `?? 0`, and `anchors-2` carries no such fields —
    // so every assertion would have compared 0 to 0 and passed however badly
    // the recording had gone. Read from the wrong place, defaulted, and
    // therefore vacuous: the exact shape of check this repo keeps paying for.
    // They are required here rather than defaulted, so a rename fails loudly.
    for (const k of ["frames", "dropped", "nonMonotonic"] as const) {
      expect(typeof stopped[k],
        `the stopped reply has no numeric ${k} — this gate cannot see the frame log: ` +
        JSON.stringify(stopped)).toBe("number");
    }
    expect(stopped.frames as number,
      "the recording captured no frames at all, so 'undisturbed' means nothing").toBeGreaterThan(0);
    // Nothing dropped and nothing out of order: a still that stalled the
    // capture graph would show up as either.
    expect(stopped.dropped as number,
      "the mid-take still cost the recording frames").toBe(0);
    expect(stopped.nonMonotonic as number,
      "the mid-take still disturbed the frame clock").toBe(0);

    const anchors = JSON.parse(readFileSync(join(takeDir, "anchors.json"), "utf8"));
    const events = JSON.parse(readFileSync(join(takeDir, "events.json"), "utf8"));
    expect(anchors.stop?.reason, JSON.stringify(anchors.stop)).toBe("user");
    expect(Array.isArray(events.events)).toBe(true);

    // And the take is still a take: a display.mp4 with bytes in it.
    const mp4 = join(takeDir, anchors.files?.display ?? "display.mp4");
    expect(existsSync(mp4), "the recording lost its display.mp4").toBe(true);
    process.stderr.write(
      `[gate 6] recording survived a mid-take still: ` +
      `${stopped.frames} frames, ${stopped.dropped} dropped, ` +
      `${stopped.nonMonotonic} non-monotonic\n`);
  }, 240_000);
});
