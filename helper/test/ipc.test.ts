import { describe, test, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

const root = join(__dirname, "..", "..");
const BIN = join(root, "helper", "build", "stc-helper");

// helper binary is built once by vitest.global-setup.ts

interface Line { ev: string; seq?: number; [k: string]: unknown }

interface Helper {
  proc: ChildProcess;
  out: Line[];   // stdout — lossy channel
  fd3: Line[];   // fd3 — reliable channel
  send(cmd: object): void;
  drainStdout(): void;
  kill(): void;
}

function collect(stream: Readable, sink: Line[]): void {
  let buf = "";
  // resume() is required, not decorative: on a child's stdio pipe that was
  // explicitly paused, attaching a "data" listener alone does NOT re-enable
  // reading, and the stream silently delivers nothing forever.
  stream.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) { try { sink.push(JSON.parse(line)); } catch { /* not JSON */ } }
    }
  });
  stream.resume();
}

const live: ChildProcess[] = [];

function spawnHelper(opts: { fd3?: boolean; drainStdout?: boolean; statsIntervalMs?: number } = {}): Helper {
  const withFd3 = opts.fd3 ?? true;
  const drain = opts.drainStdout ?? true;
  const stdio: any[] = ["pipe", "pipe", "pipe"];
  if (withFd3) stdio.push("pipe");
  const argv = opts.statsIntervalMs ? ["--stats-interval-ms", String(opts.statsIntervalMs)] : [];
  const proc = spawn(BIN, argv, { stdio });
  live.push(proc);
  const out: Line[] = [];
  const fd3: Line[] = [];
  if (drain) collect(proc.stdout!, out);
  else proc.stdout!.pause();          // simulate a stalled consumer: OS pipe fills
  proc.stderr!.resume();               // never let stderr back up
  if (withFd3) collect(proc.stdio[3] as Readable, fd3);
  return {
    proc, out, fd3,
    send: (cmd) => proc.stdin!.write(JSON.stringify(cmd) + "\n"),
    drainStdout: () => collect(proc.stdout!, out),
    kill: () => proc.kill("SIGKILL"),
  };
}

afterEach(() => { for (const p of live.splice(0)) p.kill("SIGKILL"); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | undefined | false, ms = 5000, what = "condition"): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(10);
  }
}

const find = (ls: Line[], ev: string) => ls.find((l) => l.ev === ev);
const tmpSession = () => mkdtempSync(join(tmpdir(), "stc-ipc-"));

