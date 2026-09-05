import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { parseShot } from "../../transform/src/shot.js";

/**
 * The selection overlay, end to end (STC-290).
 *
 * The interaction itself is decided by a pure function and tested without a
 * screen in `selection.test.ts`; what this file exists for is the WIRING, which
 * that one cannot see: that a real transparent window opens on the display, that
 * its events reach the reducer in the main process, that a confirmed selection
 * becomes a `capture-still` request carrying the right crop and display, and
 * that a cancelled one writes nothing at all.
 *
 * Events are injected through the overlay's own bridge rather than as synthetic
 * mouse input. Real input would be testing the window server's hit-testing —
 * which belongs on the Mac, in the runbook — and would make this the kind of
 * flaky gate the project has already paid for twice.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Launched {
  win: Page;
  recordings: string;
  stillLog: string;
}

async function launch(extraEnv: Record<string, string> = {}): Promise<Launched> {
  const { dir: recordings } = makeTakeFolder();
  const stillLog = join(mkdtempSync(join(tmpdir(), "stc-still-log-")), "requests.jsonl");
  app = await electron.launch({
    args: [root, `--user-data-dir=${mkdtempSync(join(tmpdir(), "stc-ud-"))}`],
    cwd: root,
    env: { ...process.env, STC_RECORDINGS_DIR: recordings, STC_HELPER_BIN: FAKE_HELPER,
           STC_FAKE_STILL_LOG: stillLog, ...extraEnv },
  });
  const win = await app.firstWindow();
  await win.waitForSelector("#capturestill");
  return { win, recordings, stillLog };
}

/** The primary display's bounds, read from the main process rather than assumed. */
async function primaryBounds(): Promise<{ x: number; y: number; width: number; height: number }> {
  return app!.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds);
}

/**
 * The overlay window, once it is up.
 *
 * Identified by its URL rather than by being "the second window": the main
 * window is also in the list, and on a machine with two displays so are two
 * overlays. Bounded, with a message that says what was actually on screen — a
 * transparent screen-saver-level window is exactly the thing that might not
 * open on a CI runner, and "timeout" alone would not say so.
 */
async function overlayWindow(ms = 15_000): Promise<Page> {
  const start = Date.now();
  for (;;) {
    for (const p of app!.windows()) {
      if (p.url().includes("overlay.html")) return p;
    }
    if (Date.now() - start > ms) {
      throw new Error(`no overlay window appeared within ${ms}ms; windows: ` +
                      JSON.stringify(app!.windows().map((p) => p.url())));
    }
    await sleep(50);
  }
}

/** Push one event through the overlay's own bridge, as the DOM handlers would. */
async function send(overlay: Page, event: unknown): Promise<void> {
  await overlay.evaluate((e) => (window as any).overlay.send(e), event);
}

const readRequests = (log: string): any[] =>
  existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

