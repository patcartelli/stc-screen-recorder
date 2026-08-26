import { describe, test, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const BIN = join(root, "helper", "build", "stc-helper");

// helper binary is built once by vitest.global-setup.ts

const live: ChildProcess[] = [];
afterEach(() => {
  for (const p of live.splice(0)) { try { p.kill("SIGKILL"); } catch { /* already gone */ } }
});

interface Death {
  stderr: string;
  signal: NodeJS.Signals | null;
}

/// Spawns the real helper, waits until it says it is ready, then kills it with
/// `signal` and reports how it died. Every wait is bounded: a helper that never
/// reaches ready, or never exits, must fail the test rather than hang it.
async function killWith(signal: NodeJS.Signals): Promise<Death> {
  const proc = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe"] });
  live.push(proc);

  let stderr = "";
  proc.stderr!.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
  proc.stderr!.resume();

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("helper never reported ready")), 10_000);
    let buf = "";
    proc.stdout!.on("data", (c: Buffer) => {
      buf += c.toString("utf8");
      if (buf.includes('"ready"')) { clearTimeout(timer); resolve(); }
    });
    proc.stdout!.resume();
    proc.on("exit", () => { clearTimeout(timer); reject(new Error("helper exited before ready")); });
  });

  const died = new Promise<Death>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`helper survived ${signal}`)), 10_000);
    proc.on("exit", (_code, sig) => {
      clearTimeout(timer);
      // Give the handler's write(2) a tick to land before reading the tail.
      setTimeout(() => resolve({ stderr, signal: sig }), 50);
    });
  });

  proc.kill(signal);
  return died;
}

describe("crash handlers (STC-254)", () => {
  // Both CI crash reports for STC-254 were EXC_BREAKPOINT/SIGTRAP, not SIGSEGV.
  // With no SIGTRAP handler the helper dies mute and the parent sees a bare
  // signal number — which is exactly the blindness STC-254 part 1 set out to
  // remove, left in place for the variant that actually showed up on CI.
  test("a SIGTRAP death names itself on stderr", async () => {
    const { stderr } = await killWith("SIGTRAP");
    expect(stderr, stderr).toContain("[helper] FATAL signal SIGTRAP");
  }, 30_000);

  test("a SIGSEGV death names itself on stderr", async () => {
    const { stderr } = await killWith("SIGSEGV");
    expect(stderr, stderr).toContain("[helper] FATAL signal SIGSEGV");
  }, 30_000);
});
