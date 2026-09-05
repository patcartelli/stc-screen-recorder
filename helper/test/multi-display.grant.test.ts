/**
 * STC-247: a take of a display that is NOT the one SCK lists first.
 *
 * Needs a Screen Recording grant AND two displays, so it is a grant test (see
 * capture.grant.test.ts for why that is a separate file rather than a skip)
 * and it REFUSES rather than skipping when the machine has one display: a
 * skipped test reads as covered, and this one has never run anywhere until a
 * second display is plugged in.
 *
 * What it proves: the helper records the display it was asked for, and the
 * take's anchors describe THAT display — id, point size, and the global
 * origin every event coordinate is relative to. What it cannot prove is that
 * the pixels are the right screen's; docs/STC-247-RUNBOOK.md has the human
 * watch for that.
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
const session = () => mkdtempSync(join(tmpdir(), "stc-md-"));

interface DisplayInfo {
  id: number; main: boolean; name: string;
  pointW: number; pointH: number; pixelW: number; pixelH: number; originX: number; originY: number;
}

describe("multi-display capture (STC-247) — requires Screen Recording and two displays", () => {
  test("records the non-main display it was asked for, and anchors describe that display", async () => {
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");

    h.send({ cmd: "devices", seq: 1 });
    const dev = await waitFor(() => h.fd3.find((l) => l.seq === 1), 15_000, "devices");
    const displays = (dev.displays as DisplayInfo[] | undefined) ?? [];
    if (displays.length < 2) {
      throw new Error(
        `SKIP-DISPLAYS: this machine lists ${displays.length} display(s), so a multi-display take ` +
        "cannot be recorded here and STC-247 is unverified. Connect a second display and run again.",
      );
    }
    // The one SCK would NOT pick by default is the interesting one. There is
    // no promise SCK lists the main display first, so "not main" is the
    // discriminator, not "not first".
    const target = displays.find((d) => !d.main) ?? displays[1]!;
    const dir = session();
    h.send({ cmd: "start", dir, displayId: target.id, seq: 2 });
    const started = await waitFor(() => h.fd3.find((l) => l.seq === 2), 20_000, "start outcome");
    if (started.ev !== "started" && started.code === "no-displays") {
      throw new Error(
        "SKIP-GRANT: this environment has no Screen Recording grant, so the multi-display path is " +
        `unverified. start said: ${JSON.stringify(started)}`,
      );
    }
    expect(started.ev, JSON.stringify(started)).toBe("started");
    expect(started.display, "started names the display it is capturing").toBe(target.id);

    await sleep(3000);
    h.send({ cmd: "stop", seq: 3 });
    const stopped = await waitFor(() => h.fd3.find((l) => l.seq === 3), 30_000, "stopped");
    expect(stopped.ev).toBe("stopped");
    expect(stopped.frames as number).toBeGreaterThan(0);

    for (const f of ["display.mp4", "events.json", "anchors.json"]) {
      expect(existsSync(join(dir, f)), `${f} missing`).toBe(true);
    }
    const load = (p: string) => JSON.parse(readFileSync(p, "utf8"));
    const ajv = new Ajv({ allErrors: true, strict: true });
    const validate = ajv.compile(load(join(root, "schema/anchors-2.schema.json")));
    const anchors = load(join(dir, "anchors.json"));
    expect(validate(anchors), JSON.stringify(validate.errors, null, 2)).toBe(true);

    // THE assertions: the take describes the display that was asked for, in
    // the same global point space `devices` reported it in. A wrong id here is
    // the wrong screen; a wrong origin is every cursor drawn offset by a whole
    // display.
    expect(anchors.display.id).toBe(target.id);
    expect(anchors.display.originX).toBe(target.originX);
    expect(anchors.display.originY).toBe(target.originY);
    expect(anchors.display.pointWidth).toBe(target.pointW);
    expect(anchors.display.pointHeight).toBe(target.pointH);
    expect(anchors.capture.width).toBeLessThanOrEqual(3840);
    expect(anchors.capture.height).toBeLessThanOrEqual(2160);

    // Events, if the mouse was on that display, lie inside it in global points.
    const events = load(join(dir, "events.json")).events as any[];
    const positional = events.filter((e) => e.kind !== "cursor");
    const outside = positional.filter((e) =>
      e.x < target.originX - 1 || e.x > target.originX + target.pointW + 1 ||
      e.y < target.originY - 1 || e.y > target.originY + target.pointH + 1);
    // The pointer may well have been on the OTHER display for the whole take
    // (the tap is global), so this is a report, not an assertion: the runbook
    // says to keep the mouse on the target display so it becomes one.
    process.stderr.write(
      `[multi-display] recorded display ${target.id} "${target.name}" ${target.pointW}x${target.pointH} ` +
      `@ ${target.originX},${target.originY}: ${stopped.frames} frames, ${positional.length} pointer events, ` +
      `${outside.length} outside the display\n`);
  }, 120_000);

  test("a displayId that is not listed is refused with display-not-found, and the helper stays idle", async () => {
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");
    h.send({ cmd: "start", dir: session(), displayId: 4_000_000_001, seq: 1 });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 1), 20_000, "start outcome");
    if (r.code === "no-displays") {
      throw new Error(`SKIP-GRANT: no Screen Recording grant here; start said: ${JSON.stringify(r)}`);
    }
    expect(r.ev).toBe("error");
    expect(r.code).toBe("display-not-found");
    expect(String(r.detail)).toContain("4000000001");
    h.send({ cmd: "status", seq: 2 });
    const st = await waitFor(() => h.fd3.find((l) => l.seq === 2), 10_000, "status");
    expect(st.state).toBe("idle");
  }, 60_000);
});
