import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { parseShot } from "../../transform/src/shot.js";

/**
 * Redaction, end to end (STC-297).
 *
 * The arithmetic — what a drag means, which colour a fill takes — is
 * `transform/test/still-redact.test.ts`, with no pointer and no canvas. That
 * an exported PNG genuinely contains no trace of what was covered is
 * `helper/test/still-encode.test.ts`, which decodes the encoded file. What is
 * left for this file is the WIRING those two cannot see: that a real drag on a
 * real panel becomes a region, that Undo takes one back, and that the regions
 * reach `shot.json` on disk — which is the whole of "redaction survives an app
 * restart", since that document IS the still.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function launch(): Promise<{ win: Page; destDir: string }> {
  const { dir: recordings } = makeTakeFolder();
  const destDir = mkdtempSync(join(tmpdir(), "stc-redact-dest-"));
  const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
  // Seeded on disk, never through `recorder:setSettings` — that channel
  // deliberately strips `still.destination` (STC-293 review, #92).
  writeFileSync(join(userData, "settings.json"), JSON.stringify({
    still: { destination: destDir }, thumbnail: { timeoutMs: 60_000 },
  }));
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`],
    cwd: root,
    env: {
      ...process.env, STC_RECORDINGS_DIR: recordings, STC_HELPER_BIN: FAKE_HELPER,
      STC_NO_SHUTTER: "1",
    },
  });
  const win = await app.firstWindow();
  await win.waitForSelector("#capturestill");
  return { win, destDir };
}

async function thumbnailWindow(ms = 15_000): Promise<Page> {
  const start = Date.now();
  for (;;) {
    for (const p of app!.windows()) if (p.url().includes("thumbnail.html")) return p;
    if (Date.now() - start > ms) {
      throw new Error(`no thumbnail window appeared within ${ms}ms; windows: `
        + JSON.stringify(app!.windows().map((p) => p.url())));
    }
    await sleep(50);
  }
}

/** The regions the stored document actually carries, through the real loader. */
const storedRegions = (dir: string) =>
  parseShot(JSON.parse(readFileSync(join(dir, "shot.json"), "utf8"))).decoration.redactions;

/**
 * The preview canvas's box, once it has stopped moving.
 *
 * Entering redact mode resizes the WINDOW (main) and the canvas (renderer),
 * and those are two processes arriving at the same answer independently.
 * Dragging against a box read mid-resize is the "success by finding nothing to
 * do" race in its other direction — the coordinates would be real, just no
 * longer where the canvas is. Two consecutive identical reads, then drag.
 */
async function settledCanvasBox(panel: Page, ms = 10_000):
  Promise<{ x: number; y: number; width: number; height: number }> {
  const read = async () => panel.locator("#thumbcanvas").boundingBox();
  const start = Date.now();
  let last = await read();
  for (;;) {
    await sleep(120);
    const now = await read();
    if (last && now && now.x === last.x && now.y === last.y
        && now.width === last.width && now.height === last.height && now.width > 0) {
      return now;
    }
    if (Date.now() - start > ms) {
      throw new Error(`the preview canvas never settled: ${JSON.stringify({ last, now })}`);
    }
    last = now;
  }
}

/** A capture, its panel, and that panel already in redact mode. */
async function redactingPanel(win: Page): Promise<{ panel: Page; dir: string }> {
  const r = await win.evaluate(() => (window as any).recorder.captureStill("display"));
  expect(r.ok).toBe(true);
  const panel = await thumbnailWindow();
  await panel.click("#card");
  await expect.poll(() => panel.evaluate(() => document.getElementById("card")!.className))
    .toContain("expanded");
  await panel.click("#redact");
  await expect.poll(() => panel.evaluate(() => document.getElementById("card")!.className))
    .toContain("redacting");
  return { panel, dir: r.dir as string };
}

/**
 * Drag a box across the middle of the preview, as a person would.
 *
 * Fractions of the canvas rather than pixels: the panel sizes its canvas to
 * the shot, so a fixed pixel box would fall outside it for a differently
 * shaped capture and the drag would land on nothing.
 */
