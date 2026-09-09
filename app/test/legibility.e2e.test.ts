import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { makeTakeFolder } from "./_take-fixture.js";

const root = join(__dirname, "..", "..");
let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

/**
 * The committed fixture with its declared DISPLAY geometry rewritten.
 *
 * The legibility figure is `textPt * embedWidth / display.pointWidth`, so the
 * display's width in points is the only take property that moves it — the
 * pixels are irrelevant, which is the finding the module documents. Rewriting
 * the declaration is therefore exercising exactly the input under test.
 */
function takeWithDisplay(pointWidth: number, project?: unknown) {
  const { dir, takeDir } = makeTakeFolder();
  const path = join(takeDir, "anchors.json");
  const a = JSON.parse(readFileSync(path, "utf8"));
  a.display.pointHeight = Math.round(pointWidth * a.display.pointHeight / a.display.pointWidth);
  a.display.pointWidth = pointWidth;
  // The CAPTURE is rewritten to match, so the export-size presets are
  // reachable. It is also the honest shape: a 1x capture of a 1728-point
  // display really is 1728 wide, and the legibility figure does not read it.
  a.capture.width = pointWidth;
  a.capture.height = a.display.pointHeight;
  writeFileSync(path, JSON.stringify(a, null, 2));
  if (project) writeFileSync(join(takeDir, "project.json"), JSON.stringify(project, null, 2));
  return { dir, takeDir };
}