describe("reliable channel — fd3, request/response with sequence numbers", () => {
  test("ready is a reliable lifecycle event on fd3, not lossy stdout", async () => {
    const h = spawnHelper();
    const ready = await waitFor(() => find(h.fd3, "ready"), 5000, "ready");
    expect(ready.protocol).toBe(1);
    expect(find(h.out, "ready")).toBeUndefined();
  });

  test("a command's response echoes its seq on fd3", async () => {
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    h.send({ cmd: "status", seq: 7 });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 7), 5000, "seq 7");
    expect(r.ev).toBe("status");
    expect(r.state).toBe("idle");
  });

  test("concurrent commands each get their own seq back, none on stdout", async () => {
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    for (const seq of [1, 2, 3]) h.send({ cmd: "status", seq });
    await waitFor(() => h.fd3.filter((l) => l.ev === "status").length === 3, 5000, "3 status");
    expect(h.fd3.filter((l) => l.ev === "status").map((l) => l.seq)).toEqual([1, 2, 3]);
    expect(h.out.some((l) => l.ev === "status")).toBe(false);
  });

  test("errors are reliable and carry the offending command's seq", async () => {
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    h.send({ cmd: "nonsense", seq: 42 });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 42), 5000, "seq 42");
    expect(r.ev).toBe("error");
    expect(r.code).toBe("unknown-command");
  });

  test("cursor-probe answers on fd3 with references, a sample count and a cost (STC-309)", async () => {
    // Runs the production sampler for a moment. No assertion on WHICH shape:
    // a CI VM may have no pointer at all (nilSamples), and that is a valid
    // answer — what must hold is that the reply has the shape a spike reader
    // needs, and that the reply arrives at all. A helper that never answered
    // would be the unbounded wait this codebase keeps finding.
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    h.send({ cmd: "cursor-probe", seq: 7, ms: 300 });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 7), 5000, "cursor-probe reply");
    expect(r.ev).toBe("cursor-probe");
    expect(r.thread).toBe("sampler");
    expect((r.references as any[]).map((x) => x.shape)).toEqual(["arrow", "ibeam", "crosshair", "pointingHand"]);
    expect(r.missingReferences).toEqual([]);
    expect(r.samples as number).toBeGreaterThan(0);
    expect(r.sampleUsMax as number).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(r.changes)).toBe(true);
    expect(Array.isArray(r.emitted)).toBe(true);
  });

  test("cursor-probe on the main run loop answers too", async () => {
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    h.send({ cmd: "cursor-probe", seq: 8, ms: 300, onMain: true });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 8), 5000, "cursor-probe reply");
    expect(r.ev).toBe("cursor-probe");
    expect(r.thread).toBe("main");
    expect(r.samples as number).toBeGreaterThan(0);
  });

  test("devices lists displays with the fields a picker and a multi-display take need (STC-247)", async () => {
    // How many displays a CI VM has is the machine's business (it may be
    // none); the SHAPE of each entry is ours. originX/Y are the display's place
    // in the global point space anchors.display and CGEvent share.
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    h.send({ cmd: "devices", seq: 9 });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 9), 15_000, "devices reply");
    expect(r.ev).toBe("devices");
    if (r.stalled) return;                       // CoreAudio wedged: reported, not a display fact
    expect(Array.isArray(r.displays)).toBe(true);
    for (const d of r.displays as any[]) {
      expect(Number.isInteger(d.id) && d.id > 0, `id ${d.id}`).toBe(true);
      expect(typeof d.main).toBe("boolean");
      expect(typeof d.name).toBe("string");
      for (const k of ["pointW", "pointH", "pixelW", "pixelH", "originX", "originY"]) {
        expect(typeof d[k], `${k} on display ${d.id}`).toBe("number");
      }
    }
    // At most one main display, when there are any at all.
    expect((r.displays as any[]).filter((d) => d.main).length).toBeLessThanOrEqual(1);
  });

  test("malformed JSON produces a reliable error without wedging the stream", async () => {
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    h.proc.stdin!.write("{not json\n");
    await waitFor(() => h.fd3.find((l) => l.ev === "error" && l.code === "bad-json"), 5000, "bad-json");
    h.send({ cmd: "status", seq: 5 });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 5), 5000, "seq 5 after bad json");
    expect(r.ev).toBe("status");
  });

  test("start's outcome is always reliable and correlated, granted or not", async () => {
    // Deliberately agnostic about whether capture can start here: without a
    // Screen Recording grant `start` answers "error", with one it answers
    // "started". Either way the answer must be on fd3, carry the seq, and
    // never appear on the lossy channel. Capture success is covered by
    // capture.test.ts, which requires the grant.
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    h.send({ cmd: "start", dir: tmpSession(), seq: 10 });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 10), 15_000, "start outcome");
    expect(["started", "error"]).toContain(r.ev);
    expect(h.out.some((l) => l.seq === 10)).toBe(false);
  }, 25_000);
});

describe("lossy channel — stdout stats never back-pressure the capture graph", () => {
  test("stats go to stdout, never to fd3", async () => {
    const h = spawnHelper({ statsIntervalMs: 5 });
    await waitFor(() => find(h.fd3, "ready"));
    await waitFor(() => find(h.out, "stats"), 5000, "stats on stdout");
    expect(find(h.fd3, "stats")).toBeUndefined();
  });

  test("a stalled stdout consumer does not stall the control plane", async () => {
    const h = spawnHelper({ drainStdout: false, statsIntervalMs: 1 });
    await waitFor(() => find(h.fd3, "ready"));
    // hammer the undrained pipe until the OS buffer is full and the ring overflows
    await sleep(2500);
    h.send({ cmd: "status", seq: 99 });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 99), 5000, "status while stdout blocked");
    expect(r.ev).toBe("status");
  }, 20_000);

});

