import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { DEFAULT_SHORTCUTS, HYPER } from "../src/hotkeys.js";
import { parseShot } from "../../transform/src/shot.js";

/**
 * Global shortcuts and menu-bar capture, end to end (STC-292).
 *
 * The grammar, the refusals and the wording are decided by pure functions and
 * checked without an app in `hotkeys.test.ts`. What this file exists for is the
 * WIRING those cannot see: that the app really registers its defaults with the
 * window server, that a rebinding survives a relaunch, that a binding macOS
 * owns is refused without being stored, that the menu-bar item is really on the
 * menu bar, and that a full-display capture completes with no overlay ever
 * opening and no window needing to be in front.
 *
 * What NO test here can settle, and the runbook therefore owns: whether macOS
 * delivers the chord to this app while another app is frontmost. Playwright can
 * drive a page's keyboard; it cannot press a key at the window server. Every
 * assertion below is about the app's side of that contract.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Launched {
  win: Page;
  recordings: string;
  userData: string;
  stillLog: string;
}

async function launch(o: { userData?: string; recordings?: string; stillLog?: string } = {}): Promise<Launched> {
  const recordings = o.recordings ?? makeTakeFolder().dir;
  const userData = o.userData ?? mkdtempSync(join(tmpdir(), "stc-ud-"));
  const stillLog = o.stillLog ?? join(mkdtempSync(join(tmpdir(), "stc-still-log-")), "requests.jsonl");
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`],
    cwd: root,
    env: {
      ...process.env,
      STC_RECORDINGS_DIR: recordings, STC_HELPER_BIN: FAKE_HELPER,
      STC_FAKE_STILL_LOG: stillLog,
      // A CI runner has no audio device and a developer machine does not want
      // a shutter per assertion. The path itself is covered by shutter.test.ts.
      STC_NO_SHUTTER: "1",
    },
  });
  const win = await app.firstWindow();
  await win.waitForSelector("#shortcuts .shortcut");
  return { win, recordings, userData, stillLog };
}

const isRegistered = (accelerator: string): Promise<boolean> =>
  app!.evaluate(({ globalShortcut }, a) => globalShortcut.isRegistered(a), accelerator);

const readRequests = (log: string): any[] =>
  existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

const storedShortcuts = (userData: string): Record<string, string | null> =>
  JSON.parse(readFileSync(join(userData, "settings.json"), "utf8")).shortcuts;

/** Click a row's key field and press a chord into it, as a user rebinding would. */
async function rebind(win: Page, action: string, keys: string): Promise<void> {
  await win.click(`#shortcut-${action}`);
  await win.locator(`#shortcut-${action}`).press(keys);
}

