import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { join } from "node:path";
import { makeTakeFolder, makePipTakeFolder } from "./_take-fixture.js";

const root = join(__dirname, "..", "..");

/** Launch the app against a recordings root, and wait for the library to list something. */
export async function launchApp(dir: string, env: Record<string, string> = {}):
    Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({
    args: [root], cwd: root,
    env: { ...process.env, STC_RECORDINGS_DIR: dir, ...env },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForSelector("#takes >> text=Preview", { timeout: 20_000 });
  return { app, win };
}

/**
 * Click a take's "Preview" action in the library and hand back the EDITOR
 * window it opens (STC-373) — a new `BrowserWindow`, not an in-page player.
 */
export async function openEditorFromLibrary(app: ElectronApplication, win: Page): Promise<Page> {
  const [editorWin] = await Promise.all([
    app.waitForEvent("window"),
    win.click("#takes >> text=Preview"),
  ]);
  await editorWin.waitForLoadState("domcontentloaded");
  return editorWin;
}

/**
 * Launch the app, open a take from the library, and hand back the EDITOR
 * window's own page — the player moved there, out of the main window's old
 * in-page `#player`.
 */
export async function launchWithTakeInEditor(opts: { pip?: boolean; env?: Record<string, string> } = {}):
    Promise<{
      app: ElectronApplication; win: Page; editorWin: Page; takeDir: string; dir: string;
    }> {
  const { dir, takeDir } = opts.pip ? makePipTakeFolder() : makeTakeFolder();
  const { app, win } = await launchApp(dir, opts.env ?? {});
  const editorWin = await openEditorFromLibrary(app, win);
  return { app, win, editorWin, takeDir, dir };
}

/** Fraction of sampled pixels on the editor's stage that are not pure black. */
export async function inkiness(page: Page): Promise<number> {
  return page.evaluate(() => {
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

/** Open the export dialog (STC-373) — legibility, output size and share all live in it now. */
export async function openExportDialog(page: Page): Promise<void> {
  await page.click("#openexport");
  await page.waitForSelector("#exportdialog[open]", { timeout: 10_000 });
}

/**
 * The rect tool's own overlay box, settled — shared by both the STC-330
 * (tune a derived window) and STC-331 (author a manual one) override E2E
 * suites, since both drive the identical `#rectoverlay` drag.
 *
 * The FIRST fix here settled `#stage`'s own box and it was not enough — the
 * same 6 tests failed identically on the next real-hardware run, which rules
 * out a plain reflow race (that fix already waits for `#rectoverlay` to be
 * visible and for the box to stop moving). The remaining suspect is the box
 * itself: `#rectoverlay` is `position: absolute; inset: 0` of `#stagewrap`,
 * not of `#stage` — editor.html's own comment claims "`#stage` always fills
 * `#stagewrap` at its own natural size, so `inset: 0` tracks it", which is
 * exactly the kind of invariant that can silently stop holding (a scrollbar,
 * a constrained window height on a real display this sandbox cannot
 * reproduce) without anything here noticing. Rather than trust that claim a
 * second time, measure the element pointer events actually land on —
 * `#rectoverlay` itself — so a click computed from it can never miss it,
 * whatever `#stage`'s own box turns out to be. Still settled the same way
 * `redaction.e2e.test.ts`'s `settledCanvasBox` is, since the reflow race is
 * real even if it was not the whole story.
 */
export async function settledRectoverlayBox(
  win: Page, ms = 10_000,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const read = () => win.locator("#rectoverlay").boundingBox();
  const start = Date.now();
  let last = await read();
  for (;;) {
    await new Promise((r) => setTimeout(r, 120));
    const now = await read();
    if (last && now && now.x === last.x && now.y === last.y
        && now.width === last.width && now.height === last.height && now.width > 0) {
      return now;
    }
    if (Date.now() - start > ms) {
      throw new Error(`#rectoverlay never settled: ${JSON.stringify({ last, now })}`);
    }
    last = now;
  }
}

/**
 * FOUND (2026-09-14, real hardware, via pointer-event instrumentation this
 * function used to carry): `.zoomblock` is a `<button>`, clicking it moves
 * focus to it, and it sits at the BOTTOM of the editor's timeline while
 * `#stage` sits at the TOP — on a window whose content is taller than its
 * viewport (true on the real CI window size, not under this sandbox's Xvfb
 * display), Chromium scrolls the newly-focused button into view, which
 * scrolls #stage/#rectoverlay PARTLY OFF THE TOP (`getBoundingClientRect()`
 * returned `y: -150`). Every failing drag's start point landed at a
 * NEGATIVE viewport y — off-screen, so `mouse.down()` there hit nothing
 * (`pointerdown` count: 0, confirmed directly). The one gesture that kept
 * passing targeted dead centre (0.5, 0.5), which happened to still clear
 * zero. `scrollIntoViewIfNeeded` before measuring is the fix, and it is
 * unconditional rather than reasoned about, because the same trap applies
 * however layout got that way on a given machine.
 */
export async function dragOnStage(
  win: Page, from: { x: number; y: number }, to: { x: number; y: number },
): Promise<void> {
  await win.waitForSelector("#rectoverlay", { state: "visible", timeout: 10_000 });
  await win.locator("#rectoverlay").scrollIntoViewIfNeeded();
  const box = await settledRectoverlayBox(win);
  const p = (f: { x: number; y: number }) => ({ x: box.x + f.x * box.width, y: box.y + f.y * box.height });
  const a = p(from), b = p(to);
  await win.mouse.move(a.x, a.y);
  await win.mouse.down();
  // Two moves, not one: a single move can be coalesced with the press
  // (redaction.e2e.test.ts's own precedent for the same reason), and this is
  // testing that a DRAG is followed rather than that a click lands.
  await win.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2);
  await win.mouse.move(b.x, b.y);
  await win.mouse.up();
}