async function openTake(dir: string) {
  app = await electron.launch({
    args: [root], cwd: root,
    env: { ...process.env, STC_RECORDINGS_DIR: dir },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await expect.poll(() => win.textContent("#takes"), { timeout: 20_000 }).toContain("2026-08-24");
  await win.click("#takes >> text=Preview");
  await expect.poll(() => win.isVisible("#player"), { timeout: 30_000 }).toBe(true);
  return win;
}

const sentence = (win: any) => win.textContent("#legibility");
const isWarning = (win: any) =>
  win.evaluate(() => document.getElementById("legibility")!.classList.contains("warn"));
const stageSize = (win: any) => win.evaluate(() => {
  const c = document.getElementById("stage") as HTMLCanvasElement;
  return { width: c.width, height: c.height };
});
const readProject = (takeDir: string) =>
  JSON.parse(readFileSync(join(takeDir, "project.json"), "utf8"));

describe("legibility at embed width (STC-318)", () => {
  test("a retina-width display reads the figure and does not warn", async () => {
    // 13 * 1232 / 1728 = 9.27px, over the 9px threshold.
    const { dir } = takeWithDisplay(1728);
    const win = await openTake(dir);
    expect(await sentence(win)).toBe("At 1232px, 13pt text renders at 9.3px");
    expect(await isWarning(win)).toBe(false);
  }, 60_000);

  test("A FULL 4K DESKTOP WARNS — the case the ticket exists for", async () => {
    // 13 * 1232 / 3840 = 4.17px. No font setting rescues this: it would need
    // 28pt. The answer is zoom or a smaller logical display, decided at
    // capture time — which is why this figure is worth having before the
    // recording rather than after it.
    const { dir } = takeWithDisplay(3840);
    const win = await openTake(dir);
    expect(await sentence(win)).toContain("renders at 4.2px");
    expect(await sentence(win)).toContain("hard to read");
    expect(await isWarning(win)).toBe(true);
  }, 60_000);

  test("the text size is per take and persists", async () => {
    const { dir, takeDir } = takeWithDisplay(3840);
    const win = await openTake(dir);
    expect(await isWarning(win)).toBe(true);

    // 29, not 28: 28pt is 8.98px here, still under the 9px threshold. The
    // first draft used 28 and this test caught it — the margin is that tight
    // on a 4K desktop, which is the ticket's point.
    await win.fill("#textpt", "29");
    await win.dispatchEvent("#textpt", "change");

    await expect.poll(() => readProject(takeDir).textPt, { timeout: 20_000 }).toBe(29);
    // project-5, because 28 is not the default — and the version rule is what
    // keeps a take that never touched this readable by an older build.
    expect(readProject(takeDir).version).toBe(5);
    expect(await sentence(win)).toContain("29pt text renders at 9.3px");
    expect(await isWarning(win)).toBe(false);
  }, 60_000);

  test("CHANGING THE EXPORT SIZE DOES NOT CHANGE THE FIGURE", async () => {
    // The module's headline finding, asserted through the whole app: the
    // output width cancels. Exporting smaller does not make text bigger, and
    // this is the assertion that would catch someone "fixing" the formula to
    // use output.width — which is what the ticket originally specified.
    const { dir } = takeWithDisplay(1728);
    const win = await openTake(dir);
    const before = await sentence(win);

    await win.selectOption("#outsize", "embed-1x");
    await expect.poll(() => stageSize(win), { timeout: 20_000 })
      .toEqual({ width: 1232, height: 694 });

    expect(await sentence(win)).toBe(before);
  }, 60_000);

  test("a custom embed width moves the figure, and is not stored on the take", async () => {
    // Where a demo is shown belongs to the page, not the recording: two people
    // can ask about different columns of the same take.
    const { dir, takeDir } = takeWithDisplay(1728);
    const win = await openTake(dir);
    await win.fill("#embedwidth", "720");
    await win.dispatchEvent("#embedwidth", "change");

    await expect.poll(() => sentence(win), { timeout: 20_000 }).toContain("At 720px");
    expect(await sentence(win)).toContain("renders at 5.4px");
    expect(await isWarning(win)).toBe(true);
    // Persisted only if something else forced a write; either way the width
    // itself must never appear in the document.
    await win.fill("#textpt", "13");
    await win.dispatchEvent("#textpt", "change");
    await new Promise((r) => setTimeout(r, 500));
    const doc = readProject(takeDir);
    expect(doc.embedWidthPx).toBeUndefined();
  }, 60_000);

  test("THE VIEWER'S EYE DRAWS AT THE EMBED WIDTH, AND BACK AGAIN", async () => {
    // The half of "done means" that is a way of looking rather than a number.
    // It must move the whole render, not just the canvas, and it must not
    // touch the document — a way of looking that edited the take would be the
    // worst outcome here.
    const { dir, takeDir } = takeWithDisplay(1728);
    const win = await openTake(dir);
    const exportSize = await stageSize(win);

    await win.check("#vieweye");
    await expect.poll(() => stageSize(win), { timeout: 20_000 })
      .toEqual({ width: 1232, height: 693 });
    // The strongest form of "a way of looking does not edit the take": the
    // take never had a project.json and still does not. Reading `output` back
    // would have been weaker AND would have thrown on a file that is not there.
    expect(existsSync(join(takeDir, "project.json"))).toBe(false);

    await win.uncheck("#vieweye");
    await expect.poll(() => stageSize(win), { timeout: 20_000 }).toEqual(exportSize);
  }, 60_000);

  test("THE VIEWER'S EYE MOVES THE WHOLE RENDER, not just the canvas", async () => {
    // The load-bearing half, and the one a canvas-size assertion CANNOT make.
    // Resizing the canvas while still calling render() with the export's
    // output is a plausible half-fix: the video still fills the frame, so it
    // looks right — and the cursor lands at the export's coordinates, drawn at
    // the export's scale, into a smaller canvas. My first version of this test
    // passed with exactly that mutation in place.
    //
    // The discriminator is the cursor's position as a FRACTION of the canvas.
    // It is a property of the take, so it must not change with the view size.
    // Under the mutation it scales by 1728/1232 — a 40% shift.
    //
    // The fixture makes this cheap: the video is a flat colour and the cursor
    // is the only near-white thing in the frame.
    const { dir, takeDir } = takeWithDisplay(1728);
    writeFileSync(join(takeDir, "project.json"), JSON.stringify({
      version: 3, transform: { version: 3 },
      output: { fps: 60, width: 1728, height: 972 },
      // The circle placeholder at a large scale: more ink, so the centroid is
      // steady, and it is a real project option rather than a test-only mode.
      cursor: { style: "circle", scale: 8 },
    }, null, 2));
    const win = await openTake(dir);
    await win.fill("#scrub", "500");
    await win.dispatchEvent("#scrub", "input");
    await new Promise((r) => setTimeout(r, 1500));

    const cursorCentroid = () => win.evaluate(() => {
      const c = document.getElementById("stage") as HTMLCanvasElement;
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      let sx = 0, sy = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i]! > 230 && d[i + 1]! > 230 && d[i + 2]! > 230) {
          const px = (i / 4) % c.width;
          sx += px; sy += Math.floor((i / 4) / c.width); n++;
        }
      }
      return n === 0 ? null : { x: sx / n / c.width, y: sy / n / c.height, n, w: c.width };
    });

    const atExport = await cursorCentroid();
    expect(atExport, "no cursor ink found — the probe is measuring nothing").not.toBeNull();
    expect(atExport!.n).toBeGreaterThan(200);
    expect(atExport!.w).toBe(1728);

    await win.check("#vieweye");
    await expect.poll(() => stageSize(win), { timeout: 20_000 })
      .toEqual({ width: 1232, height: 693 });
    await new Promise((r) => setTimeout(r, 1000));

    const atView = await cursorCentroid();
    expect(atView, "no cursor ink at view size").not.toBeNull();
    expect(atView!.w).toBe(1232);
    // The whole claim, in two numbers. Tolerance is a pixel's worth at the
    // smaller canvas; the mutation shifts it by ~40% of the width.
    expect(atView!.x).toBeCloseTo(atExport!.x, 2);
    expect(atView!.y).toBeCloseTo(atExport!.y, 2);
    // ...and the SIZE, which is the louder half of the same claim. The cursor
    // is drawn at `cursor.scale * sx`, and `sx` is output.width/pointWidth —
    // so its ink must stay the same FRACTION of the canvas. Under the mutation
    // it is drawn at the export's scale into a smaller canvas and the fraction
    // jumps by (1728/1232)^2, near enough double. The centroid alone caught
    // that by 2.7x; this catches it by an order of magnitude more.
    const inkFraction = (c: { n: number; w: number }, h: number) => c.n / (c.w * h);
    const exportInk = inkFraction(atExport!, 972);
    const viewInk = inkFraction(atView!, 693);
    expect(viewInk / exportInk).toBeGreaterThan(0.8);
    expect(viewInk / exportInk).toBeLessThan(1.25);
  }, 90_000);

  test("changing the embed width while the viewer's eye is on moves the canvas with it", async () => {
    // Otherwise the toggle claims to show one width and shows another, which
    // is the diagnostic-that-lies failure this repo keeps paying for.
    const { dir } = takeWithDisplay(1728);
    const win = await openTake(dir);
    await win.check("#vieweye");
    await expect.poll(() => stageSize(win), { timeout: 20_000 })
      .toEqual({ width: 1232, height: 693 });

    await win.fill("#embedwidth", "720");
    await win.dispatchEvent("#embedwidth", "change");
    await expect.poll(() => stageSize(win), { timeout: 20_000 })
      .toEqual({ width: 720, height: 405 });
  }, 60_000);
});
