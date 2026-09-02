import { describe, test, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HelperClient } from "../src/helper-client.js";
import { HelperSupervisor } from "../src/supervisor.js";

/**
 * Deaths that do not go through `exit`.
 *
 * Needs no helper binary, and deliberately so: these are the failures that
 * happen when there ISN'T one. `spawn` of a path that does not exist emits an
 * `error` event on the child and may never emit `exit`; a write to the stdin
 * of a helper that has just died is EPIPE, also an `error` event. An `error`
 * event with no listener is an uncaught exception, and in the Electron main
 * process that is the whole app dying — before this, a missing helper binary
 * took the app down with no window ever shown, and a Stop clicked in the
 * instant after a helper crash could do the same.
 */
const live: { kill(): void }[] = [];
afterEach(() => { for (const c of live.splice(0)) c.kill(); });

/** An executable that exits at once without reading stdin. */
function dyingBinary(): string {
  const dir = mkdtempSync(join(tmpdir(), "stc-dying-"));
  const bin = join(dir, "helper");
  writeFileSync(bin, "#!/bin/sh\nexit 3\n");
  chmodSync(bin, 0o755);
  return bin;
}

describe("HelperClient — deaths that bypass `exit`", () => {
  test("a binary that cannot be spawned is reported as an exit, not thrown", async () => {
    const c = HelperClient.spawn("/nonexistent/stc-helper");
    live.push(c);
    const info = await c.waitForExit();
    expect(info).toEqual({ code: null, signal: null });
    expect(c.recentStderr).toMatch(/ENOENT/);
    await expect(c.ready(5_000)).rejects.toThrow(/ENOENT/);
    await expect(c.request("status")).rejects.toThrow(/helper already exited/);
  });

  test("a ready() already waiting is rejected by the death, not by its own timer", async () => {
    const c = HelperClient.spawn("/nonexistent/stc-helper");
    live.push(c);
    const started = Date.now();
    await expect(c.ready(10_000)).rejects.toThrow(/ENOENT/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a request written to a helper that has just died rejects instead of raising EPIPE", async () => {
    const c = HelperClient.spawn(dyingBinary());
    live.push(c);
    // Fire the write immediately: the pipe closes as the child exits, so the
    // write lands on a dead stdin. Without a stdin `error` listener this is an
    // uncaught exception in whatever process owns the client.
    await expect(c.request("status", {}, { timeoutMs: 5_000 })).rejects.toThrow(/helper exited \(code 3/);
    await c.waitForExit();
  });
});

describe("HelperSupervisor — a helper that cannot start at all", () => {
  test("gives up with the spawn error in hand rather than crashing the app", async () => {
    const s = HelperSupervisor.start("/nonexistent/stc-helper", { maxRestarts: 1, restartWindowMs: 60_000 });
    live.push({ kill: () => void s.shutdown() });
    const gaveUp = await new Promise<any>((res) => s.on("gave-up", res));
    expect(s.state).toBe("failed");
    expect(gaveUp.restarts).toBe(2);
    expect(gaveUp.stderr).toMatch(/ENOENT/);
  });
});
