import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";

const root = join(__dirname, "..", "..");
let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });


async function launchWithTake() {
  const { dir, takeDir } = makeTakeFolder();
  execFileSync("node", [join(root, "app", "build.mjs")], { cwd: root, stdio: "pipe" });
  app = await electron.launch({
    args: [root], cwd: root, env: { ...process.env, STC_RECORDINGS_DIR: dir },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await expect.poll(() => win.textContent("#takes"), { timeout: 20_000 }).toContain("2026-08-24");
  await win.click("#takes >> text=Preview");
  await expect.poll(() => win.isVisible("#player"), { timeout: 30_000 }).toBe(true);
  return { win, takeDir };
}

/**
 * Waits for the export to REACH A CONCLUSION — done, failed or cancelled — and
 * returns the status plus any alert text. Polling only for success meant a
 * failure burned the full 10-minute timeout and then reported nothing about
 * the cause; the reason was sitting in the alert the whole time.
 */
async function settledStatus(win: any): Promise<{ text: string; alert: string }> {
  await expect.poll(async () => {
    const t = (await win.textContent("#exportstatus")) ?? "";
    return /^Done —/.test(t) || t === "Failed." || t === "Cancelled.";
  }, { timeout: 600_000 }).toBe(true);
  return {
    text: (await win.textContent("#exportstatus")) ?? "",
    alert: (await win.locator("#alert").isVisible())
      ? ((await win.textContent("#alert")) ?? "(no alert)")
      : "(no alert shown)",
  };
}

describe("export from the app", () => {
  test("exports a playable file and a manifest, with progress", async () => {
    const { win, takeDir } = await launchWithTake();
    await win.click("#export");
    const status = await settledStatus(win);
    expect(status.text, `export did not finish: ${status.alert}`).toMatch(/^Done —/);

    const mp4 = join(takeDir, "export-2026-08-24_10-00-00.mp4");
    const manifest = join(takeDir, "export-2026-08-24_10-00-00.json");
    expect(existsSync(mp4), "exported mp4 missing").toBe(true);
    expect(existsSync(manifest), "manifest missing").toBe(true);
    expect(statSync(mp4).size).toBeGreaterThan(100_000);

    const m = JSON.parse(readFileSync(manifest, "utf8"));
    expect(m.frames).toBeGreaterThan(0);
    expect(m.preEncodeHash).toMatch(/^[0-9a-f]{64}$/);
  }, 900_000);

test("cancel stops the export instead of running to completion", async () => {
    const { win } = await launchWithTake();
    await win.click("#export");
    await expect.poll(() => win.textContent("#exportstatus"), { timeout: 60_000 })
      .toMatch(/frames/);                       // it started
    await win.click("#cancelexport");
    await expect.poll(() => win.textContent("#exportstatus"), { timeout: 60_000 })
      .toBe("Cancelled.");
    // And the window is still usable — a cancel that wedges the app is no cancel.
    expect(await win.locator("#export").isDisabled()).toBe(false);
  }, 300_000);
});
