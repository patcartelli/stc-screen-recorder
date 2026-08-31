/**
 * STC-249 — the lossy stats ring under REAL capture load.
 *
 * The ring's semantics are covered fast by helper/test/ring.test.ts, and its
 * wiring — that a stalled consumer overflows it and the gap is reported — by
 * helper/test/ring-overflow.slow.test.ts. Both of those run against an IDLE
 * helper. Nothing has ever stalled the consumer while a recording was actually
 * running, which is the only scenario the design claim is about:
 *
 *   "stdout = lossy/non-blocking stats (drop-oldest, never block capture
 *    callbacks); never let stats back-pressure the capture graph."
 *
 * An idle helper cannot demonstrate that. It has no capture graph to
 * back-pressure.
 *
 * Requires a Screen Recording grant, so it is a separate FILE and not a skip —
 * a skipped test reads as covered and rots. `npm run test:capture`.
 */
import { describe, test, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

const root = join(__dirname, "..", "..");
const BIN = join(root, "helper", "build", "stc-helper");

/**
 * Where the escalation starts. How long a stall must last before anything drops
 * is a property of the KERNEL's pipe buffer, not of this code: measured idle on
 * this machine, 2000 ms dropped NOTHING, 4000 ms dropped 1051 and 8000 ms
 * dropped 5038. ring-overflow.slow.test.ts records that CI's pipe is larger
 * still and never overflowed at a duration that worked here.
 *
 * So this is a starting point, not a calibration — the loop below doubles it
 * until the ring actually overflows. A fixed duration tuned to one machine is
 * the portability bug that test already hit, and it hit it on the first CI run
 * it ever had.
 */
const START_MS = 8000;

/** Two doublings: 8s, 16s, 32s. Recordings are expensive; this bounds the cost. */
const ESCALATIONS = 2;

/** 1 ms, so the ring fills in seconds instead of the minutes 2000 ms would take. */
const STATS_INTERVAL_MS = 1;

interface Line { ev: string; seq?: number; [k: string]: unknown }
const live: ChildProcess[] = [];
afterEach(() => { for (const p of live.splice(0)) p.kill("SIGKILL"); });

function collect(stream: Readable, sink: Line[]): void {
  let buf = "";
  // resume() is required, not decorative: attaching a "data" listener to a
  // child stdio pipe that was explicitly paused does NOT re-enable reading, and
  // the stream then delivers nothing forever. That is the whole mechanism this
  // test depends on, in both directions.
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

function spawnHelper({ drainStdout }: { drainStdout: boolean }) {
  const proc = spawn(BIN, ["--stats-interval-ms", String(STATS_INTERVAL_MS)],
    { stdio: ["pipe", "pipe", "pipe", "pipe"] });
  live.push(proc);
  const out: Line[] = [], fd3: Line[] = [];
  if (drainStdout) collect(proc.stdout!, out);
  else proc.stdout!.pause();          // the stalled consumer
  proc.stderr!.resume();              // stderr must never back up
  collect(proc.stdio[3] as Readable, fd3);
  return {
    out, fd3,
    send: (c: object) => proc.stdin!.write(JSON.stringify(c) + "\n"),
    drainStdout: () => collect(proc.stdout!, out),
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
const session = () => mkdtempSync(join(tmpdir(), "stc-lossy-"));

/** One recording. Returns what the helper reported about it. */
async function record({ drainStdout, ms }: { drainStdout: boolean; ms: number }) {
  const dir = session();
  const h = spawnHelper({ drainStdout });
  await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");
  h.send({ cmd: "start", dir, seq: 1 });
  const started = await waitFor(() => h.fd3.find((l) => l.seq === 1), 20_000, "start outcome");
  if (started.ev !== "started") { h.kill(); return { granted: false, dir, started } as const; }

  await sleep(ms);

  // Over fd3, which is the RELIABLE channel. A stop that cannot be issued or
  // answered while stdout is stalled would mean the two channels are not
  // actually independent, and the parent would be left holding a recording it
  // cannot end.
  h.send({ cmd: "stop", seq: 2 });
  const stopped = await waitFor(() => h.fd3.find((l) => l.seq === 2), 40_000, "stop outcome");

  // Only now is the backlog released, so anything read here was buffered or
  // dropped while the recording was live.
  if (!drainStdout) { h.drainStdout(); await sleep(500); }
  const drops = h.out.filter((l) => l.ev === "stats-dropped")
    .reduce((n, l) => n + (l.n as number), 0);
  h.kill();
  return {
    granted: true, dir, started, stopped, drops, ms,
    statsSeen: h.out.filter((l) => l.ev === "stats").length,
  } as const;
}

describe("lossy stats ring under real capture (STC-249)", () => {
  test("a stalled stats consumer does not back-pressure the capture graph", async () => {
    // Escalate until the ring ACTUALLY overflows. A run where it did not is a
    // run that exercised nothing, and "no frames dropped" is then the trivial
    // answer to a question never asked.
    let stalled = await record({ drainStdout: false, ms: START_MS });
    if (!stalled.granted) {
      throw new Error(
        "SKIP-GRANT: this environment has no Screen Recording grant, so the lossy " +
        "ring under real capture load is unverified. Run from a bundle that holds " +
        `the grant (tools/test-host). start said: ${JSON.stringify(stalled.started)}`,
      );
    }
    for (let i = 0; i < ESCALATIONS && stalled.drops === 0; i++) {
      const longer = stalled.ms * 2;
      process.stderr.write(
        `[lossy] no drops after ${stalled.ms}ms — this machine's pipe is larger; retrying at ${longer}ms\n`);
      stalled = await record({ drainStdout: false, ms: longer }) as typeof stalled;
    }

    expect(stalled.stopped.ev, JSON.stringify(stalled.stopped)).toBe("stopped");
    expect(existsSync(join(stalled.dir, "display.mp4")), "display.mp4 missing").toBe(true);

    // Without this the rest proves nothing.
    expect(stalled.drops,
      `no stats dropped even after ${stalled.ms}ms at a ${STATS_INTERVAL_MS}ms interval, so the ` +
      "ring never overflowed and this test exercised nothing. Either the pipe is far " +
      "larger than expected or the heartbeat is not reaching the lossy channel.")
      .toBeGreaterThan(0);

    // THE assertion the ticket is about: the recording is unharmed by a
    // consumer that never read a byte of stdout for its whole duration — and
    // `stop`, which travels the RELIABLE channel, was still issued and answered
    // while stdout was stalled.
    expect(stalled.stopped.frames as number).toBeGreaterThan(0);
    expect(stalled.stopped.dropped as number,
      "frames were dropped while stdout was stalled — stats back-pressured capture").toBe(0);
    expect(stalled.stopped.nonMonotonic as number,
      "non-monotonic frames under a stalled consumer").toBe(0);

    // A CONTROL, because "captured fine with a stalled consumer" is only
    // meaningful against a machine that captures fine at all. Same duration,
    // same helper, stdout drained throughout. A uniform failure to capture
    // would otherwise satisfy every assertion above.
    const drained = await record({ drainStdout: true, ms: stalled.ms });
    expect(drained.granted).toBe(true);
    expect(drained.stopped!.frames as number).toBeGreaterThan(0);
    expect(drained.drops, "a drained consumer should not overflow the ring").toBe(0);

    // Frame counts within a wide band. Wide on purpose — a real screen, VFR
    // capture, and nothing forcing the display to change — but a stalled
    // consumer throttling capture would show as a collapse, not a wobble.
    const s = stalled.stopped.frames as number, d = drained.stopped!.frames as number;
    expect(s, `stalled captured ${s} frames vs drained ${d} — stdout is throttling capture`)
      .toBeGreaterThan(d * 0.5);

    // Printed on SUCCESS, not just on failure. This test needs a grant, so it
    // runs rarely and by hand; a pass that leaves no numbers behind means the
    // next person has a green tick and no idea what it saw. stderr, because
    // vitest attributes and can discard console output.
    process.stderr.write(
      `[lossy] STC-249 verified: ${stalled.ms}ms stalled -> ${s} frames, ` +
      `${stalled.stopped.dropped} dropped, ${stalled.drops} stats discarded; ` +
      `drained control -> ${d} frames\n`);
  }, 300_000);
});
