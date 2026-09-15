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

/**
 * Click the editor's Close button and wait for the window to actually go away.
 *
 * `editor.ts`'s handler calls `window.close()` synchronously (`$("closepreview")
 * .addEventListener("click", () => window.close())`), so the click destroys the
 * very page Playwright is still doing its post-click bookkeeping on. When the
 * window wins that race, `click()` REJECTS — "Target page, context or browser
 * has been closed" — for a click that landed and did exactly what it was asked
 * to do. That is how master run 418 went red on a working Close button
 * (STC-386); the call log shows the element "visible, enabled and stable",
 * "done scrolling", "performing click action", and then the target gone.
 *
 * The tolerance below is safe because it is NOT the assertion — `closed` is.
 * Three outcomes, told apart rather than lumped together:
 *
 *   - the click resolves  -> still wait for the close, so a click that landed
 *                            on a button that did nothing continues to fail;
 *   - the click rejects and the window closes -> the race, and a pass: the
 *                            only way to lose the page here is to have closed it;
 *   - the click rejects and the window does NOT close -> a real failure, and
 *                            the CLICK's own error is rethrown, because "could
 *                            not find #closepreview" says more than a close
 *                            that timed out waiting on a click that never was.
 *
 * So no error string is matched and no ordering between the rejection and the
 * `close` event is assumed. `app/test/close-editor-window.test.ts` drives all
 * four branches against a stub page — the race needs a real window to lose a
 * real click at a real instant, which is the multi-way timing coincidence this
 * repo has already paid for chasing live (STC-343's discard race).
 */
export async function closeEditorWindow(page: Page, timeout = 15_000): Promise<void> {
  const closed = page.waitForEvent("close", { timeout });
  const clickErr = await page.click("#closepreview").then(() => undefined, (e: unknown) => e);
  if (clickErr !== undefined) {
    await closed.catch(() => { throw clickErr; });
    return;
  }
  await closed;
}

/** Open the export dialog (STC-373) — legibility, output size and share all live in it now. */
export async function openExportDialog(page: Page): Promise<void> {
  await page.click("#openexport");
  await page.waitForSelector("#exportdialog[open]", { timeout: 10_000 });
}
