import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";

/**
 * STC-298: the frame the playhead is on, as a PNG, copied or saved.
 *
 * The identity claim is checked from the outside: the saved PNG, decoded back
 * in the page, must be pixel-identical to the stage canvas, and the stage is
 * what render() + composite() painted for the export-grid frame the still was
 * snapped to. The grid arithmetic itself is unit-tested in transform/test.
 */
const root = join(__dirname, "..", "..");
let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

async function openTake() {
  const { dir, takeDir } = makeTakeFolder();
  app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, STC_RECORDINGS_DIR: dir } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await expect.poll(() => win.textContent("#takes"), { timeout: 20_000 }).toContain("2026-08-24");
  await win.click("#takes >> text=Preview");
  await expect.poll(() => win.isVisible("#player"), { timeout: 30_000 }).toBe(true);
  return { win, takeDir };
}

/** Decodes a PNG in the page and compares it to the stage, pixel by pixel. */
async function pngMatchesStage(win: any, pngBase64: string): Promise<{ same: boolean; width: number; height: number; differing: number }> {
  return win.evaluate(async (b64: string) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const stage = document.getElementById("stage") as HTMLCanvasElement;
    const a = stage.getContext("2d")!.getImageData(0, 0, stage.width, stage.height).data;
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = c.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    const b = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let differing = 0;
    if (a.length === b.length) { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differing++; }
    else differing = -1;
    return { same: differing === 0, width: bitmap.width, height: bitmap.height, differing };
  }, pngBase64);
}

describe("the current preview frame as a PNG", () => {
  test("Save frame writes a PNG beside the take that is pixel-identical to the stage", async () => {
    const { win, takeDir } = await openTake();
    await win.fill("#scrub", "437");
    await win.dispatchEvent("#scrub", "input");
    await expect.poll(() => win.textContent("#clock"), { timeout: 20_000 }).not.toMatch(/^0:00 /);

    await win.click("#saveframe");
    await expect.poll(() => win.textContent("#framestatus"), { timeout: 20_000 }).toMatch(/^Saved frame at/);
    const pngs = readdirSync(takeDir).filter((f) => /^frame-2026-08-24_10-00-00-\d+ms\.png$/.test(f));
    expect(pngs).toHaveLength(1);
    // Saved on the 60 fps export grid: the millisecond stamp is a multiple of a frame (16.67 ms, rounded).
    const ms = Number(pngs[0]!.match(/-(\d+)ms\.png$/)![1]);
    const frame = Math.round((ms * 60) / 1000);
    expect(Math.abs(ms - (frame * 1000) / 60)).toBeLessThan(1);

    const png = readFileSync(join(takeDir, pngs[0]!));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const r = await pngMatchesStage(win, png.toString("base64"));
    expect(r.width).toBe(640);
    expect(r.height).toBe(360);
    expect(r.differing, "PNG differs from the stage").toBe(0);
    // The take's own files are untouched.
    expect(existsSync(join(takeDir, "display.mp4"))).toBe(true);
  }, 120_000);

  test("Copy frame puts the image on the clipboard and reports its size", async () => {
    const { win } = await openTake();
    await win.click("#copyframe");
    await expect.poll(() => win.textContent("#framestatus"), { timeout: 20_000 }).toMatch(/^Copied frame at .*\(640×360\)/);
  }, 120_000);

  test("works while playing: the still is taken and playback resumes", async () => {
    const { win, takeDir } = await openTake();
    await win.click("#playpause");
    await expect.poll(() => win.textContent("#playpause"), { timeout: 10_000 }).toBe("Pause");
    await win.click("#saveframe");
    await expect.poll(() => win.textContent("#framestatus"), { timeout: 20_000 }).toMatch(/^Saved frame at/);
    expect(readdirSync(takeDir).filter((f) => f.startsWith("frame-"))).toHaveLength(1);
    // Resumed, not left paused.
    expect(await win.textContent("#playpause")).toBe("Pause");
    const a = await win.textContent("#clock");
    await expect.poll(() => win.textContent("#clock"), { timeout: 10_000 }).not.toBe(a);
  }, 120_000);

  test("the keyboard shortcut saves too, and does not fire inside the label input", async () => {
    const { win, takeDir } = await openTake();
    await win.keyboard.press("Control+Shift+S");
    await expect.poll(() => win.textContent("#framestatus"), { timeout: 20_000 }).toMatch(/^Saved frame at/);
    expect(readdirSync(takeDir).filter((f) => f.startsWith("frame-"))).toHaveLength(1);
    // Inside a text field the shortcut belongs to the field.
    await win.click("#takes >> text=Rename");
    await win.focus(".labelinput");
    await win.keyboard.press("Control+Shift+S");
    await new Promise((r) => setTimeout(r, 500));
    expect(readdirSync(takeDir).filter((f) => f.startsWith("frame-"))).toHaveLength(1);
  }, 120_000);
});
