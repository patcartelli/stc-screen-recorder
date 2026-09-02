import { describe, test, expect, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { HelperSupervisor } from "../src/supervisor.js";
import { withTimeout } from "../../transform/src/timeout.js";

/**
 * Shutting down mid-take must END the take, not abandon it.
 *
 * The helper's own `quit` starts a stop and exits without waiting for it, and
 * the supervisor gave it 2 s before SIGKILL against a 20 s stop bound — so a
 * quit during a recording left display.mp4 unfinalised and the sidecars
 * unwritten, silently. Against the control-plane stand-in, which needs no
 * grant, so this runs anywhere.
 */
const root = join(__dirname, "..", "..");
const FAKE_BIN = join(root, "app", "test", "_fake-helper.mjs");

const live: HelperSupervisor[] = [];
afterEach(async () => { for (const s of live.splice(0)) await s.shutdown(); });

describe("HelperSupervisor.shutdown during a recording", () => {
  test("sends stop, waits for it, and only then quits", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "stc-cmdlog-")), "cmds.txt");
    process.env.STC_FAKE_CMD_LOG = log;
    const s = HelperSupervisor.start(FAKE_BIN, { statsIntervalMs: 25 });
    live.push(s);
    delete process.env.STC_FAKE_CMD_LOG;
    await s.ready();
    await s.startRecording(mkdtempSync(join(tmpdir(), "stc-sup-")));
    await withTimeout(new Promise<void>((res) => {
      const off = s.on("stats", (l) => { if (l.state === "recording") { off(); res(); } });
    }), 2_000, "the stand-in's heartbeat agreeing that it is recording");

    await s.shutdown();
    expect(s.state).toBe("stopped");
    // The ORDER is the claim: stop before quit, and both actually delivered.
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["start", "stop", "quit"]);
  }, 20_000);

  test("an idle helper is simply quit", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "stc-cmdlog-")), "cmds.txt");
    process.env.STC_FAKE_CMD_LOG = log;
    const s = HelperSupervisor.start(FAKE_BIN, { statsIntervalMs: 25 });
    live.push(s);
    delete process.env.STC_FAKE_CMD_LOG;
    await s.ready();
    await s.shutdown();
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["quit"]);
  }, 20_000);
});
