import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";

/**
 * Quitting the app mid-take ends the take before the helper goes.
 *
 * Through the real app rather than the supervisor alone, because the defect
 * had two halves and the second lived in main.ts: `before-quit`'s listener was
 * async and Electron does not await one, so even a supervisor that stopped the
 * recording correctly would have been killed by the quit proceeding underneath
 * it. The stand-in logs every command it receives; the assertion is the ORDER.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

describe("quitting while recording", () => {
  test("stops the recording, waits for the stop, then quits the helper", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "stc-cmdlog-")), "cmds.txt");
    const { dir: recordings } = makeTakeFolder();
    app = await electron.launch({
      args: [root, `--user-data-dir=${mkdtempSync(join(tmpdir(), "stc-ud-"))}`],
      cwd: root,
      env: { ...process.env, STC_RECORDINGS_DIR: recordings, STC_HELPER_BIN: FAKE_HELPER,
             // Slow enough that a quit which does not wait for the stop leaves
             // the process before the quit command is ever written.
             STC_FAKE_CMD_LOG: log, STC_FAKE_STOP_DELAY_MS: "1500" },
    });
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    await expect.poll(() => win.isEnabled("#record"), { timeout: 30_000 }).toBe(true);
    await win.click("#record");
    await expect.poll(() => win.textContent("#state"), { timeout: 30_000 }).toBe("recording");

    // Playwright's close() quits the app the way Cmd-Q does: through app.quit()
    // and the before-quit listener.
    await app.close();
    app = undefined;

    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["start", "stop", "quit"]);
  }, 120_000);
});