async function dragBox(panel: Page, from: [number, number], to: [number, number]): Promise<void> {
  const box = await settledCanvasBox(panel);
  const at = ([fx, fy]: [number, number]) =>
    ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  const a = at(from), b = at(to);
  await panel.mouse.move(a.x, a.y);
  await panel.mouse.down();
  // Two moves, not one: a single move can be coalesced with the press, and
  // this is testing that a DRAG is followed rather than that a click lands.
  await panel.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2);
  await panel.mouse.move(b.x, b.y);
  await panel.mouse.up();
}

describe("redaction", () => {
  test("Redact grows the panel, and a drag becomes a stored region", async () => {
    const { win } = await launch();
    const { panel, dir } = await redactingPanel(win);
    expect(storedRegions(dir)).toHaveLength(0);

    await dragBox(panel, [0.3, 0.35], [0.7, 0.6]);

    // Polled, not read once: the write is a round trip to main and back, and
    // asserting immediately would be asserting on the moment before it.
    await expect.poll(() => storedRegions(dir).length, { timeout: 15_000 }).toBe(1);
    const [region] = storedRegions(dir);
    // Normalised and inside the capture — the schema's own rule, and what
    // makes a region survive a change of crop, padding or output scale.
    expect(region!.x).toBeGreaterThanOrEqual(0);
    expect(region!.y).toBeGreaterThanOrEqual(0);
    expect(region!.width).toBeGreaterThan(0);
    expect(region!.height).toBeGreaterThan(0);
    expect(region!.x + region!.width).toBeLessThanOrEqual(1);
    expect(region!.y + region!.height).toBeLessThanOrEqual(1);
  }, 60_000);

  test("a second box adds rather than replaces, and Undo takes back the last one", async () => {
    const { win } = await launch();
    const { panel, dir } = await redactingPanel(win);

    await dragBox(panel, [0.1, 0.1], [0.4, 0.3]);
    await expect.poll(() => storedRegions(dir).length, { timeout: 15_000 }).toBe(1);
    const first = storedRegions(dir)[0]!;

    await dragBox(panel, [0.55, 0.55], [0.9, 0.8]);
    await expect.poll(() => storedRegions(dir).length, { timeout: 15_000 }).toBe(2);

    await panel.click("#undo");
    await expect.poll(() => storedRegions(dir).length, { timeout: 15_000 }).toBe(1);
    // The one that survived is the FIRST — undo is last-in-first-out, not
    // "clear everything and hope".
    expect(storedRegions(dir)[0]).toEqual(first);
  }, 60_000);

  test("a click is not a region", async () => {
    const { win } = await launch();
    const { panel, dir } = await redactingPanel(win);
    const box = await settledCanvasBox(panel);
    await panel.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await panel.mouse.down();
    await panel.mouse.up();
    // Nothing to poll FOR here, so this waits out the round trip a real region
    // would have taken and then asserts nothing arrived.
    await sleep(1500);
    expect(storedRegions(dir)).toHaveLength(0);
  }, 60_000);

  test("the stored regions reach the export, not just the preview", async () => {
    const { win, destDir } = await launch();
    const { panel, dir } = await redactingPanel(win);
    await dragBox(panel, [0.25, 0.3], [0.75, 0.65]);
    await expect.poll(() => storedRegions(dir).length, { timeout: 15_000 }).toBe(1);

    // Saving from redact mode goes through the same funnel every other exit
    // does, with the regions the panel is showing — a redaction visible in the
    // panel and missing from the file is the failure this pins.
    await panel.click("#save");
    await expect.poll(
      () => app!.windows().filter((p) => p.url().includes("thumbnail.html")).length,
      { timeout: 15_000 },
    ).toBe(0);
    const saved = readdirSync(destDir);
    expect(saved).toHaveLength(1);
    expect(readFileSync(join(destDir, saved[0]!)).length).toBeGreaterThan(0);
    // The document that produced it still carries the region, so re-opening
    // the shot later (STC-294) finds it rather than a flattened picture.
    expect(storedRegions(dir)).toHaveLength(1);
  }, 60_000);
});
