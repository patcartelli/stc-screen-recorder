import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { makeTakeFolder } from "./_take-fixture.js";
import { exportManifestName } from "../src/share.js";

/** The committed fixture's take name — `makeTakeFolder`'s own default. */
const TAKE_NAME = "2026-08-24_10-00-00";

const root = join(__dirname, "..", "..");
let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

/**
 * The committed fixture with its DECLARED capture size rewritten to 1920x1080.
 *
 * The pixels stay 640x360 and that is sound rather than a shortcut: the export
 * size control reads `anchors.capture`, which is precisely the number it is
 * supposed to read, and `loadSession` validates the frame offset rather than
 * the dimensions. What the rewrite buys is the only fixture shape that
 * exercises BOTH arms in one take — 1232 is a real downscale and offered,
 * 2464 would invent pixels and is refused. On the fixture's own 640x360 every
 * preset upscales, so a test using it could never press the button.
 */
function takeWithCapture(width: number, height: number, project?: unknown) {
  const { dir, takeDir } = makeTakeFolder();
  const anchorsPath = join(takeDir, "anchors.json");
  const anchors = JSON.parse(readFileSync(anchorsPath, "utf8"));
  anchors.capture.width = width;
  anchors.capture.height = height;
  writeFileSync(anchorsPath, JSON.stringify(anchors, null, 2));
  if (project) writeFileSync(join(takeDir, "project.json"), JSON.stringify(project, null, 2));
  return { dir, takeDir };
}

