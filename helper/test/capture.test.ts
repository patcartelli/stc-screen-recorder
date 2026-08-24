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

describe("capture — behaviour without a Screen Recording grant", () => {
  test("start reports a specific, actionable error rather than hanging", async () => {
    if (await probeGranted()) return;      // covered by the granted suite instead
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    h.send({ cmd: "start", dir: session(), seq: 1 });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 1), 20_000, "start outcome");
    expect(r.ev).toBe("error");
    expect(r.code).toBe("no-displays");
    expect(String(r.detail)).toMatch(/Screen Recording/i);
  }, 60_000);

  test("a denied start leaves the helper idle and retryable, not wedged", async () => {
    if (await probeGranted()) return;
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    h.send({ cmd: "start", dir: session(), seq: 1 });
    await waitFor(() => h.fd3.find((l) => l.seq === 1), 20_000, "first start");
    h.send({ cmd: "status", seq: 2 });
    const st = await waitFor(() => h.fd3.find((l) => l.seq === 2), 10_000, "status");
    expect(st.state).toBe("idle");
    // and it can be asked again — the failure is not terminal
    h.send({ cmd: "start", dir: session(), seq: 3 });
    const again = await waitFor(() => h.fd3.find((l) => l.seq === 3), 20_000, "second start");
    expect(again.ev).toBe("error");
  }, 90_000);
});

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
      ["events.json", "schema/events-1.schema.json"],
      ["anchors.json", "schema/anchors-1.schema.json"],
    ] as const) {
      const validate = ajv.compile(load(join(root, schema)));
      const ok = validate(load(join(dir, file)));
      expect(ok, `${file}: ${JSON.stringify(validate.errors, null, 2)}`).toBe(true);
    }

    // anchors must describe a capture that respects the hardware-encode cliff
    const anchors = load(join(dir, "anchors.json"));
    expect(anchors.capture.width).toBeLessThanOrEqual(3840);
    expect(anchors.capture.height).toBeLessThanOrEqual(2160);
    expect(typeof anchors.t0Ns).toBe("string");
  }, 120_000);
});
