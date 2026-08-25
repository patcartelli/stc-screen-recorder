import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";


import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";

const root = join(__dirname, "..", "..");
let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });


async function launchWithTake() {
  const { dir } = makeTakeFolder();
  execFileSync("node", [join(root, "app", "build.mjs")], { cwd: root, stdio: "pipe" });
  app = await electron.launch({
    args: [root], cwd: root,
    env: { ...process.env, STC_RECORDINGS_DIR: dir },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await expect.poll(() => win.textContent("#takes"), { timeout: 20_000 }).toContain("2026-08-24");
  return win;
}

/** Fraction of sampled pixels that are not pure black. */
async function inkiness(win: any): Promise<number> {
  return win.evaluate(() => {
    const c = document.getElementById("stage") as HTMLCanvasElement;
    const ctx = c.getContext("2d")!;
    const w = c.width, h = c.height;
    let lit = 0, n = 0;
    for (let y = 0; y < h; y += Math.max(1, Math.floor(h / 40))) {
      for (let x = 0; x < w; x += Math.max(1, Math.floor(w / 40))) {
        const p = ctx.getImageData(x, y, 1, 1).data;
        if (p[0]! + p[1]! + p[2]! > 24) lit++;
        n++;
      }
    }
    return lit / n;
  });
}

describe("preview player in the app", () => {
  test("opening a take renders actual video, not an empty canvas", async () => {
    const win = await launchWithTake();
    await win.click("#takes >> text=Preview");
    await expect.poll(() => win.isVisible("#player"), { timeout: 30_000 }).toBe(true);
    // A black canvas would satisfy "the element exists"; require real pixels.
    await expect.poll(() => inkiness(win), { timeout: 30_000 }).toBeGreaterThan(0.2);
    expect(await win.textContent("#clock")).toMatch(/0:00 \/ \d+:\d\d/);
  }, 120_000);

  test("scrubbing changes the displayed frame", async () => {
    const win = await launchWithTake();
    await win.click("#takes >> text=Preview");
    await expect.poll(() => inkiness(win), { timeout: 30_000 }).toBeGreaterThan(0.2);

    const frameHash = () => win.evaluate(() => {
      const c = document.getElementById("stage") as HTMLCanvasElement;
      return c.getContext("2d")!.getImageData(0, 0, 64, 64).data.join(",");
    });
    const atStart = await frameHash();
    await win.fill("#scrub", "700");
    await win.dispatchEvent("#scrub", "input");
    await expect.poll(async () => (await frameHash()) !== atStart, { timeout: 30_000 }).toBe(true);
    expect(await win.textContent("#clock")).not.toMatch(/^0:00 /);
  }, 120_000);

  test("play advances the clock and pause stops it", async () => {
    const win = await launchWithTake();
    await win.click("#takes >> text=Preview");
    await expect.poll(() => inkiness(win), { timeout: 30_000 }).toBeGreaterThan(0.2);

    await win.click("#playpause");
    await expect.poll(() => win.textContent("#clock"), { timeout: 20_000 }).not.toMatch(/^0:00 /);
    await win.click("#playpause");
    // Wait for the UI to CONFIRM the pause rather than for a fixed delay. The
    // click, the last in-flight frame and the repaint are all async, so a
    // timeout is a race wearing a wait's clothing — it passed alone and failed
    // under the load of a full suite run, which is how it hid for two phases.
    await expect.poll(() => win.textContent("#playpause"), { timeout: 20_000 }).toBe("Play");
    // One more frame may already have been in flight when pause landed; let it
    // finish, then require the clock to be genuinely still.
    await expect.poll(async () => {
      const a = await win.textContent("#clock");
      await new Promise((r) => setTimeout(r, 250));
      return a === (await win.textContent("#clock"));
    }, { timeout: 20_000 }).toBe(true);

    const stopped = await win.textContent("#clock");
    await new Promise((r) => setTimeout(r, 900));
    expect(await win.textContent("#clock")).toBe(stopped);   // paused really is paused
  }, 120_000);
});
