import { describe, test, expect, afterEach } from "vitest";
import { type ElectronApplication } from "playwright";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  launchWithTakeInEditor, openEditorFromLibrary, inkiness, closeEditorWindow,
} from "./_editor-fixture.js";

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

describe("preview player in the editor window (STC-373)", () => {
  // The regression this exists for: the app could not open a take with a
  // camera AT ALL. loadSession refuses a claimed camera with no file supplied,
  // and the renderer never supplied one — so every real PiP take died at load.
  // The determinism gate could not see it, because the gate has its own loader.
  test("a take with a camera track opens instead of failing to load", async () => {
    const { app: a, editorWin } = await launchWithTakeInEditor({ pip: true });
    app = a;
    // Real pixels, not an empty canvas — a failed load leaves the stage black.
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
  }, 120_000);

  test("opening a take renders actual video, not an empty canvas", async () => {
    const { app: a, editorWin } = await launchWithTakeInEditor();
    app = a;
    // A black canvas would satisfy "the element exists"; require real pixels.
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
    expect(await editorWin.textContent("#clock")).toMatch(/^0:00:00 \/ \d+:\d\d:\d\d$/);
  }, 120_000);

  test("scrubbing changes the displayed frame", async () => {
    const { app: a, editorWin } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);

    const frameHash = () => editorWin.evaluate(() => {
      const c = document.getElementById("stage") as HTMLCanvasElement;
      return c.getContext("2d")!.getImageData(0, 0, 64, 64).data.join(",");
    });
    const atStart = await frameHash();
    await editorWin.fill("#scrub", "209");
    await editorWin.dispatchEvent("#scrub", "input");
    await expect.poll(async () => (await frameHash()) !== atStart, { timeout: 30_000 }).toBe(true);
    expect(await editorWin.textContent("#clock")).not.toMatch(/^0:00:00 /);
  }, 120_000);

  // A scrub is a burst of input events. The last one very often lands while
  // the previous draw is still awaiting the decoder, and a draw that was
  // simply dropped there left the canvas on an earlier frame while the clock
  // said the later one. Fired from inside the page so the burst is genuinely
  // back-to-back: with the old player the canvas settles on the FIRST value's
  // frame and never moves.
  test("a burst of scrub events ends on the frame of the last one", async () => {
    const { app: a, editorWin } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);

    const stageHash = () => editorWin.evaluate(() => {
      const c = document.getElementById("stage") as HTMLCanvasElement;
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i]! + d[i + 1]! + d[i + 2]!) >>> 0;
      return h;
    });

    // The reference: one clean seek to the final value.
    await editorWin.fill("#scrub", "209");
    await editorWin.dispatchEvent("#scrub", "input");
    await expect.poll(() => editorWin.textContent("#clock"), { timeout: 20_000 }).not.toMatch(/^0:00:00 /);
    await new Promise((r) => setTimeout(r, 500));
    const expected = await stageHash();

    // Back to the start, then the burst, all in one tick of the page's loop.
    await editorWin.fill("#scrub", "0");
    await editorWin.dispatchEvent("#scrub", "input");
    await new Promise((r) => setTimeout(r, 500));
    expect(await stageHash()).not.toBe(expected);
    await editorWin.evaluate(() => {
      const s = document.getElementById("scrub") as HTMLInputElement;
      for (let v = 29; v <= 209; v += 9) {
        s.value = String(v);
        s.dispatchEvent(new Event("input"));
      }
    });
    await expect.poll(stageHash, { timeout: 10_000 }).toBe(expected);
  }, 120_000);

  test("play advances the clock and pause stops it", async () => {
    const { app: a, editorWin } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);

    await editorWin.click("#playpause");
    await expect.poll(() => editorWin.textContent("#clock"), { timeout: 20_000 }).not.toMatch(/^0:00:00 /);
    await editorWin.click("#playpause");
    // Wait for the UI to CONFIRM the pause rather than for a fixed delay.
    await expect.poll(() => editorWin.textContent("#playpause"), { timeout: 20_000 }).toBe("Play");
    await expect.poll(async () => {
      const a2 = await editorWin.textContent("#clock");
      await new Promise((r) => setTimeout(r, 250));
      return a2 === (await editorWin.textContent("#clock"));
    }, { timeout: 20_000 }).toBe(true);

    const stopped = await editorWin.textContent("#clock");
    await new Promise((r) => setTimeout(r, 900));
    expect(await editorWin.textContent("#clock")).toBe(stopped);   // paused really is paused
  }, 120_000);

  test("in/out markers persist as project.trim and survive reopen", async () => {
    const { app: a, win, editorWin, takeDir } = await launchWithTakeInEditor();
    app = a;
    await expect.poll(() => editorWin.textContent("#triminfo"), { timeout: 10_000 }).toMatch(/Full take/);

    await editorWin.fill("#scrub", "60");
    await editorWin.dispatchEvent("#scrub", "input");
    await expect.poll(() => editorWin.textContent("#clock"), { timeout: 20_000 }).not.toMatch(/^0:00:00 /);
    await editorWin.click("#markin");
    await editorWin.fill("#scrub", "120");
    await editorWin.dispatchEvent("#scrub", "input");
    await editorWin.click("#markout");

    await expect.poll(() => editorWin.textContent("#triminfo"), { timeout: 10_000 }).toMatch(/–/);
    await expect.poll(() => editorWin.textContent("#triminfo"), { timeout: 10_000 }).toMatch(/to export/);
    await expect.poll(() => existsSync(join(takeDir, "project.json")), { timeout: 10_000 }).toBe(true);
    const project = JSON.parse(readFileSync(join(takeDir, "project.json"), "utf8"));
    expect(project.trim.startNs).toBeGreaterThan(0);
    expect(project.trim.endNs).toBeGreaterThan(project.trim.startNs);

    // Close the editor and re-open the same take from the library — the
    // trim must have been persisted, not just held in the closed window's
    // now-gone state.
    await closeEditorWindow(editorWin);
    const editorWin2 = await openEditorFromLibrary(app!, win);
    await expect.poll(() => editorWin2.textContent("#triminfo"), { timeout: 30_000 }).toMatch(/–/);

    await editorWin2.click("#resettrim");
    await expect.poll(() => editorWin2.textContent("#triminfo"), { timeout: 10_000 }).toMatch(/Full take/);
  }, 120_000);
});
