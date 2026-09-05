import { describe, test, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import AjvImport from "ajv";
import { parseShot } from "../../transform/src/shot.js";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const BIN = join(root, "helper", "build", "stc-helper");

// helper binary is built once by vitest.global-setup.ts

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
    request: async (c: object, ms = 15_000): Promise<Line> => {
      const s = ++seq;
      proc.stdin!.write(JSON.stringify({ ...c, seq: s }) + "\n");
      return waitFor(() => fd3.find((l) => l.seq === s), ms, `seq ${s} (${JSON.stringify(c)})`);
    },
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
const shotDir = () => mkdtempSync(join(tmpdir(), "stc-still-"));

/** PNG header: width/height big-endian at 16/20, colour type at 25 (6 = RGBA, 2 = RGB). */
function pngHeader(path: string): { width: number; height: number; colorType: number } {
  const b = readFileSync(path);
  expect(b.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(b.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25] ?? -1 };
}

const validate = new Ajv({ allErrors: true, strict: true })
  .compile(JSON.parse(readFileSync(join(root, "schema/shot-1.schema.json"), "utf8")));

function loadShot(dir: string) {
  const raw = JSON.parse(readFileSync(join(dir, "shot.json"), "utf8"));
  expect(validate(raw), JSON.stringify(validate.errors, null, 2)).toBe(true);
  return parseShot(raw);
}

/**
 * Did this environment's TCC identity get a Screen Recording grant, and is
 * the screenshot API there? A pre-14 OS answers `still-unsupported` and that
 * is a SKIP too: nothing below can run, and a red tick would read as the code.
 */
async function probe(): Promise<{ ok: true } | { ok: false; why: string }> {
  const h = spawnHelper();
  await waitFor(() => find(h.fd3, "ready"), 10_000, "ready");
  const r = await h.request({ cmd: "capture-still", dir: shotDir() });
  h.kill();
  if (r.ev === "still") return { ok: true };
  return { ok: false, why: `${r.code}: ${r.detail}` };
}

function skipUnless(p: { ok: true } | { ok: false; why: string }): void {
  if (!p.ok) {
    throw new Error(
      `SKIP-GRANT: capture-still answered ${p.why}. Without a Screen Recording grant ` +
      "for the process running the tests (and macOS 14+), the one-frame path is unverified.",
    );
  }
}

/**
 * STC-289 on real hardware. Everything the ticket's acceptance list can be
 * checked by a machine is here; what it cannot — that the pointer is NOT in
 * the pixels, that a window's corners are transparent rather than desktop —
 * is a human looking at frame.png, and docs/STC-289-RUNBOOK.md says where.
 */
describe("capture-still — one frame, no stream (requires Screen Recording, macOS 14+)", () => {
  test("a full-display still: frame.png at the display's pixel size, shot.json loads, and it is fast", async () => {
    skipUnless(await probe());
    const dir = shotDir();
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    const r = await h.request({ cmd: "capture-still", dir });
    expect(r.ev, JSON.stringify(r)).toBe("still");
    expect(r.dir).toBe(dir);

    const shot = loadShot(dir);
    expect(shot.kind).toBe("display-crop");
    expect(shot.crop).toEqual({ x: 0, y: 0, width: shot.display.pointWidth, height: shot.display.pointHeight });
    expect(shot.frame.alpha).toBe(false);
    // What the reply carried is what was written.
    expect(JSON.parse(JSON.stringify(parseShot(r.shot)))).toEqual(JSON.parse(JSON.stringify(shot)));

    const png = pngHeader(join(dir, shot.frame.file));
    expect(png.width).toBe(shot.frame.width);
    expect(png.height).toBe(shot.frame.height);
    // Full display resolution: the frame is the display's pixel size, not
    // the 4K-capped size a RECORDING uses.
    expect(shot.frame.width).toBe(shot.display.pixelWidth);
    expect(shot.frame.height).toBe(shot.display.pixelHeight);
    expect(statSync(join(dir, shot.frame.file)).size).toBeGreaterThan(1000);

    // The ticket's target is well under 200 ms from verb to buffer; STC-301
    // gate 3 records the number. Printed so drift is visible, and asserted
    // loosely — this is a laptop and a CI VM are different machines, and the
    // split says where the time went if it is slow.
    const t = r.timing as Record<string, number>;
    process.stderr.write(`[still] timing ${JSON.stringify(t)}\n`);
    const captureMs = t.captureMs ?? NaN, contentMs = t.contentMs ?? NaN;
    expect(captureMs).toBeGreaterThan(0);
    expect(captureMs - contentMs).toBeLessThan(1000);
    if (shot.cursor) {
      expect(shot.cursor.x).toBeGreaterThanOrEqual(0);
      expect(shot.cursor.x).toBeLessThan(shot.display.pointWidth);
      expect(shot.cursor.y).toBeGreaterThanOrEqual(0);
      expect(shot.cursor.y).toBeLessThan(shot.display.pointHeight);
    }
  }, 60_000);

  test("a region: the crop is the region, the frame is the region's pixel size", async () => {
    skipUnless(await probe());
    const dir = shotDir();
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    const crop = { x: 100, y: 80, width: 640, height: 360 };
    const r = await h.request({ cmd: "capture-still", dir, crop });
    expect(r.ev, JSON.stringify(r)).toBe("still");
    const shot = loadShot(dir);
    expect(shot.crop).toEqual(crop);
    const png = pngHeader(join(dir, shot.frame.file));
    expect(png.width).toBe(Math.round(crop.width * shot.display.backingScale));
    expect(png.height).toBe(Math.round(crop.height * shot.display.backingScale));
  }, 60_000);

  test("a bad display id is refused, never silently the first display", async () => {
    skipUnless(await probe());
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    const r = await h.request({ cmd: "capture-still", dir: shotDir(), displayId: 0x7fffffff });
    expect(r.ev).toBe("error");
    expect(r.code).toBe("no-such-display");
  }, 60_000);

  test("a crop entirely off the display is refused", async () => {
    skipUnless(await probe());
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    const r = await h.request({ cmd: "capture-still", dir: shotDir(),
                                crop: { x: 1e6, y: 1e6, width: 10, height: 10 } });
    expect(r.ev).toBe("error");
    expect(r.code).toBe("crop-outside-display");
  }, 60_000);

  test("a window still: alpha end to end — the PNG carries an alpha channel and shot.json says so", async () => {
    skipUnless(await probe());
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    const list = await h.request({ cmd: "windows" });
    expect(list.ev, JSON.stringify(list)).toBe("windows");
    // Any titled layer-0 window will do; a Finder or Terminal window is
    // always around on a machine running this. No window at all is a skip,
    // not a failure — the code under test never got a subject.
    const win = (list.windows as any[]).find((w) => w.title && w.width > 50 && w.height > 50);
    if (!win) throw new Error("SKIP-GRANT: no titled on-screen window to capture");

    const dir = shotDir();
    const r = await h.request({ cmd: "capture-still", dir, kind: "window", windowId: win.id });
    expect(r.ev, JSON.stringify(r)).toBe("still");
    const shot = loadShot(dir);
    expect(shot.kind).toBe("window");
    expect(shot.window?.id).toBe(win.id);
    expect(shot.window?.bounds.width).toBe(win.width);
    expect(shot.window?.bounds.height).toBe(win.height);
    // Alpha is the whole reason window capture is not a crop (STC-289,
    // changed decision). The reply says if it did not come back with one.
    expect(r.alphaWarning, String(r.alphaWarning)).toBeUndefined();
    expect(shot.frame.alpha).toBe(true);
    expect(shot.decoration.mode).toBe("window-only");
    expect(pngHeader(join(dir, shot.frame.file)).colorType).toBe(6);
  }, 60_000);

  test("a window id that is not on screen is refused", async () => {
    skipUnless(await probe());
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    const r = await h.request({ cmd: "capture-still", dir: shotDir(), kind: "window", windowId: 0x7fffffff });
    expect(r.ev).toBe("error");
    expect(r.code).toBe("no-such-window");
  }, 60_000);

  test("a still during a recording leaves the recording undisturbed", async () => {
    // STC-301 gate 6, the helper half: the recording's own frame log is the
    // authority. A still that stalled the stream would show as dropped or
    // non-monotonic frames, or a frame count that stopped growing.
    skipUnless(await probe());
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    const take = mkdtempSync(join(tmpdir(), "stc-still-take-"));
    const started = await h.request({ cmd: "start", dir: take }, 20_000);
    expect(started.ev, JSON.stringify(started)).toBe("started");

    await sleep(1500);
    const before = await h.request({ cmd: "status" });
    const stillDir = shotDir();
    const r = await h.request({ cmd: "capture-still", dir: stillDir });
    expect(r.ev, JSON.stringify(r)).toBe("still");
    loadShot(stillDir);
    const during = await h.request({ cmd: "status" });
    expect(during.state).toBe("recording");
    expect(during.session).toBe(before.session);
    await sleep(1500);

    const stopped = await h.request({ cmd: "stop" }, 30_000);
    expect(stopped.ev).toBe("stopped");
    expect(stopped.reason).toBe("user");
    expect(stopped.frames).toBeGreaterThan(30);
    expect(stopped.dropped).toBe(0);
    expect(stopped.nonMonotonic).toBe(0);
    expect(existsSync(join(take, "anchors.json"))).toBe(true);
  }, 90_000);
});