describe("the selection overlay", () => {
  test("a region drag becomes a capture-still request and a shot on disk", async () => {
    const { win, recordings, stillLog } = await launch();
    const before = readdirSync(recordings).length;

    await win.click("#capturestill");
    const overlay = await overlayWindow();
    const b = await primaryBounds();

    // A 200x100 region, in GLOBAL points, well inside the display.
    const from = { x: b.x + 100, y: b.y + 80 };
    const to = { x: from.x + 200, y: from.y + 100 };
    await send(overlay, { t: "pointerdown", at: from });
    await send(overlay, { t: "pointermove", at: to });
    await send(overlay, { t: "pointerup", at: to });
    await send(overlay, { t: "key", key: "Enter" });

    await expect.poll(() => win.textContent("#stillstatus"), { timeout: 15_000 })
      .toMatch(/^Captured region/);

    // The overlay is gone, not merely hidden behind the main window.
    await expect.poll(() => app!.windows().filter((p) => p.url().includes("overlay.html")).length,
                      { timeout: 10_000 }).toBe(0);

    // Exactly one new directory, holding a shot the real loader accepts.
    const dirs = readdirSync(recordings);
    expect(dirs.length).toBe(before + 1);
    const shotDir = join(recordings, dirs.find((d) => !d.startsWith("2026-08-24"))!);
    expect(existsSync(join(shotDir, "frame.png"))).toBe(true);
    const shot = parseShot(JSON.parse(readFileSync(join(shotDir, "shot.json"), "utf8")));
    expect(shot.kind).toBe("display-crop");

    // The request itself: display-local points, the display the drag was on,
    // and the overlay's own windows named for exclusion.
    const [req] = readRequests(stillLog);
    expect(req.kind).toBe("display-crop");
    expect(req.crop).toEqual({ x: 100, y: 80, width: 200, height: 100 });
    expect(req.displayId).toBe(await app!.evaluate(({ screen }) => screen.getPrimaryDisplay().id));
    expect(Array.isArray(req.excludeWindowIds)).toBe(true);
  }, 120_000);

  test("Escape leaves no window on screen and nothing on disk", async () => {
    const { win, recordings, stillLog } = await launch();
    const before = readdirSync(recordings);

    await win.click("#capturestill");
    const overlay = await overlayWindow();
    const b = await primaryBounds();
    // Draw a marquee first: cancelling from a state with a selection is the
    // case where something COULD have been written.
    await send(overlay, { t: "pointerdown", at: { x: b.x + 50, y: b.y + 50 } });
    await send(overlay, { t: "pointermove", at: { x: b.x + 250, y: b.y + 250 } });
    await send(overlay, { t: "pointerup", at: { x: b.x + 250, y: b.y + 250 } });
    await send(overlay, { t: "key", key: "Escape" });

    await expect.poll(() => app!.windows().filter((p) => p.url().includes("overlay.html")).length,
                      { timeout: 10_000 }).toBe(0);
    // Nothing captured, nothing written, and no status claimed.
    expect(readdirSync(recordings)).toEqual(before);
    expect(readRequests(stillLog)).toEqual([]);
    expect(await win.getAttribute("#stillstatus", "hidden")).not.toBeNull();
  }, 120_000);

  test("window mode hands over a window id, not a crop", async () => {
    const { win, recordings, stillLog } = await launch();
    await win.click("#capturestill");
    const overlay = await overlayWindow();

    // The stand-in's Finder window sits at (100,100) 400x300 in global points.
    await send(overlay, { t: "key", key: " " });
    await send(overlay, { t: "pointermove", at: { x: 200, y: 200 } });
    await send(overlay, { t: "pointerdown", at: { x: 200, y: 200 } });

    await expect.poll(() => win.textContent("#stillstatus"), { timeout: 15_000 })
      .toMatch(/^Captured window/);

    const [req] = readRequests(stillLog);
    expect(req.kind).toBe("window");
    expect(req.windowId).toBe(4711);
    expect(req.crop).toBeUndefined();

    const dirs = readdirSync(recordings).filter((d) => !d.startsWith("2026-08-24"));
    const shot = parseShot(JSON.parse(readFileSync(join(recordings, dirs[0]!, "shot.json"), "utf8")));
    expect(shot.kind).toBe("window");
    expect(shot.window?.id).toBe(4711);
  }, 120_000);

  test("a helper that refuses the capture is reported, and no status is claimed", async () => {
    const { win } = await launch({ STC_FAKE_STILL_ERROR: "still-unsupported" });
    await win.click("#capturestill");
    const overlay = await overlayWindow();
    const b = await primaryBounds();
    await send(overlay, { t: "pointerdown", at: { x: b.x + 10, y: b.y + 10 } });
    await send(overlay, { t: "pointermove", at: { x: b.x + 210, y: b.y + 110 } });
    await send(overlay, { t: "pointerup", at: { x: b.x + 210, y: b.y + 110 } });
    await send(overlay, { t: "key", key: "Enter" });

    await expect.poll(() => win.textContent("#alert"), { timeout: 15_000 })
      .toContain("macOS 14");
    expect(await win.getAttribute("#stillstatus", "hidden")).not.toBeNull();
  }, 120_000);

  test("the overlay still opens when the helper cannot list windows", async () => {
    // No grant: `windows` fails. Region mode needs no window list, so refusing
    // to open would deny the user the one mode that could still have worked —
    // and the capture below is where the real reason belongs.
    const { win } = await launch({ STC_FAKE_NO_DISPLAYS: "1" });
    await win.click("#capturestill");
    const overlay = await overlayWindow();
    await send(overlay, { t: "key", key: "Escape" });
    await expect.poll(() => app!.windows().filter((p) => p.url().includes("overlay.html")).length,
                      { timeout: 10_000 }).toBe(0);
  }, 120_000);
});
