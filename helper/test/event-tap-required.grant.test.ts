/**
 * STC-315 — a take that cannot record the cursor is not started.
 *
 * The captured pixels never carry a pointer (`showsCursor` is false; the
 * transform draws it from events.json), so a take recorded without an event
 * tap has no cursor ANYWHERE. Until this ticket the helper warned once and
 * recorded video only, which produced a file indistinguishable from a good one
 * — the brief's rule 2 broken silently, and a `when` signal auto-zoom
 * (STC-324) cannot be built on. `CGEvent.tapCreate` returning nil is now an
 * ERROR on the `start` request, answered once on fd3 like every other refusal.
 *
 * ## Why this is a grant test, and what is injected
 *
 * The refusal sits in `begin()` — after `SCShareableContent` has listed a
 * display, before `setupWriter()`. That ordering is deliberate and is what
 * makes this file need a grant: it keeps `no-displays` as the first answer a
 * machine with no Screen Recording grant gets (every CI run, and every
 * existing test that asserts it), and it puts the refusal BEFORE anything of
 * the take exists on disk. After `setupWriter()` there is a display.mp4 with
 * frames in it, `App.removeIfNothingWorthKeeping` correctly declines to delete
 * a directory holding a non-empty file, and "no take directory can exist
 * without a cursor track" would be false.
 *
 * The nil itself is INJECTED (`STC_CAPTURE_FAULT=no-event-tap`, Capture.swift's
 * `makeEventTap`) rather than produced by revoking a grant: `tccutil reset
 * ListenEvent` costs the machine its Input Monitoring grant and a relaunch of
 * whatever held it, which is a runbook step, not a test. What is exercised
 * here is everything downstream of the nil — the code, the single answer, the
 * absent directory, and a helper still able to record afterwards. The real
 * TCC path is `docs/STC-315-RUNBOOK.md`.
 *
 * The CONTROL is the load-bearing half. "Start refused and no directory
 * appeared" is satisfied just as well by a helper that cannot start at all, so
 * the same binary, the same directory shape and no fault must produce a take.
 */
import { describe, test, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { explainFailedStart, type StartOutcome } from "./_start-outcome.js";

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

function spawnHelper(env: Record<string, string> = {}) {
  const proc = spawn(BIN, ["--stats-interval-ms", "200"], {
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
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

/**
 * A directory that does NOT exist yet, in a temp root that does.
 *
 * The helper creates the take directory itself and removes it again when a
 * start fails, so handing it a directory that already exists would make the
 * central assertion unfalsifiable: `main.swift` never touches a pre-existing
 * one (`dirExistedBefore`), and it would still be there whatever happened.
 */
function unmadeTakeDir(): string {
  return join(mkdtempSync(join(tmpdir(), "stc-tap-req-")), "take");
}

describe("cursor telemetry is a hard requirement (STC-315)", () => {
  test("a tap that cannot be created refuses the start, once, and leaves no take behind", async () => {
    const dir = unmadeTakeDir();
    const h = spawnHelper({ STC_CAPTURE_FAULT: "no-event-tap" });
    await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");
    h.send({ cmd: "start", dir, seq: 1 });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 1), 20_000, "start outcome");

    // A machine with no Screen Recording grant never reaches the tap check —
    // `no-displays` is answered first, by design — and a held display gives
    // -3805. Both are environments this cannot run in, so they are classified
    // and named rather than reported as a failure of the thing under test.
    // A start that SUCCEEDED with the fault set is not an environment problem
    // and deliberately does not come through here: it is the regression, and
    // it fails on the two assertions below.
    if (r.ev === "error" && r.code !== "event-tap-unavailable") {
      throw explainFailedStart(r as StartOutcome, "STC-315's refusal to start without a tap");
    }
    expect(r.ev).toBe("error");
    expect(r.code).toBe("event-tap-unavailable");
    // The detail has to be readable by a person: the app shows its own words,
    // but this string is what a log, a test failure or a bare terminal run
    // gives whoever is holding the machine.
    expect(String(r.detail ?? "")).toMatch(/Input Monitoring/);
    expect(String(r.detail ?? "")).toMatch(/never only in the video/);

    // Exactly once, like every other request. A refusal that also warned, or
    // that answered and then answered again, is the bug `finishStart` exists
    // to prevent.
    await sleep(500);
    expect(h.fd3.filter((l) => l.seq === 1)).toHaveLength(1);
    expect(h.fd3.filter((l) => l.ev === "started")).toHaveLength(0);

    // THE acceptance criterion, read off the disk. Not "the directory is
    // empty" — `removeIfNothingWorthKeeping` deletes it outright, and an empty
    // directory left on the user's Desktop would still be a take that isn't.
    expect(existsSync(dir), "a take directory survived a refused start").toBe(false);

    // And the helper is still usable: a refusal is not a wedge, because the
    // whole point is that the user grants the permission and presses Record
    // again in the same session.
    h.send({ cmd: "status", seq: 2 });
    const st = await waitFor(() => h.fd3.find((l) => l.seq === 2), 5_000, "status");
    expect(st.state).toBe("idle");
  }, 60_000);

  test("CONTROL: without the fault the same helper records, so the refusal is the tap and not the machine", async () => {
    // Without this, the test above passes on any machine that cannot start a
    // take for ANY reason — a held display, a broken writer, a binary that
    // refuses everything. It is the only assertion here that says the fault
    // injector is what made the difference.
    const dir = unmadeTakeDir();
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");
    h.send({ cmd: "start", dir, seq: 1 });
    const started = await waitFor(() => h.fd3.find((l) => l.seq === 1), 20_000, "start outcome");
    if (started.ev !== "started") {
      throw explainFailedStart(started as StartOutcome,
        "STC-315's control — that a take starts when the tap CAN be created");
    }
    expect(existsSync(dir)).toBe(true);

    h.send({ cmd: "stop", seq: 2 });
    const stopped = await waitFor(() => h.fd3.find((l) => l.seq === 2), 30_000, "stop");
    expect(stopped.ev).toBe("stopped");
    // events.json exists and is a real cursor track — the thing the refusal
    // above exists to guarantee. It may hold zero events (nothing moved the
    // mouse during an automated run, which CLAUDE.md records as
    // indistinguishable from a dead tap by count alone), so the claim here is
    // the FILE, not a number.
    expect(readdirSync(dir)).toContain("events.json");
    rmSync(dir, { recursive: true, force: true });
  }, 90_000);
});
