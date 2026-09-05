/**
 * STC-304 — a signal or a `quit` arriving mid-take must not lose the take.
 *
 * Before this, `App.shutdown` called `stop(reason:)` — asynchronous, answered
 * via a `DispatchGroup.notify` or `CaptureSession`'s own 20 s backstop — and
 * exited on the very next line. The process was gone before the sidecars its
 * own stop was going to write ever landed: no anchors.json, no events.json,
 * display.mp4 with no moov. The take library called the result "not a
 * recording".
 *
 * Reaching `.recording` for real needs a live SCStream, which needs a Screen
 * Recording grant — there is no fake-able path to it, so this is a grant test
 * like camera-capture.grant.test.ts and lossy-under-capture.grant.test.ts.
 * `npm run test:capture`, from a terminal that holds the grant (PHASE-0 §6: a
 * bare CLI binary inherits the launching terminal's TCC identity).
 */
import { describe, test, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import AjvImport from "ajv";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");

/**
 * STC-311: these two tests asserted the reason and never validated the
 * document, and the reasons they assert — "signal-15" and "quit" — were
 * exactly the ones anchors-2's enum refused. Each half of the check existed;
 * they were on different reasons, so the gap sat between them. Validating
 * here means a take this path produces is held to the same schema as one from
 * capture.grant.test.ts.
 */
function expectValidAnchors(dir: string): Record<string, any> {
  const anchors = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
  const ajv = new Ajv({ allErrors: true, strict: true });
  const validate = ajv.compile(
    JSON.parse(readFileSync(join(root, "schema/anchors-2.schema.json"), "utf8")),
  );
  expect(validate(anchors), `anchors.json: ${JSON.stringify(validate.errors, null, 2)}`).toBe(true);
  return anchors;
}
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
const session = () => mkdtempSync(join(tmpdir(), "stc-shutdown-"));

/**
 * Starts a real recording and returns the running handle, or a reason it
 * could not — the SKIP-GRANT case every grant test in this file family
 * shares. Ungranted, `start` answers `error`/`start-failed` (or the
 * equivalent CaptureError code) within milliseconds rather than hanging, so
 * this returns fast either way.
 */
async function startRecording() {
  const dir = session();
  const h = spawnHelper();
  await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");
  h.send({ cmd: "start", dir, seq: 1 });
  const started = await waitFor(() => h.fd3.find((l) => l.seq === 1), 20_000, "start outcome");
  if (started.ev !== "started") return { granted: false, dir, started } as const;
  return { granted: true, dir, started, h } as const;
}

const skipGrant = (started: unknown) =>
  new Error(
    "SKIP-GRANT: this environment has no Screen Recording grant, so STC-304's " +
    "shutdown-during-recording fix is unverified. Run from a terminal that holds " +
    `the grant. start said: ${JSON.stringify(started)}`,
  );

describe("helper shutdown while recording (STC-304)", () => {
  test("SIGTERM mid-take still produces a schema-valid anchors.json naming the signal", async () => {
    const rec = await startRecording();
    if (!rec.granted) throw skipGrant(rec.started);
    const { dir, h } = rec;

    await sleep(500); // a moment of real capture, not an instant stop-after-start race

    const exited = new Promise<number | null>((resolve) => h.proc.on("exit", (code) => resolve(code)));
    h.proc.kill("SIGTERM");

    // CaptureSession.stopTimeoutSeconds (20s) + main.swift's
    // shutdownBackstopMarginSeconds (5s) is the worst case before the
    // process answers on its own; this margin is generous on top of that,
    // not a tight bound — a slow CI disk finishing finishWriting() must not
    // be mistaken for the regression this test exists to catch.
    await Promise.race([
      exited,
      sleep(40_000).then(() => { throw new Error("helper did not exit within 40s of SIGTERM"); }),
    ]);

    expect(existsSync(join(dir, "anchors.json")), "anchors.json missing — the take was lost").toBe(true);
    expect(existsSync(join(dir, "events.json")), "events.json missing — the take was lost").toBe(true);
    const anchors = expectValidAnchors(dir);
    // SIGTERM is signal 15; main.swift's signal handler names it "signal-\(sig)".
    expect(anchors.stop?.reason).toBe("signal-15");
  }, 60_000);

  test("quit while recording sends `stopped` before `bye`, and exits", async () => {
    const rec = await startRecording();
    if (!rec.granted) throw skipGrant(rec.started);
    const { dir, h } = rec;

    await sleep(500);

    const exited = new Promise<number | null>((resolve) => h.proc.on("exit", (code) => resolve(code)));
    h.send({ cmd: "quit", seq: 2 });

    const bye = await waitFor(() => find(h.fd3, "bye"), 40_000, "bye");
    await Promise.race([
      exited,
      sleep(5_000).then(() => { throw new Error("helper sent bye but did not exit within 5s"); }),
    ]);

    // The regression this guards: shutdown used to send `bye` and exit before
    // its own triggered stop had answered at all, so `stopped` either never
    // arrived or arrived after the process was already gone.
    const stopped = find(h.fd3, "stopped");
    expect(stopped, "no `stopped` event arrived before `bye`").toBeDefined();
    const byeIndex = h.fd3.indexOf(bye);
    const stoppedIndex = h.fd3.indexOf(stopped!);
    expect(stoppedIndex, "`stopped` must be answered before `bye`, not after").toBeLessThan(byeIndex);

    expect(existsSync(join(dir, "anchors.json")), "anchors.json missing — the take was lost").toBe(true);
    const anchors = expectValidAnchors(dir);
    expect(anchors.stop?.reason).toBe("quit");
  }, 60_000);
});
