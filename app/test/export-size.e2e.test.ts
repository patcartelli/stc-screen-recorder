import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { makeTakeFolder } from "./_take-fixture.js";

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
    expect(await stageSize(win)).toEqual({ width: 1232, height: 694 });
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
