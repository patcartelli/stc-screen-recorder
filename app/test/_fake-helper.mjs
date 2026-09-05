#!/usr/bin/env node
/**
 * A helper stand-in that can actually be recording.
 *
 * The real helper cannot record without a Screen Recording grant, which CI has
 * no way to give. Faking the supervisor's state against a live, idle helper is
 * not a substitute: the supervisor treats the heartbeat as the authority and
 * heals any disagreement, so the fake gets undone the moment a stats line
 * lands — green on a fast machine, red on a loaded CI VM (STC-260).
 *
 * This speaks enough of the protocol for the supervisor to drive its real
 * recording path, and its heartbeat reports the state it was actually asked
 * for. It is a stand-in for the helper's CONTROL PLANE only; it captures
 * nothing, and no test may use it to make claims about capture.
 */
import { writeSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const i = argv.indexOf("--stats-interval-ms");
const statsIntervalMs = i >= 0 ? Math.max(1, Number(argv[i + 1]) || 2000) : 2000;

let state = "idle";
let session = null;

/** fd3 = reliable: responses and lifecycle. */
const send = (ev, o = {}) => writeSync(3, JSON.stringify({ ev, ...o }) + "\n");
/** stdout = lossy: stats only. */
const stat = (o) => process.stdout.write(JSON.stringify({ ev: "stats", ...o }) + "\n");

setInterval(() => stat({ state, ...(state === "recording" ? { elapsedMs: 0 } : {}) }),
            statsIntervalMs).unref?.();

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let n;
  while ((n = buf.indexOf("\n")) >= 0) {
    const raw = buf.slice(0, n).trim();
    buf = buf.slice(n + 1);
    if (!raw) continue;
    let cmd;
    try { cmd = JSON.parse(raw); } catch { continue; }
    const seq = cmd.seq;
    // Every command, in arrival order, when a test asks. The ORDER is the
    // subject for the quit path: a stop must reach the helper before the quit
    // does, or the take in flight is lost.
    if (process.env.STC_FAKE_CMD_LOG) {
      try { writeFileSync(process.env.STC_FAKE_CMD_LOG, String(cmd.cmd) + "\n", { flag: "a" }); }
      catch { /* a test seam is not worth killing the stand-in */ }
    }
    switch (cmd.cmd) {
      case "status":
        send("status", { seq, state, session });
        break;
      case "start":
        state = "recording";
        session = cmd.dir ?? null;
        // The start payload, when a test asks for it. Whether `camera` actually
        // reaches the helper is the whole of the app-toggle feature, and
        // nothing else in the suite can see it.
        if (process.env.STC_FAKE_START_LOG) {
          try { writeFileSync(process.env.STC_FAKE_START_LOG, JSON.stringify(cmd) + "\n", { flag: "a" }); }
          catch { /* a test seam is not worth killing the stand-in */ }
        }
        send("started", { seq, session });
        // STC-287. The real helper opens the camera OFF the critical path, so
        // `started` goes out first and the camera reports separately, a beat
        // later — success and failure both. That ordering is the whole subject:
        // a stand-in that announced the camera inside `started` could not
        // reproduce the window the user complains about.
        if (process.env.STC_FAKE_CAMERA === "noframes") {
          // The real shape: started FIRST, with a device name, and only later
          // the admission that nothing is arriving. A stand-in that skipped the
          // camera-started could not reproduce the window where the app
          // confidently displays a working camera.
          setTimeout(() => send("camera-started", { device: "FaceTime HD Camera" }), 40);
          setTimeout(() => send("warning", {
            code: "camera-no-frames", device: "FaceTime HD Camera",
            detail: "fake: opened but delivered nothing",
          }), 120);
        } else if (process.env.STC_FAKE_CAMERA === "fail") {
          setTimeout(() => send("warning", {
            code: "camera-failed", detail: "fake: the device could not be opened",
          }), 40);
        } else if (process.env.STC_FAKE_CAMERA) {
          setTimeout(() => send("camera-started", { device: process.env.STC_FAKE_CAMERA }), 40);
        }
        // Any warning code, after `started` — the real helper reports a tap it
        // could not install, or a stream that died, as a warning on the
        // reliable channel once the take is already running.
        if (process.env.STC_FAKE_WARNING) {
          setTimeout(() => send("warning", {
            code: process.env.STC_FAKE_WARNING, detail: "fake: a warning the UI must show",
          }), 60);
        }
        // STC-306. The real helper's display stream can die under a live
        // take (`didStopWithError` after `started`). It warns, then ends the
        // take itself: an UNSOLICITED `stopped` — no seq, because no request
        // asked for it — with reason "stream-stopped", and the heartbeat goes
        // idle. The order is the subject: the warning alone used to be all the
        // user got, with the helper still claiming to record.
        const deathMs = Number(process.env.STC_FAKE_STREAM_DEATH_MS) || 0;
        if (deathMs > 0) {
          setTimeout(() => {
            if (state !== "recording") return;
            send("warning", { code: "stream-stopped", detail: "fake: the display stream died" });
            const dir = session;
            state = "idle";
            session = null;
            send("stopped", { dir, elapsedMs: deathMs, reason: "stream-stopped" });
          }, deathMs);
        }
        break;
      case "stop": {
        // A real stop takes hundreds of milliseconds to seconds (finishWriting),
        // and that duration is what the quit path has to survive. Instant, the
        // stand-in cannot tell "waited for the stop" from "did not" — the quit
        // test passed against the broken before-quit until this existed.
        const delay = Number(process.env.STC_FAKE_STOP_DELAY_MS) || 0;
        setTimeout(() => {
          state = "idle";
          session = null;
          send("stopped", { seq, reason: "requested" });
        }, delay);
        break;
      }
      // ── the still path (STC-289/290) ────────────────────────────────────
      case "windows": {
        // A fixed, knowable desktop. The overlay's window mode is only as
        // testable as this list is predictable, and a real window server on a
        // CI runner is neither.
        if (process.env.STC_FAKE_NO_DISPLAYS) {
          send("error", { seq, code: "no-displays", detail: "stand-in has no grant" });
          break;
        }
        send("windows", {
          seq,
          windows: [
            { id: 4711, app: "Finder", title: "Downloads", x: 100, y: 100, width: 400, height: 300, displayId: 1 },
            { id: 4712, app: "Safari", title: "Example", x: 200, y: 150, width: 800, height: 600, displayId: 1 },
          ],
          displays: [{ id: 1, pointWidth: 1920, pointHeight: 1080 }],
        });
        break;
      }
      case "capture-still": {
        if (process.env.STC_FAKE_STILL_ERROR) {
          send("error", { seq, code: process.env.STC_FAKE_STILL_ERROR, detail: "stand-in refused" });
          break;
        }
        // Writes what a real still writes, so the caller's own handling of the
        // directory and the document is exercised rather than stubbed. The
        // REQUEST is logged too: whether the crop, the display id and the
        // overlay exclusion actually reach the helper is the whole of STC-290's
        // hand-off, and nothing else in the suite can see it.
        const dir = cmd.dir;
        try {
          mkdirSync(dir, { recursive: true });
          const width = Math.max(1, Math.round((cmd.crop?.width ?? 1920) * 2));
          const height = Math.max(1, Math.round((cmd.crop?.height ?? 1080) * 2));
          const shot = {
            version: 1,
            kind: cmd.kind === "window" ? "window" : "display-crop",
            capturedAtNs: "1000000000",
            timebase: { numer: 125, denom: 3 },
            display: { id: cmd.displayId ?? 1, pointWidth: 1920, pointHeight: 1080,
                       pixelWidth: 3840, pixelHeight: 2160, backingScale: 2,
                       originX: 0, originY: 0 },
            frame: { file: "frame.png", width, height, alpha: cmd.kind === "window" },
            decoration: { mode: cmd.kind === "window" ? "window-only" : "selected-area",
                          canvas: "natural", cursor: false, redactions: [] },
          };
          if (cmd.kind === "window") {
            shot.window = { id: cmd.windowId, bounds: { x: 100, y: 100, width: 400, height: 300 } };
          } else {
            shot.crop = cmd.crop ?? { x: 0, y: 0, width: 1920, height: 1080 };
          }
          writeFileSync(join(dir, "shot.json"), JSON.stringify(shot, null, 2));
          // A one-pixel PNG: the bytes are never inspected, only the existence.
          writeFileSync(join(dir, "frame.png"), Buffer.from(
            "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001" +
            "0d0a2db40000000049454e44ae426082", "hex"));
          if (process.env.STC_FAKE_STILL_LOG) {
            writeFileSync(process.env.STC_FAKE_STILL_LOG, JSON.stringify(cmd) + "\n", { flag: "a" });
          }
          send("still", { seq, dir, file: "frame.png", shot, timing: { totalMs: 1 } });
        } catch (e) {
          send("error", { seq, code: "write-failed", detail: String(e) });
        }
        break;
      }
      case "quit":
        send("bye", { seq });
        process.exit(0);
      default:
        send("error", { seq, code: "unknown-cmd", detail: String(cmd.cmd) });
    }
  }
});
process.stdin.resume();

send("ready", { pid: process.pid, protocol: 1 });
