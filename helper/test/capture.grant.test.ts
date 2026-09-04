/**
 * Requires a Screen Recording grant for the process running the tests, so it
 * is NOT part of `npm test` — see vitest.grant.config.ts and `npm run
 * test:capture`.
 *
 * It is a separate FILE rather than a skip on purpose. A skipped test reads
 * as covered and quietly rots; a named script that someone has to run is at
 * least honest about being a manual step. The routine way to exercise this
 * path is tools/test-host, which holds the grant.
 */
import { describe, test, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import AjvImport from "ajv";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const BIN = join(root, "helper", "build", "stc-helper");

// helper binary is built once by vitest.global-setup.ts

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
  const proc = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
  live.push(proc);
  const out: Line[] = [], fd3: Line[] = [];
  collect(proc.stdout!, out);
  collect(proc.stdio[3] as Readable, fd3);
  proc.stderr!.resume();
  return {
    out, fd3,
    send: (c: object) => proc.stdin!.write(JSON.stringify(c) + "\n"),
    kill: () => proc.kill("SIGKILL"),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | false, ms = 15_000, what = "condition"): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(20);
  }
}
const find = (ls: Line[], ev: string) => ls.find((l) => l.ev === ev);
const session = () => mkdtempSync(join(tmpdir(), "stc-cap-"));

/** Did this environment's TCC identity get a Screen Recording grant? */
async function probeGranted(): Promise<boolean> {
  const h = spawnHelper();
  await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");
  h.send({ cmd: "start", dir: session(), seq: 1 });
  const r = await waitFor(() => h.fd3.find((l) => l.seq === 1), 20_000, "start outcome");
  if (r.ev === "started") h.send({ cmd: "stop", seq: 2 });
  await sleep(200);
  h.kill();
  return r.ev === "started";
}

describe("capture — a real recording (requires Screen Recording)", () => {
  test("produces schema-valid display.mp4, events.json and anchors.json", async () => {
    if (!(await probeGranted())) {
      throw new Error(
        "SKIP-GRANT: this environment has no Screen Recording grant, so the real " +
        "capture path is unverified. Grant it to the process that runs the tests, " +
        "or run this suite from a bundle that has it.",
      );
    }
    const dir = session();
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    h.send({ cmd: "start", dir, seq: 1 });
    const started = await waitFor(() => h.fd3.find((l) => l.seq === 1), 20_000, "started");
    expect(started.ev).toBe("started");

    await sleep(3000);                       // record ~3 s
    h.send({ cmd: "stop", seq: 2 });
    const stopped = await waitFor(() => h.fd3.find((l) => l.seq === 2), 30_000, "stopped");
    expect(stopped.ev).toBe("stopped");
    expect(stopped.frames as number).toBeGreaterThan(0);

    for (const f of ["display.mp4", "events.json", "anchors.json"]) {
      expect(existsSync(join(dir, f)), `${f} missing`).toBe(true);
    }

    const ajv = new Ajv({ allErrors: true, strict: true });
    const load = (p: string) => JSON.parse(readFileSync(p, "utf8"));
    for (const [file, schema] of [
      // events-2 since STC-309: cursor-shape events beside the moves.
      ["events.json", "schema/events-2.schema.json"],
      // v2 since STC-232 increment 3: the helper always emits version 2 and
      // always writes a camera block, present:false when there is no camera.
      // This file is grant-gated, so `npm test` cannot catch it drifting —
      // which is exactly how the takes.ts version gate went stale (STC-262).
      ["anchors.json", "schema/anchors-2.schema.json"],
    ] as const) {
      const validate = ajv.compile(load(join(root, schema)));
      const ok = validate(load(join(dir, file)));
      expect(ok, `${file}: ${JSON.stringify(validate.errors, null, 2)}`).toBe(true);
    }

    // STC-309: the shape changes in the file are what the helper counted, and
    // each one is a CHANGE — two consecutive cursor events with the same shape
    // would mean the sampler is emitting per tick, not per change. Zero is a
    // legitimate count (nothing but the arrow was shown), so the assertion is
    // consistency, not presence: the terminal running this may well be showing
    // an I-beam, and a test that demanded zero would fail for being right.
    const events = load(join(dir, "events.json"));
    expect(events.version).toBe(2);
    const cursor = events.events.filter((e: any) => e.kind === "cursor");
    expect(stopped.cursorEvents, "stop reply carries cursorEvents").toBe(cursor.length);
    for (let i = 1; i < cursor.length; i++) {
      expect(cursor[i].shape, `cursor event ${i} repeats ${cursor[i - 1].shape}`).not.toBe(cursor[i - 1].shape);
    }
    // The sampler shares the tap's run loop; if it starved the tap the system
    // would have disabled it and the helper would have counted a re-enable.
    expect(stopped.tapReenables, "tap re-enabled while sampling the pointer").toBe(0);
    // Two clocks feed one file; the helper orders it on the way out.
    const ts = events.events.map((e: any) => e.t as number);
    expect(ts.every((t: number, i: number) => i === 0 || t >= ts[i - 1]!), "events.json is not time-ordered").toBe(true);

    // anchors must describe a capture that respects the hardware-encode cliff
    const anchors = load(join(dir, "anchors.json"));
    expect(anchors.capture.width).toBeLessThanOrEqual(3840);
    expect(anchors.capture.height).toBeLessThanOrEqual(2160);
    expect(typeof anchors.t0Ns).toBe("string");
  }, 120_000);
});