describe("the capture shortcuts", () => {
  test("the defaults are really registered with the window server at launch", async () => {
    // `isRegistered` asks Electron, not our own report — the point of the
    // assertion is that something outside this app agreed to the binding.
    await launch();
    for (const accelerator of Object.values(DEFAULT_SHORTCUTS)) {
      expect(await isRegistered(accelerator!), accelerator!).toBe(true);
    }
  }, 120_000);

  test("preferences shows each action as active", async () => {
    const { win } = await launch();
    for (const action of ["region", "window", "display"]) {
      await expect.poll(() => win.textContent(`#shortcutwhy-${action}`), { timeout: 15_000 })
        .toBe("Active");
    }
    expect(await win.textContent("#shortcut-region")).toBe("⌃⌥⇧⌘1");
  }, 120_000);

  test("a rebinding registers the new key, releases the old one, and survives a relaunch", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const { win } = await launch({ userData });

    await rebind(win, "region", "Control+Alt+Shift+F9");
    await expect.poll(() => win.textContent("#shortcut-region"), { timeout: 15_000 })
      .toBe("⌃⌥⇧F9");
    expect(await isRegistered("Control+Alt+Shift+F9")).toBe(true);
    // The old binding is GONE, not merely superseded: leaving it registered
    // would keep firing a capture from a key preferences no longer shows.
    expect(await isRegistered(DEFAULT_SHORTCUTS.region!)).toBe(false);
    expect(storedShortcuts(userData).region).toBe("Control+Alt+Shift+F9");

    await app!.close();
    app = undefined;
    const second = await launch({ userData });
    expect(await isRegistered("Control+Alt+Shift+F9")).toBe(true);
    expect(await second.win.textContent("#shortcut-region")).toBe("⌃⌥⇧F9");
  }, 180_000);

  test("a binding macOS has already claimed is refused, and is NOT stored", async () => {
    // The acceptance criterion. A rejection that quietly wrote something else
    // would leave the user believing they had bound ⌘⇧4.
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const { win } = await launch({ userData });

    await rebind(win, "window", "Meta+Shift+4");
    await expect.poll(() => win.textContent("#shortcutwhy-window"), { timeout: 15_000 })
      .toMatch(/macOS/);
    // The previous binding stays live and stays shown.
    expect(await win.textContent("#shortcut-window")).toBe("⌃⌥⇧⌘2");
    expect(await isRegistered(DEFAULT_SHORTCUTS.window!)).toBe(true);
    // Nothing was written AT ALL: a refused binding is not a change. Reading
    // the file back would not discriminate — `writeSettings` normalises a bad
    // binding to the default on the way out, so a stored rejection and a
    // stored default look identical on disk. Its absence does not.
    expect(existsSync(join(userData, "settings.json"))).toBe(false);
  }, 120_000);

  test("the main process refuses a reserved binding on its own, not only the field", async () => {
    // The test above drives the UI, and the UI refuses instantly so the field
    // never briefly shows a binding as accepted — which means it never reaches
    // main, and a main-side guard removed would go unnoticed. Verified by
    // mutation: with `shortcuts:set`'s own check disabled, the UI test still
    // passed and this one does not.
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const { win } = await launch({ userData });
    const r = await win.evaluate(() =>
      (window as any).recorder.setShortcut("window", "Command+Shift+4"));
    expect(r.shortcuts.window).toBe("Control+Alt+Shift+Command+2");
    expect(r.report.find((x: any) => x.action === "window"))
      .toMatchObject({ problem: "reserved", registered: false });
    expect(await isRegistered(DEFAULT_SHORTCUTS.window!)).toBe(true);
    expect(existsSync(join(userData, "settings.json"))).toBe(false);
  }, 120_000);

  test("clearing an action unregisters it and keeps it cleared across a relaunch", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const { win } = await launch({ userData });

    await win.click("#shortcuts .shortcut:nth-child(3) .clear");
    await expect.poll(() => win.textContent("#shortcut-display"), { timeout: 15_000 }).toBe("—");
    expect(await isRegistered(DEFAULT_SHORTCUTS.display!)).toBe(false);
    expect(storedShortcuts(userData).display).toBeNull();

    await app!.close();
    app = undefined;
    const second = await launch({ userData });
    expect(await second.win.textContent("#shortcut-display")).toBe("—");
    expect(await isRegistered(DEFAULT_SHORTCUTS.display!)).toBe(false);
  }, 180_000);

  test("restoring the defaults re-registers all three", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const { win } = await launch({ userData });
    await rebind(win, "region", "Control+Alt+Shift+F9");
    await expect.poll(() => win.textContent("#shortcut-region"), { timeout: 15_000 }).toBe("⌃⌥⇧F9");

    await win.click("#resetshortcuts");
    await expect.poll(() => win.textContent("#shortcut-region"), { timeout: 15_000 }).toBe("⌃⌥⇧⌘1");
    for (const accelerator of Object.values(DEFAULT_SHORTCUTS)) {
      expect(await isRegistered(accelerator!), accelerator!).toBe(true);
    }
    expect(await isRegistered("Control+Alt+Shift+F9")).toBe(false);
  }, 120_000);

  test("a second action cannot take a key the first already has", async () => {
    const { win } = await launch();
    await rebind(win, "window", `Control+Alt+Shift+Meta+1`);
    await expect.poll(() => win.textContent("#shortcutwhy-window"), { timeout: 15_000 })
      .toMatch(/already uses this/);
    // And the first action keeps it.
    expect(await isRegistered(`${HYPER}+1`)).toBe(true);
  }, 120_000);
});

