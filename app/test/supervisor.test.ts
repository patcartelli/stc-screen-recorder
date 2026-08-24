import { describe, test, expect, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { HelperSupervisor } from "../src/supervisor.js";

const root = join(__dirname, "..", "..");
const BIN = join(root, "helper", "build", "stc-helper");

const live: HelperSupervisor[] = [];
afterEach(async () => { for (const s of live.splice(0)) await s.shutdown(); });

function sup(opts: Parameters<typeof HelperSupervisor.start>[1] = {}) {
  const s = HelperSupervisor.start(BIN, { statsIntervalMs: 25, ...opts });
  live.push(s);
  return s;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const session = () => mkdtempSync(join(tmpdir(), "stc-sup-"));

describe("HelperSupervisor — keeping a helper alive", () => {
  test("comes up ready and reports idle", async () => {
    const s = sup();
    await s.ready();
    expect(s.state).toBe("idle");
  });

  test("respawns after an unexpected death and becomes usable again", async () => {
    const s = sup();
    await s.ready();
    const firstPid = s.pid;
    const respawned = new Promise<void>((res) => s.on("respawned", () => res()));
    s.killForTest();
    await respawned;
    await s.ready();
    expect(s.pid).not.toBe(firstPid);
    const r = await s.client!.request("status");
    expect(r.state).toBe("idle");
  }, 20_000);

  test("a crash mid-recording surfaces as a lost recording, not a silent reset", async () => {
    const s = sup();
    await s.ready();
    // Force the supervisor to believe a recording is in flight, then kill.
    s.markRecordingForTest(session());
    const lost: unknown[] = [];
    s.on("recording-lost", (e) => lost.push(e));
    const respawned = new Promise<void>((res) => s.on("respawned", () => res()));
    s.killForTest();
    await respawned;
    expect(lost.length).toBe(1);
  }, 20_000);

  test("stops respawning after repeated rapid failures instead of looping forever", async () => {
    const s = sup({ maxRestarts: 2, restartWindowMs: 60_000 });
    await s.ready();
    const gaveUp = new Promise<void>((res) => s.on("gave-up", () => res()));
    for (let i = 0; i < 4; i++) {
      s.killForTest();
      await sleep(400);
    }
    await gaveUp;
    expect(s.state).toBe("failed");
  }, 30_000);

  test("shutdown is deliberate — it does not trigger a respawn", async () => {
    const s = sup();
    await s.ready();
    let respawns = 0;
    s.on("respawned", () => respawns++);
    await s.shutdown();
    await sleep(400);
    expect(respawns).toBe(0);
    expect(s.state).toBe("stopped");
  }, 20_000);
});

describe("HelperSupervisor — recording lifecycle", () => {
  test("start failure is reported without wedging the supervisor", async () => {
    const s = sup();
    await s.ready();
    const dir = session();
    const res = await s.startRecording(dir).catch((e) => e);
    if (res instanceof Error) {
      // no Screen Recording grant here: must stay usable
      expect(s.state).toBe("idle");
      const st = await s.client!.request("status");
      expect(st.state).toBe("idle");
    } else {
      expect(s.state).toBe("recording");
      const stopped = await s.stopRecording();
      expect(stopped.ev).toBe("stopped");
      expect(existsSync(join(dir, "display.mp4"))).toBe(true);
    }
  }, 40_000);
});

describe("HelperSupervisor — the helper can stop itself", () => {
  test("reconciles when the helper stops on its own (e.g. display reconfigured)", async () => {
    // A display change makes the helper stop cleanly and emit an unsolicited
    // `stopped`. Nothing asked for it, so a supervisor that only updates state
    // inside stopRecording() stays stuck believing it is recording — the UI
    // keeps offering Stop, and pressing it returns "bad-state: not recording".
    // Observed for real during the increment-5 display-change test.
    const s = sup();
    await s.ready();
    s.markRecordingForTest("/tmp/whatever");
    expect(s.state).toBe("recording");

    const notified = new Promise<any>((res) => s.on("recording-ended", res));
    // The heartbeat reports the helper's own state, which is the backstop for
    // any desync — not just this one.
    const info = await notified;
    expect(info.reason).toBeDefined();
    expect(s.state).toBe("idle");
  }, 20_000);
});
