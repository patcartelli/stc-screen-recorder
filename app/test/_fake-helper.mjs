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
import { writeSync, writeFileSync } from "node:fs";

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
        if (process.env.STC_FAKE_CAMERA === "fail") {
          setTimeout(() => send("warning", {
            code: "camera-failed", detail: "fake: the device could not be opened",
          }), 40);
        } else if (process.env.STC_FAKE_CAMERA) {
          setTimeout(() => send("camera-started", { device: process.env.STC_FAKE_CAMERA }), 40);
        }
        break;
      case "stop":
        state = "idle";
        session = null;
        send("stopped", { seq, reason: "requested" });
        break;
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