const trayAlive = () => app!.evaluate(() => {
  const t = (globalThis as any).__stcTray;
  return Boolean(t) && !t.isDestroyed();
});

describe("the menu bar", () => {
  test("the item is really on the menu bar", async () => {
    // There is no Electron API that enumerates trays; the app publishes its own
    // handle for exactly this assertion, and it is read-only. Without it an
    // installTray that threw and was swallowed would be invisible.
    await launch();
    expect(await trayAlive()).toBe(true);
  }, 120_000);

  test("with the last window closed, the app is still running and still bound", async () => {
    // The whole point of menu-bar-first: no window, still running, still able
    // to capture. If the app quit here, every acceptance criterion about a
    // hotkey with no window open would be unreachable.
    //
    // macOS only, and not a skip that hides a gap: `window-all-closed` quits
    // on every other platform BY DESIGN (main.ts), so on Linux there is no
    // behaviour here to check rather than an unchecked one. CI runs macOS.
    // Written to stderr because vitest DISCARDS console output from a test
    // that ends up skipped — the notice would vanish exactly when it matters.
    if (process.platform !== "darwin") {
      process.stderr.write("SKIP: menu-bar-first survival is macOS-only behaviour\n");
      return;
    }
    const { win } = await launch();
    await win.close();
    await sleep(500);
    expect(await trayAlive()).toBe(true);
    expect(await isRegistered(DEFAULT_SHORTCUTS.region!)).toBe(true);
    // And the Dock icon is gone, which is what "runs without a window" means
    // to someone looking at their Dock.
    expect(await app!.evaluate(({ app: a }) => a.dock?.isVisible() ?? true)).toBe(false);
  }, 120_000);
});

describe("a full-display capture", () => {
  test("writes a shot with no overlay ever opening", async () => {
    // The action a hotkey reaches with nothing on screen: no selection, no
    // dimming, no window. It goes through the same main-process entry point
    // the hotkey and the menu bar call.
    const { win, recordings, stillLog } = await launch();
    const before = readdirSync(recordings).length;

    const r = await win.evaluate(() => (window as any).recorder.captureStill("display"));
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("display");
    expect(app!.windows().filter((p) => p.url().includes("overlay.html")).length).toBe(0);

    const [req] = readRequests(stillLog);
    expect(req.kind).toBe("display-crop");
    // No crop: the helper reads an absent crop as the whole display. A crop of
    // the display's own bounds would be the same picture by a route that can
    // be one point wrong.
    expect(req.crop).toBeUndefined();
    // And no exclusions, because no overlay was ever composited.
    expect(req.excludeWindowIds).toBeUndefined();
    expect(typeof req.displayId).toBe("number");

    const dirs = readdirSync(recordings);
    expect(dirs.length).toBe(before + 1);
    const shotDir = join(recordings, dirs.find((d) => !d.startsWith("2026-08-24"))!);
    const shot = parseShot(JSON.parse(readFileSync(join(shotDir, "shot.json"), "utf8")));
    expect(shot.kind).toBe("display-crop");
  }, 120_000);

  test("the window is told about a capture it did not ask for", async () => {
    // A hotkey capture has no renderer waiting on a reply. An open window must
    // not be left showing a stale take list with no explanation.
    const { win } = await launch();
    await win.evaluate(() => (window as any).recorder.on("still:captured", (r: any) => {
      (window as any).__announced = r;
    }));
    await app!.evaluate(({ webContents }) => {
      // Stand in for the hotkey's own announcement, which needs a real global
      // keypress this process cannot make.
      webContents.getAllWebContents()[0]!.send("still:captured",
        { ok: true, kind: "display", dir: "/tmp/x/2026-09-08_hotkey", source: "hotkey" });
    });
    await expect.poll(() => win.evaluate(() => (window as any).__announced?.source), { timeout: 10_000 })
      .toBe("hotkey");
    await expect.poll(() => win.textContent("#stillstatus"), { timeout: 10_000 })
      .toMatch(/^Captured full display/);
  }, 120_000);
});