describe("no fd3 — a bare terminal run still works", () => {
  test("responses fall back to stdout so the documented smoke test holds", async () => {
    const h = spawnHelper({ fd3: false });
    const ready = await waitFor(() => find(h.out, "ready"), 5000, "ready on stdout");
    expect(ready.protocol).toBe(1);
    h.send({ cmd: "status", seq: 3 });
    const r = await waitFor(() => h.out.find((l) => l.seq === 3), 5000, "status on stdout");
    expect(r.ev).toBe("status");
  });
});

describe("camera opt-in", () => {
  // The camera is optional and must never fail a recording. Without a grant, or
  // on a machine with no camera, start must still succeed or fail for its own
  // reasons — never because the camera could not be opened.
  test("start with camera:false opens no device and is unaffected", async () => {
    const h = spawnHelper();
    await waitFor(() => h.fd3.find((l) => l.ev === "ready"));
    h.send({ cmd: "start", dir: tmpSession(), camera: false, seq: 1 });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 1), 30_000, "start reply");
    // Either outcome is fine — what must NOT appear is a camera error.
    // (No assertion on `r.camera` here: describe() never emits that field,
    // camera:false or not, so checking it is undefined would pass no matter
    // what this code does — see the flag-comparison test below for coverage
    // that actually depends on the flag's value.)
    expect(String(r.code ?? "")).not.toMatch(/^camera-/);
  }, 60_000);

  test("an unopenable camera warns and does not fail the start", async () => {
    const h = spawnHelper();
    await waitFor(() => h.fd3.find((l) => l.ev === "ready"));
    h.send({ cmd: "start", dir: tmpSession(), camera: true, seq: 1 });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 1), 30_000, "start reply");
    // On a machine with a camera AND a grant this still succeeds — but never
    // with a device name here. The camera now opens on a background queue
    // (Capture.swift's startCameraAsync) so it never delays this reply, and
    // its outcome is reported later as its own "camera-started"/"warning"
    // event instead of being folded into "started". Without a camera or grant
    // this warns. Both are correct. A start that FAILS because of the camera
    // is not.
    expect(String(r.code ?? "")).not.toMatch(/^camera-/);
  }, 60_000);

  test("the camera flag does not change how or whether start succeeds", async () => {
    // The two tests above pass vacuously on any machine without a Screen
    // Recording grant (every CI run): start fails with "no-displays" before
    // the camera path is ever reached, so a camera-flag bug that perturbed
    // that path would never be exercised. This assertion needs no grant and
    // would catch exactly that: run start twice, once per flag value, and
    // check that the flag played no part in the outcome — on EITHER branch,
    // not just the ungranted one.
    const h1 = spawnHelper();
    await waitFor(() => h1.fd3.find((l) => l.ev === "ready"));
    h1.send({ cmd: "start", dir: tmpSession(), camera: false, seq: 1 });
    const r1 = await waitFor(() => h1.fd3.find((l) => l.seq === 1), 30_000, "start reply (camera:false)");

    const h2 = spawnHelper();
    await waitFor(() => h2.fd3.find((l) => l.ev === "ready"));
    h2.send({ cmd: "start", dir: tmpSession(), camera: true, seq: 1 });
    const r2 = await waitFor(() => h2.fd3.find((l) => l.seq === 1), 30_000, "start reply (camera:true)");

    if (r1.ev === "error" && r2.ev === "error") {
      // No grant (every CI run): both fail before the camera path is ever
      // reached, so identical failures are the proof the flag took no part.
      expect(r2.code).toBe(r1.code);
      expect(r2.detail).toBe(r1.detail);
    } else if (r1.ev === "started" && r2.ev === "started") {
      // Granted machine: both succeed, which is just as meaningful — the
      // camera flag must not perturb DISPLAY capture setup. The reported
      // display geometry must be identical whether or not a camera was
      // also requested.
      expect(r2.capture).toEqual(r1.capture);
      expect(r2.source).toEqual(r1.source);
      expect(r2.display).toBe(r1.display);
    } else {
      // A MIXED outcome — one call started, the other errored — is exactly
      // the bug this test exists to catch: the camera flag changed whether
      // display capture itself succeeded, which it must never do.
      throw new Error(
        `camera flag changed whether start succeeded: camera:false -> ${r1.ev}` +
        ` (${r1.code ?? "no code"}), camera:true -> ${r2.ev} (${r2.code ?? "no code"})`);
    }
  }, 90_000);
});

