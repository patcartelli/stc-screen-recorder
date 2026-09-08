import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, existsSync, readdirSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder, makeStillFolder } from "./_take-fixture.js";
import { THUMBNAIL_FILE } from "../src/library-items.js";

/**
 * The library grid, end to end (STC-294).
 *
 * What the adapter decides is checked with no window at all in `library.test.ts`,
 * and that no view branches on kind is checked structurally in
 * `library-seam.test.ts`. What is left for this file is the wiring neither can
 * see: that a mixed root really draws both kinds of tile in one grid, that the
 * filter really narrows it, that a still's DECORATED picture really gets
 * rendered and cached beside its document, and that duplicate really produces a
 * second, independent shot.
 *
 * The ticket asks for tests over a mixed library, a stills-only library and an
 * empty one, and those are the three shapes here.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

interface Launched { win: Page; recordings: string }

/** `seed` populates the recordings root before Electron ever sees it. */
async function launch(seed: (recordings: string) => void): Promise<Launched> {
  const recordings = mkdtempSync(join(tmpdir(), "stc-libe2e-"));
  seed(recordings);
  const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
  // Seeded on DISK: `recorder:setSettings` deliberately strips
  // `still.destination` (STC-293 review, #92).
  writeFileSync(join(userData, "settings.json"), JSON.stringify({
    still: { destination: mkdtempSync(join(tmpdir(), "stc-dest-")) },
    thumbnail: { timeoutMs: 60_000 },
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
  return { win, recordings };
}

/** The badges currently drawn, in grid order. */
const badges = (win: Page) => win.evaluate(() =>
  [...document.querySelectorAll("#libgrid .libbadge")].map((n) => n.textContent));

/** The action buttons on the tile at `i`. */
const actionsOf = (win: Page, i: number) => win.evaluate((n) => {
  const tile = document.querySelectorAll("#libgrid .libtile")[n];
  return [...(tile?.querySelectorAll("button") ?? [])].map((b) => b.dataset.action);
}, i);

async function clickAction(win: Page, i: number, action: string): Promise<void> {
  await win.locator(`#libgrid .libtile >> nth=${i}`)
           .locator(`button[data-action="${action}"]`).click();
}

describe("the library grid", () => {
  test("an empty library says so and draws no grid", async () => {
    const { win } = await launch(() => {});
    await expect.poll(() => win.locator("#empty").count(), { timeout: 15_000 }).toBe(1);
    expect(await win.locator("#libgrid").count()).toBe(0);
    // The filter chips are still there — the library is empty, not absent.
    expect(await win.locator(".libfilters .chip").count()).toBe(3);
  }, 60_000);

  test("a stills-only library lists them as stills, not as broken recordings", async () => {
    // The bug this ticket fixes: before the adapter, a still had no anchors.json
    // and so was reported as a damaged recording in the invalid list.
    const { win } = await launch((dir) => {
      makeStillFolder("2026-09-08_12-00-00", { into: dir });
      makeStillFolder("2026-09-08_12-00-01", { into: dir });
    });
    await expect.poll(() => badges(win), { timeout: 15_000 }).toEqual(["Still", "Still"]);
    expect(await win.locator(".broken").count()).toBe(0);
  }, 60_000);

  test("a mixed library interleaves both kinds in one grid, newest first", async () => {
    const { win } = await launch((dir) => {
      makeTakeFolder("2026-09-08_12-00-00", { into: dir });
      makeStillFolder("2026-09-08_12-00-01", { into: dir });
      makeTakeFolder("2026-09-08_12-00-02", { into: dir });
      makeStillFolder("2026-09-08_12-00-03", { into: dir });
    });
    // Interleaved by timestamp, NOT clumped by kind: the directory name is the
    // sort key for both, which is what makes one index over two formats
    // possible at all.
    await expect.poll(() => badges(win), { timeout: 15_000 })
      .toEqual(["Still", "Recording", "Still", "Recording"]);
    expect(await win.locator(".broken").count()).toBe(0);
  }, 60_000);

  test("the filter narrows the grid, and All brings both back", async () => {
    const { win } = await launch((dir) => {
      makeTakeFolder("2026-09-08_12-00-00", { into: dir });
      makeStillFolder("2026-09-08_12-00-01", { into: dir });
    });
    await expect.poll(() => badges(win), { timeout: 15_000 }).toEqual(["Still", "Recording"]);

    await win.locator('.libfilters .chip[data-filter="still"]').click();
    await expect.poll(() => badges(win), { timeout: 15_000 }).toEqual(["Still"]);

    await win.locator('.libfilters .chip[data-filter="recording"]').click();
    await expect.poll(() => badges(win), { timeout: 15_000 }).toEqual(["Recording"]);

    await win.locator('.libfilters .chip[data-filter="all"]').click();
    await expect.poll(() => badges(win), { timeout: 15_000 }).toEqual(["Still", "Recording"]);
  }, 60_000);

  test("each kind offers its own actions, and both offer rename and delete", async () => {
    const { win } = await launch((dir) => {
      makeTakeFolder("2026-09-08_12-00-00", { into: dir });
      makeStillFolder("2026-09-08_12-00-01", { into: dir });
    });
    await expect.poll(() => badges(win), { timeout: 15_000 }).toEqual(["Still", "Recording"]);

    // Duplicate is a still's, and it is the ADAPTER that says so — the view
    // rendered whatever list it was handed.
    expect(await actionsOf(win, 0)).toEqual(
      ["open", "rename", "duplicate", "reveal", "delete"]);
    expect(await actionsOf(win, 1)).toEqual(["open", "rename", "reveal", "delete"]);
  }, 60_000);
});

describe("decorated thumbnails", () => {
  test("a still's picture is rendered and cached beside its document", async () => {
    const { recordings } = await launch((dir) => {
      makeStillFolder("2026-09-08_12-00-00", { into: dir });
    });
    const takeDir = join(recordings, "2026-09-08_12-00-00");

    // Polled on the FILE, not on the <img>: the picture appearing is what the
    // cache is for, and the write is the last step of the render.
    await expect.poll(() => existsSync(join(takeDir, THUMBNAIL_FILE)),
                      { timeout: 20_000 }).toBe(true);
    // A real PNG, not an empty file — the main-process guard refuses anything
    // that is not, so a written file is already proof it had the magic bytes.
    expect(statSync(join(takeDir, THUMBNAIL_FILE)).size).toBeGreaterThan(0);
  }, 60_000);

  /**
   * The cache being IN the take directory is what makes the ticket's delete
   * criterion — "no orphans" — true by construction rather than by eviction.
   * `take:delete` moves the whole directory to the Trash, so this checks the
   * thing that would otherwise be left behind is somewhere it cannot be.
   */
  test("the cached thumbnail lives inside the take, so deleting takes it too", async () => {
    const { recordings } = await launch((dir) => {
      makeStillFolder("2026-09-08_12-00-00", { into: dir });
    });
    const takeDir = join(recordings, "2026-09-08_12-00-00");
    await expect.poll(() => existsSync(join(takeDir, THUMBNAIL_FILE)),
                      { timeout: 20_000 }).toBe(true);
    // Nothing anywhere else: the whole cache for this shot is these bytes.
    expect(readdirSync(recordings)).toEqual(["2026-09-08_12-00-00"]);
    expect(readdirSync(takeDir).sort()).toEqual(["frame.png", "shot.json", THUMBNAIL_FILE].sort());
  }, 60_000);
});

describe("duplicate", () => {
  test("makes a second, independent shot without re-capturing", async () => {
    const { win, recordings } = await launch((dir) => {
      makeStillFolder("2026-09-08_12-00-00", {
        into: dir, redactions: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.1 }],
      });
    });
    await expect.poll(() => badges(win), { timeout: 15_000 }).toEqual(["Still"]);

    await clickAction(win, 0, "duplicate");
    await expect.poll(() => badges(win), { timeout: 15_000 }).toEqual(["Still", "Still"]);

    const dirs = readdirSync(recordings).sort();
    expect(dirs).toHaveLength(2);
    const copy = join(recordings, dirs.find((d) => d !== "2026-09-08_12-00-00")!);
    // The decoration came with it — that is the point of duplicating rather
    // than re-capturing.
    const shot = JSON.parse(readFileSync(join(copy, "shot.json"), "utf8"));
    expect(shot.decoration.redactions).toHaveLength(1);
    expect(existsSync(join(copy, "frame.png"))).toBe(true);
  }, 60_000);

  /**
   * The copy does not inherit the ORIGINAL's cached picture.
   *
   * Driven through the bridge rather than the button, deliberately: clicking
   * Duplicate re-renders the grid, which paints the new tile and caches a
   * thumbnail for it within moments — so a `thumb.png` beside the copy is the
   * EXPECTED end state, and asserting its absence through the UI just races
   * the render. The first version of this test did exactly that and failed
   * correctly.
   *
   * What actually matters is that the bytes are not the original's, since the
   * copy's decoration is about to diverge and a cache showing the old one is
   * worse than a cold one. So the original is given a recognisable thumbnail
   * first and the copy is checked against it — a positive discriminator rather
   * than an absence that a timing change would quietly satisfy.
   */
  test("duplicate does not carry the original's cached thumbnail across", async () => {
    const { win, recordings } = await launch((dir) => {
      makeStillFolder("2026-09-08_12-00-00", { into: dir });
    });
    const original = join(recordings, "2026-09-08_12-00-00");
    await expect.poll(() => badges(win), { timeout: 15_000 }).toEqual(["Still"]);
    await expect.poll(() => existsSync(join(original, THUMBNAIL_FILE)),
                      { timeout: 20_000 }).toBe(true);
    // A sentinel the real renderer would never produce: a 1x1 PNG.
    const SENTINEL = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64");
    writeFileSync(join(original, THUMBNAIL_FILE), SENTINEL);

    const r = await win.evaluate((d) => (window as any).recorder.duplicateStill(d), original);
    expect(r.ok).toBe(true);
    const copy = r.dir as string;
    expect(readdirSync(copy).sort()).toEqual(["frame.png", "shot.json"]);
    // And if the library later caches one for the copy, it is the copy's own.
    if (existsSync(join(copy, THUMBNAIL_FILE))) {
      expect(readFileSync(join(copy, THUMBNAIL_FILE)).equals(SENTINEL)).toBe(false);
    }
  }, 60_000);
});