async function openTake(dir: string) {
  // The bundle is built once in vitest.global-setup.ts.
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

/** Every option's id, label, disabled state and whether it is the selection. */
const options = (win: any) => win.evaluate(() => {
  const sel = document.getElementById("outsize") as HTMLSelectElement;
  return [...sel.options].map((o) => ({
    id: o.value, label: o.textContent ?? "", disabled: o.disabled, selected: o.value === sel.value,
  }));
});

const stageSize = (win: any) => win.evaluate(() => {
  const c = document.getElementById("stage") as HTMLCanvasElement;
  return { width: c.width, height: c.height };
});

const readProject = (takeDir: string) =>
  JSON.parse(readFileSync(join(takeDir, "project.json"), "utf8"));

// The manifest's name comes from `share.ts`'s rule, not a literal — that
// filename having two authors is a defect this repo has already fixed once,
// and a test hard-coding it would be the third copy.
const readManifest = (takeDir: string) =>
  JSON.parse(readFileSync(join(takeDir, exportManifestName(TAKE_NAME)), "utf8"));

describe("export size (STC-335)", () => {
  test("a take offers its capture size and the presets, refusing the one that upscales", async () => {
    const { dir } = takeWithCapture(1920, 1080);
    const win = await openTake(dir);

    const opts = await options(win);
    expect(opts.map((o: any) => o.id)).toEqual(["capture", "embed-1x", "embed-2x"]);
    expect(opts[0]).toMatchObject({ selected: true, disabled: false });
    expect(opts[0]!.label).toContain("1920×1080");
    expect(opts[1]).toMatchObject({ id: "embed-1x", disabled: false });
    expect(opts[1]!.label).toContain("1232×694");
    // Offered and refused, with the reason, rather than missing — a preset
    // that simply vanished would read as a bug in the list.
    expect(opts[2]).toMatchObject({ id: "embed-2x", disabled: true });
    expect(opts[2]!.label).toContain("larger than the capture");
  }, 60_000);

  test("CHOOSING A SIZE WRITES IT TO project.json AND RESIZES THE PREVIEW", async () => {
    // The whole ticket: the transform has always honoured project.output, and
    // nothing ever wrote those two numbers. Both halves are asserted, because
    // writing the document while the preview kept drawing at the old size
    // would be a picture scaled into the wrong rect rather than an error.
    const { dir, takeDir } = takeWithCapture(1920, 1080);
    const win = await openTake(dir);
    expect(await stageSize(win)).toEqual({ width: 1920, height: 1080 });

    await win.selectOption("#outsize", "embed-1x");

    await expect.poll(() => readProject(takeDir).output, { timeout: 20_000 })
      .toEqual({ fps: 60, width: 1232, height: 694 });
    // POLLED, not read once. STC-337 made the write happen BEFORE the repaint,
    // so the document now leads the picture: the poll above returns the moment
    // `project.json` lands, which is one repaint earlier than it used to be.
    // Read immediately, this passed in isolation and lost the race under load —
    // an intermittent red on CI. The claim is unchanged; only the wait is.
    await expect.poll(() => stageSize(win), { timeout: 20_000 })
      .toEqual({ width: 1232, height: 694 });
  }, 60_000);

  test("the fps stays 60 — this control is about size only", async () => {
    const { dir, takeDir } = takeWithCapture(1920, 1080);
    const win = await openTake(dir);
    await win.selectOption("#outsize", "embed-1x");
    await expect.poll(() => readProject(takeDir).output.width, { timeout: 20_000 }).toBe(1232);
    expect(readProject(takeDir).output.fps).toBe(60);
  }, 60_000);

  test("the choice survives closing and re-opening the take", async () => {
    // The round trip through projectForWrite and parseProject. Without it the
    // setting is a UI state that looks persisted until someone checks.
    const { dir, takeDir } = takeWithCapture(1920, 1080);
    const win = await openTake(dir);
    await win.selectOption("#outsize", "embed-1x");
    await expect.poll(() => readProject(takeDir).output.width, { timeout: 20_000 }).toBe(1232);

    await win.click("#closepreview");
    await expect.poll(() => win.isVisible("#player"), { timeout: 20_000 }).toBe(false);
    await win.click("#takes >> text=Preview");
    await expect.poll(() => win.isVisible("#player"), { timeout: 30_000 }).toBe(true);

    const opts = await options(win);
    expect(opts.find((o: any) => o.selected)!.id).toBe("embed-1x");
    expect(await stageSize(win)).toEqual({ width: 1232, height: 694 });
  }, 90_000);

  test("A HAND-EDITED SIZE OPENS AS 'Custom' AND IS NOT SILENTLY REPLACED", async () => {
    // Every take edited under the workaround this ticket replaces carries a
    // size nothing offers. Reporting it as "capture size" would misstate the
    // document and then overwrite it on the next trim — which is the ordering
    // hazard the ticket asked to remove rather than document.
    const { dir } = takeWithCapture(1920, 1080, {
      version: 3, transform: { version: 3 },
      output: { fps: 60, width: 1600, height: 900 },
      cursor: { style: "default", scale: 1 },
    });
    const win = await openTake(dir);

    const opts = await options(win);
    const sel = opts.find((o: any) => o.selected)!;
    expect(sel.id).toBe("custom");
    expect(sel.label).toContain("1600×900");
    expect(await stageSize(win)).toEqual({ width: 1600, height: 900 });
    // Still offered the real options beside it, so it is a choice rather than
    // a dead end.
    expect(opts.map((o: any) => o.id)).toEqual(["custom", "capture", "embed-1x", "embed-2x"]);
  }, 60_000);
});

describe("export size, the things that assumed it could not vary (STC-337)", () => {
  test("A FAILED WRITE ROLLS THE SIZE BACK — the UI never shows what the document lacks", async () => {
    // Finding 2. `setOutputSize` used to mutate, repaint and resize the preview
    // BEFORE awaiting the write. The alert fired, so it was never silent — but
    // the select and the canvas then showed a size `project.json` did not have,
    // and it reverted on the next open with no further word.
    //
    // The failure is REAL rather than injected: `recorder.closePreview()`
    // clears main's `openTake` while the renderer's player is untouched, so the
    // next `preview:writeProject` refuses with "no take is open" through the
    // actual IPC. A fault flag would have tested the flag.
    const { dir, takeDir } = takeWithCapture(1920, 1080);
    const win = await openTake(dir);
    expect(await stageSize(win)).toEqual({ width: 1920, height: 1080 });

    await win.evaluate(() => (window as any).recorder.closePreview());
    await win.selectOption("#outsize", "embed-1x");

    await expect.poll(() => win.textContent("#alert"), { timeout: 20_000 })
      .toContain("no take is open");
    // All three must agree, and each catches a different half-fix: the model,
    // the control the user is looking at, and the picture.
    expect(existsSync(join(takeDir, "project.json"))).toBe(false);
    const opts = await options(win);
    expect(opts.find((o: any) => o.selected)!.id).toBe("capture");
    expect(await stageSize(win)).toEqual({ width: 1920, height: 1080 });
  }, 60_000);

  test("THE VIEWER'S EYE FOLLOWS A SIZE CHANGE, on a take whose output is not the capture's shape", async () => {
    // Finding 5. `effectiveOutput` spreads the view OVER `project.output`, so
    // the view kept the height derived from the old output. Invisible while
    // every export size shared the capture's aspect — which is why this take
    // is hand-edited to 1600x1000 (1.60) against a 1920x1080 capture (1.78).
    //
    // 1232 at 1.60 is 770; at 1.78 it is 694. A stale view shows 770.
    const { dir } = takeWithCapture(1920, 1080, {
      version: 3, transform: { version: 3 },
      output: { fps: 60, width: 1600, height: 1000 },
      cursor: { style: "default", scale: 1 },
    });
    const win = await openTake(dir);

    await win.check("#vieweye");
    await expect.poll(() => stageSize(win), { timeout: 20_000 })
      .toEqual({ width: 1232, height: 770 });

    await win.selectOption("#outsize", "capture");
    // The whole claim: the view re-derives from the NEW output's aspect.
    await expect.poll(() => stageSize(win), { timeout: 20_000 })
      .toEqual({ width: 1232, height: 694 });
  }, 60_000);

  test("the export-size select is disabled while an export runs, and comes back", async () => {
    // Finding 1, the UI half. A control that silently does nothing is worse
    // than one that says it cannot be used.
    const { dir } = takeWithCapture(640, 360);
    const win = await openTake(dir);
    const disabled = () => win.evaluate(() =>
      (document.getElementById("outsize") as HTMLSelectElement).disabled);
    expect(await disabled()).toBe(false);

    await win.click("#export");
    await expect.poll(disabled, { timeout: 20_000 }).toBe(true);
    await expect.poll(() => win.textContent("#exportstatus"), { timeout: 120_000 })
      .toContain("Done");
    // POLLED, and the reason is exact: `runExport` sets "Done" and THEN awaits
    // `refreshTakes()`, so the `finally` that re-enables this control runs one
    // IPC round trip after the status the poll above is waiting on. Read once,
    // this passed here and failed on CI, where that round trip is slower.
    //
    // Second time in this change that reading immediately after a poll raced —
    // the poll resolves at one point in the sequence and the assertion is about
    // a later one. The window is real but harmless: "Done" is shown while the
    // library is still refreshing, and the export genuinely is not finished
    // until it has. Moving the re-enable earlier would be contorting the
    // product to suit the test.
    await expect.poll(disabled, { timeout: 20_000 }).toBe(false);
  }, 180_000);

  test("AN EXPORT KEEPS THE SIZE IT STARTED WITH, even if the document changes under it", async () => {
    // Finding 1, the half that actually protects the file. `exportSession`
    // destructures width/height ONCE for the canvas, muxer and encoder, while
    // `render()` re-reads `project.output` every frame for the cursor and PiP
    // mapping — so a live object mutated mid-export writes the rest of the file
    // with markup for the new size onto a canvas sized for the old, and still
    // says "Done".
    //
    // The disabled select is deliberately DEFEATED here. That is the point: it
    // is a courtesy to the user, and the snapshot is the thing that makes the
    // file correct. Testing through the disabled control would only prove the
    // control, and would pass with the snapshot removed.
    //
    // 1280x720 rather than the fixture's own 640x360: at 640 every preset
    // UPSCALES and the handler correctly refuses them, so the size change
    // would never land and the test would prove nothing. The first draft did
    // exactly that and failed on its own setup.
    const { dir, takeDir } = takeWithCapture(1280, 720);
    const win = await openTake(dir);
    await win.click("#export");
    await expect.poll(() => win.textContent("#exportstatus"), { timeout: 20_000 })
      .toContain("frames");

    // Re-enable, change the size, and record whether the export really was in
    // flight when we did it — otherwise a fast export makes this vacuous.
    const wasRunning = await win.evaluate(() => {
      const sel = document.getElementById("outsize") as HTMLSelectElement;
      const running = (document.getElementById("export") as HTMLButtonElement).disabled;
      sel.disabled = false;
      sel.value = "embed-1x";
      sel.dispatchEvent(new Event("change"));
      return running;
    });
    expect(wasRunning, "the export had already finished — this proves nothing").toBe(true);

    await expect.poll(() => win.textContent("#exportstatus"), { timeout: 120_000 })
      .toContain("Done");

    // The DOCUMENT moved — so the change really did land, and this is not a
    // test that quietly did nothing.
    await expect.poll(() => readProject(takeDir).output.width, { timeout: 20_000 }).toBe(1232);
    // ...and the export did not. Both halves are needed: asserting only the
    // manifest would pass if the change had never been applied at all.
    expect(readManifest(takeDir).output).toEqual({ fps: 60, width: 1280, height: 720 });
  }, 180_000);
});
