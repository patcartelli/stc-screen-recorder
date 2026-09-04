/**
 * STC-306 — a display stream that dies mid-take ends the take.
 *
 * Before this, `stream(_:didStopWithError:)` after a successful start only
 * sent a `stream-stopped` warning. The helper stayed in `recording`, frames
 * stopped, the writer stayed open and the heartbeat kept saying `recording`
 * until the user pressed Stop. Now the session tells its owner
 * (`CaptureSession.onStreamDied`) and `App` runs the same clean stop a
 * display change gets, with reason "stream-stopped".
 *
 * SCK does not die on request, so the death is INJECTED: `STC_CAPTURE_FAULT=
 * stream-died` makes the session call its own delegate method 0.5 s after a
 * successful start (Capture.swift, `armStreamDeathFault`). That exercises the
 * reaction — warning, unsolicited `stopped`, finalised sidecars, a helper
 * that is idle and usable afterwards — which is the whole of the fix; only
 * the SCStream's own teardown differs from a real death, and `stop()` runs it
 * the same way in both cases.
 *
 * Reaching `.recording` for real needs a live SCStream, which needs a Screen
 * Recording grant, so this is a grant test: `npm run test:capture`, from a
 * terminal that holds the grant (PHASE-0 §6: a bare CLI binary inherits the
 * launching terminal's TCC identity).
 */
import { describe, test, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import AjvImport from "ajv";

const Ajv = (AjvImport as any).default ?? AjvImport;
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

function spawnHelper(env: Record<string, string>) {
  const proc = spawn(BIN, ["--stats-interval-ms", "200"], {
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  live.push(proc);
  const out: Line[] = [], fd3: Line[] = [];
  collect(proc.stdout!, out);
  proc.stderr!.resume();
  collect(proc.stdio[3] as Readable, fd3);
  return {
    proc, out, fd3,
    send: (c: object) => proc.stdin!.write(JSON.stringify(c) + "\n"),
  };
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
const session = () => mkdtempSync(join(tmpdir(), "stc-stream-died-"));

/** An mp4 that was finalised carries a `moov` box; one whose writer never finished does not. */
function hasMoov(path: string): boolean {
  const b = readFileSync(path);
  return b.includes(Buffer.from("moov", "ascii"));
}

const skipGrant = (started: unknown) =>
  new Error(
    "SKIP-GRANT: this environment has no Screen Recording grant, so STC-306's " +
    "stream-death stop is unverified. Run from a terminal that holds the grant. " +
    `start said: ${JSON.stringify(started)}`,
  );

describe("a display stream that dies mid-take (STC-306)", () => {
  test("the helper warns, stops itself with reason stream-stopped, finalises the take, and is idle after", async () => {
    const dir = session();
    const h = spawnHelper({ STC_CAPTURE_FAULT: "stream-died" });
    await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");
    h.send({ cmd: "start", dir, seq: 1 });
    const started = await waitFor(() => h.fd3.find((l) => l.seq === 1), 20_000, "start outcome");
    if (started.ev !== "started") throw skipGrant(started);

    // Nobody sends `stop`. The fault fires 0.5 s in; the stop it triggers is
    // bounded by CaptureSession.stopTimeoutSeconds (20 s), so anything past
    // that is the regression: a helper that heard the stream die and stayed
    // in `recording`.
    const stopped = await waitFor(
      () => h.fd3.find((l) => l.ev === "stopped" && typeof l.seq !== "number"),
      30_000, "an unsolicited `stopped`");
    expect(stopped.reason).toBe("stream-stopped");
    expect(stopped.dir).toBe(dir);
    // A clean stop, not the 20 s backstop giving up on a wedged writer.
    expect(stopped.stopWarning, "the writer did not finalise in time").toBeUndefined();

    // The warning precedes the stop: the user hears WHY before the take ends.
    const warning = h.fd3.find((l) => l.ev === "warning" && l.code === "stream-stopped");
    expect(warning, "no stream-stopped warning").toBeDefined();
    expect(h.fd3.indexOf(warning!)).toBeLessThan(h.fd3.indexOf(stopped));

    // The take is intact up to the failure: both sidecars, and a display.mp4
    // that was finalised rather than abandoned with its writer open.
    for (const f of ["display.mp4", "events.json", "anchors.json"]) {
      expect(existsSync(join(dir, f)), `${f} missing`).toBe(true);
    }
    expect(statSync(join(dir, "display.mp4")).size).toBeGreaterThan(0);
    expect(hasMoov(join(dir, "display.mp4")), "display.mp4 has no moov — the writer never finished").toBe(true);

    const anchors = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
    expect(anchors.stop?.reason).toBe("stream-stopped");
    // The reason is in the schema's enum, not merely written: anchors-2 gained
    // it with this fix, and a take that fails validation is a take the library
    // cannot open.
    const ajv = new Ajv({ allErrors: true, strict: true });
    const validate = ajv.compile(JSON.parse(readFileSync(join(root, "schema/anchors-2.schema.json"), "utf8")));
    expect(validate(anchors), JSON.stringify(validate.errors, null, 2)).toBe(true);

    // The helper is idle and usable, not wedged: the heartbeat agrees (it is
    // the supervisor's authority), `status` agrees, and a second take can
    // start — the same "leave the helper usable" rule a failed start follows.
    await waitFor(() => h.out.some((l) => l.ev === "stats" && l.state === "idle"), 5_000, "an idle heartbeat");
    h.send({ cmd: "status", seq: 2 });
    const status = await waitFor(() => h.fd3.find((l) => l.seq === 2), 5_000, "status");
    expect(status.state).toBe("idle");

    const dir2 = session();
    h.send({ cmd: "start", dir: dir2, seq: 3 });
    const started2 = await waitFor(() => h.fd3.find((l) => l.seq === 3), 20_000, "second start");
    expect(started2.ev).toBe("started");
    // The fault is armed per start, so this take dies too and must end the
    // same way — a stale first session's callback must not be what stopped it,
    // and the second take's own must not be lost.
    const stopped2 = await waitFor(
      () => h.fd3.find((l) => l.ev === "stopped" && typeof l.seq !== "number" && l.dir === dir2),
      30_000, "the second take's unsolicited `stopped`");
    expect(stopped2.reason).toBe("stream-stopped");
    expect(JSON.parse(readFileSync(join(dir2, "anchors.json"), "utf8")).stop?.reason).toBe("stream-stopped");
  }, 120_000);

  test("without the fault, the same helper records and stops on request — the injector is opt-in", async () => {
    const dir = session();
    const h = spawnHelper({});
    await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");
    h.send({ cmd: "start", dir, seq: 1 });
    const started = await waitFor(() => h.fd3.find((l) => l.seq === 1), 20_000, "start outcome");
    if (started.ev !== "started") throw skipGrant(started);

    // Past the fault's 0.5 s with margin: a death here would be a fault that
    // fires without being asked for, which would end every real take.
    await sleep(2_000);
    expect(h.fd3.find((l) => l.ev === "stopped")).toBeUndefined();
    expect(h.fd3.find((l) => l.ev === "warning" && l.code === "stream-stopped")).toBeUndefined();

    h.send({ cmd: "stop", seq: 2 });
    const stopped = await waitFor(() => h.fd3.find((l) => l.seq === 2), 30_000, "stopped");
    expect(stopped.ev).toBe("stopped");
    expect(stopped.reason).toBe("user");
  }, 60_000);
});
