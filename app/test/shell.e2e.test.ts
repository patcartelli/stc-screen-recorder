import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..", "..");

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

async function launch() {
  execFileSync("node", [join(root, "app", "build.mjs")], { cwd: root, stdio: "pipe" });
  // Never write takes to the real ~/Desktop/stc from an automated run.
  app = await electron.launch({
    args: [root], cwd: root,
    env: { ...process.env, STC_RECORDINGS_DIR: mkdtempSync(join(tmpdir(), "stc-e2e-")) },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  return win;
}

describe("Electron shell", () => {
  test("launches, spawns the helper, and reports it ready", async () => {
    const win = await launch();
    await expect.poll(() => win.textContent("#pid"), { timeout: 20_000 })
      .toMatch(/^\d+$/);                                  // a real helper pid
    expect(await win.textContent("#state")).toBe("idle");
    expect(await win.textContent("h1")).toBe("stc recorder");
  }, 60_000);

  test("live stats arrive from the lossy channel while idle", async () => {
    const win = await launch();
    await expect.poll(() => win.textContent("#pid"), { timeout: 20_000 }).toMatch(/^\d+$/);
    // The heartbeat runs from boot, so an idle helper is observably alive even
    // though it reports no frame counts (there is no capture session yet).
    await expect.poll(() => win.textContent("#alive"), { timeout: 15_000 }).toBe("idle");
  }, 60_000);

  test("the record button reports a missing grant in actionable terms", async () => {
    const win = await launch();
    await expect.poll(() => win.textContent("#pid"), { timeout: 20_000 }).toMatch(/^\d+$/);
    await win.click("#record");
    // Either it records (granted) or it explains itself (not granted) —
    // what it must never do is fail silently or hang the button.
    await expect.poll(async () =>
      (await win.textContent("#state")) === "recording" ||
      (await win.locator("#alert").isVisible()), { timeout: 30_000 }).toBe(true);

    if (await win.locator("#alert").isVisible()) {
      const msg = await win.textContent("#alert");
      expect(msg).toMatch(/Screen Recording permission|Could not start/);
      expect(await win.locator("#record").isDisabled()).toBe(false);  // still usable
    } else {
      expect(await win.textContent("#record")).toBe("Stop");
    }
  }, 90_000);
});
