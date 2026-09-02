import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";

/**
 * No helper binary at all — a fresh clone, or a build that failed and left
 * nothing behind. spawn() reports that as an `error` event on the child, and
 * with nobody listening it was an uncaught exception in the main process:
 * Electron's modal error dialog, and an app that never became usable. The
 * app must come up, say the recorder is not starting, and stay usable enough
 * to preview existing takes.
 */
const root = join(__dirname, "..", "..");
let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

describe("a helper binary that does not exist", () => {
  test("shows a window and an alert instead of an uncaught exception", async () => {
    const { dir } = makeTakeFolder();
    app = await electron.launch({
      args: [root], cwd: root,
      env: { ...process.env, STC_RECORDINGS_DIR: dir, STC_HELPER_BIN: "/nonexistent/stc-helper" },
    });
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    await expect.poll(() => win.locator("#alert").isVisible(), { timeout: 30_000 }).toBe(true);
    expect(await win.textContent("#alert")).toMatch(/keeps failing to start/);
    // The library still works: the takes on disk do not need the helper.
    await expect.poll(() => win.textContent("#takes"), { timeout: 20_000 }).toContain("2026-08-24");
  }, 120_000);
});
