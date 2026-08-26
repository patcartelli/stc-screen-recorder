import { describe, test, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const BIN = join(__dirname, "..", "build", "stc-helper");
const live: ChildProcess[] = [];
afterEach(() => { for (const p of live.splice(0)) { try { p.kill("SIGKILL"); } catch { /* gone */ } } });

const VALID = ["notDetermined", "restricted", "denied", "authorized", "unknown"];

describe("camera-probe", () => {
  // Reports only. Opening a device here would light the LED during `npm test`.
  test("answers with a valid authorization status and a device list", async () => {
    const proc = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe"] });
    live.push(proc);
    proc.stderr!.resume();

    const reply = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no camera-probe reply within 10s")), 10_000);
      let buf = "";
      proc.stdout!.on("data", (c: Buffer) => {
        buf += c.toString("utf8");
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let msg: any;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.ev === "ready") proc.stdin!.write(JSON.stringify({ cmd: "camera-probe", seq: 1 }) + "\n");
          if (msg.ev === "camera-probe") { clearTimeout(timer); resolve(msg); }
        }
      });
      proc.stdout!.resume();
    });

    expect(VALID, `unexpected auth: ${reply.auth}`).toContain(reply.auth);
    expect(Array.isArray(reply.devices)).toBe(true);
    expect(reply.seq).toBe(1);
  }, 30_000);
});