describe("capture-still — validation answers on fd3 before anything touches ScreenCaptureKit (STC-289)", () => {
  // These need no grant: every case is refused by parseStillRequest, which
  // runs before content enumeration. Each answer must carry the seq, name a
  // code, and never appear on the lossy channel.
  const cases: Array<[string, object, string]> = [
    ["no dir", { cmd: "capture-still" }, "missing-dir"],
    ["unknown kind", { cmd: "capture-still", dir: tmpSession(), kind: "region" }, "bad-kind"],
    ["window without windowId", { cmd: "capture-still", dir: tmpSession(), kind: "window" }, "missing-window-id"],
    ["window with a crop", { cmd: "capture-still", dir: tmpSession(), kind: "window", windowId: 1,
                             crop: { x: 0, y: 0, width: 1, height: 1 } }, "crop-on-window"],
    ["zero-size crop", { cmd: "capture-still", dir: tmpSession(), crop: { x: 0, y: 0, width: 0, height: 10 } }, "bad-crop"],
    ["file that is a path", { cmd: "capture-still", dir: tmpSession(), file: "../out.png" }, "bad-file"],
  ];
  for (const [name, cmd, code] of cases) {
    test(`${name} -> ${code}`, async () => {
      const h = spawnHelper();
      await waitFor(() => find(h.fd3, "ready"));
      h.send({ ...cmd, seq: 31 });
      const r = await waitFor(() => h.fd3.find((l) => l.seq === 31), 5000, `seq 31 (${name})`);
      expect(r.ev).toBe("error");
      expect(r.code).toBe(code);
      expect(typeof r.detail).toBe("string");
      expect(h.out.some((l) => l.seq === 31)).toBe(false);
    });
  }

  test("a well-formed still's outcome is always reliable and correlated, granted or not", async () => {
    // Agnostic about the grant, like the `start` case above: without Screen
    // Recording it answers `error` (no-displays), on a pre-14 OS
    // `still-unsupported`, and with a grant `still`. Whichever it is, the
    // answer is on fd3 with the seq, the helper is still idle afterwards
    // (a still never touches recording state), and it answered within its
    // own bound — StillCapture.timeoutSeconds — rather than the client's.
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    const dir = tmpSession();
    h.send({ cmd: "capture-still", dir, seq: 32 });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 32), 12_000, "still outcome");
    expect(["still", "error"]).toContain(r.ev);
    if (r.ev === "error") {
      expect(["no-displays", "still-unsupported", "capture-failed"]).toContain(r.code);
    } else {
      expect(r.file).toBe("frame.png");
      expect((r.shot as any).version).toBe(1);
    }
    expect(h.out.some((l) => l.seq === 32)).toBe(false);
    h.send({ cmd: "status", seq: 33 });
    const s = await waitFor(() => h.fd3.find((l) => l.seq === 33), 5000, "status after still");
    expect(s.state).toBe("idle");
  }, 20_000);

  test("windows answers reliably, granted or not", async () => {
    const h = spawnHelper();
    await waitFor(() => find(h.fd3, "ready"));
    h.send({ cmd: "windows", seq: 34 });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 34), 12_000, "windows outcome");
    expect(["windows", "error"]).toContain(r.ev);
    if (r.ev === "windows") expect(Array.isArray(r.windows)).toBe(true);
    else expect(r.code).toBe("no-displays");
  }, 20_000);
});
