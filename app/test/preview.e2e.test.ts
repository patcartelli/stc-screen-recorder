import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";


import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { makeTakeFolder, makePipTakeFolder } from "./_take-fixture.js";

const root = join(__dirname, "..", "..");
let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });


async function launchWithTake() {
  const { dir, takeDir } = makeTakeFolder();
  // The bundle is built once in vitest.global-setup.ts. Building it here
  // raced every other suite doing the same on app/dist/ — see that file.
  app = await electron.launch({
    args: [root], cwd: root,
    env: { ...process.env, STC_RECORDINGS_DIR: dir },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await expect.poll(() => win.textContent("#takes"), { timeout: 20_000 }).toContain("2026-08-24");
  return { win, takeDir };
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
  // The regression this exists for: the app could not open a take with a
  // camera AT ALL. loadSession refuses a claimed camera with no file supplied,
  // and the renderer never supplied one — so every real PiP take died at load.
  // The determinism gate could not see it, because the gate has its own loader.
  test("a take with a camera track opens instead of failing to load", async () => {
    const { dir } = makePipTakeFolder();
    // The bundle is built once in vitest.global-setup.ts. Building it here
    // raced every other suite doing the same on app/dist/ — see that file.
    app = await electron.launch({
      args: [root], cwd: root,
      env: { ...process.env, STC_RECORDINGS_DIR: dir },
    });
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    await expect.poll(() => win.textContent("#takes"), { timeout: 20_000 }).toContain("2026-08-26");

    await win.click("#takes >> text=Preview");
    await expect.poll(() => win.isVisible("#player"), { timeout: 30_000 }).toBe(true);
    // Real pixels, not an empty canvas — a failed load leaves the stage black.
    await expect.poll(() => inkiness(win), { timeout: 30_000 }).toBeGreaterThan(0.2);
  }, 120_000);


  test("opening a take renders actual video, not an empty canvas", async () => {
    const { win } = await launchWithTake();
    await win.click("#takes >> text=Preview");
    await expect.poll(() => win.isVisible("#player"), { timeout: 30_000 }).toBe(true);
    // A black canvas would satisfy "the element exists"; require real pixels.
    await expect.poll(() => inkiness(win), { timeout: 30_000 }).toBeGreaterThan(0.2);
    expect(await win.textContent("#clock")).toMatch(/0:00 \/ \d+:\d\d/);
  }, 120_000);

  test("scrubbing changes the displayed frame", async () => {
    const { win } = await launchWithTake();
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

  // A scrub is a burst of input events. The last one very often lands while
  // the previous draw is still awaiting the decoder, and a draw that was
  // simply dropped there left the canvas on an earlier frame while the clock
  // said the later one. Fired from inside the page so the burst is genuinely
  // back-to-back: with the old player the canvas settles on the FIRST value's
  // frame and never moves.
  test("a burst of scrub events ends on the frame of the last one", async () => {
    const { win } = await launchWithTake();
    await win.click("#takes >> text=Preview");
    await expect.poll(() => inkiness(win), { timeout: 30_000 }).toBeGreaterThan(0.2);

    const stageHash = () => win.evaluate(() => {
      const c = document.getElementById("stage") as HTMLCanvasElement;
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i]! + d[i + 1]! + d[i + 2]!) >>> 0;
      return h;
    });

    // The reference: one clean seek to the final value.
    await win.fill("#scrub", "700");
    await win.dispatchEvent("#scrub", "input");
    await expect.poll(() => win.textContent("#clock"), { timeout: 20_000 }).not.toMatch(/^0:00 /);
    await new Promise((r) => setTimeout(r, 500));
    const expected = await stageHash();

    // Back to the start, then the burst, all in one tick of the page's loop.
    await win.fill("#scrub", "0");
    await win.dispatchEvent("#scrub", "input");
    await new Promise((r) => setTimeout(r, 500));
    expect(await stageHash()).not.toBe(expected);
    await win.evaluate(() => {
      const s = document.getElementById("scrub") as HTMLInputElement;
      for (let v = 100; v <= 700; v += 25) {
        s.value = String(v);
        s.dispatchEvent(new Event("input"));
      }
    });
    await expect.poll(stageHash, { timeout: 10_000 }).toBe(expected);
  }, 120_000);

  test("play advances the clock and pause stops it", async () => {
    const { win } = await launchWithTake();
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

  test("in/out markers persist as project.trim and survive reopen", async () => {
    const { win, takeDir } = await launchWithTake();
    await win.click("#takes >> text=Preview");
    await expect.poll(() => win.isVisible("#player"), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => win.textContent("#triminfo"), { timeout: 10_000 }).toMatch(/Full take/);

    await win.fill("#scrub", "200");
    await win.dispatchEvent("#scrub", "input");
    await expect.poll(() => win.textContent("#clock"), { timeout: 20_000 }).not.toMatch(/^0:00 /);
    await win.click("#markin");
    await win.fill("#scrub", "400");
    await win.dispatchEvent("#scrub", "input");
    await win.click("#markout");

    await expect.poll(() => win.textContent("#triminfo"), { timeout: 10_000 }).toMatch(/–/);
    await expect.poll(() => win.textContent("#triminfo"), { timeout: 10_000 }).toMatch(/to export/);
    await expect.poll(() => existsSync(join(takeDir, "project.json")), { timeout: 10_000 }).toBe(true);
    const project = JSON.parse(readFileSync(join(takeDir, "project.json"), "utf8"));
    expect(project.trim.startNs).toBeGreaterThan(0);
    expect(project.trim.endNs).toBeGreaterThan(project.trim.startNs);

    await win.click("#closepreview");
    await expect.poll(() => win.isVisible("#player"), { timeout: 10_000 }).toBe(false);
    await win.click("#takes >> text=Preview");
    await expect.poll(() => win.textContent("#triminfo"), { timeout: 30_000 }).toMatch(/–/);

    await win.click("#resettrim");
    await expect.poll(() => win.textContent("#triminfo"), { timeout: 10_000 }).toMatch(/Full take/);
  }, 120_000);
});
