import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";

/**
 * The post-capture floating thumbnail, end to end (STC-296).
 *
 * The panel's own STATE — showing, expanded, expired — is decided by a pure
 * function and checked with no window at all in `thumbnail.test.ts`. What
 * this file exists for is the wiring that cannot see: that a capture really
 * puts a separate `BrowserWindow` on screen, that clicking it really expands
 * that window rather than just a DOM class, that ignoring it really writes a
 * file (the ticket's own acceptance criterion — "there is no path where a
 * capture is silently lost"), and that a showing panel really gets excluded
 * from the NEXT capture's request.
 *
 * `export-still` is faked here the same way `capture-still` already is: the
 * bytes are never inspected, only that the file the app asked for exists and
 * the reply's shape is honoured — the real encoder is `helper/test/
 * still-encode.test.ts`'s job, and needs no grant to run on every push.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Launched {
  win: Page;
  recordings: string;
  destDir: string;
  stillLog: string;
}

/** A short timeout so the "ignore it" tests do not cost the suite minutes — the floor is 3 s. */
const TEST_TIMEOUT_MS = 3000;

async function launch(extraEnv: Record<string, string> = {}): Promise<Launched> {
  const { dir: recordings } = makeTakeFolder();
  const destDir = mkdtempSync(join(tmpdir(), "stc-thumb-dest-"));
  const stillLog = join(mkdtempSync(join(tmpdir(), "stc-still-log-")), "requests.jsonl");
  const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
  // Seeded on DISK, before launch — never through `recorder:setSettings`.
  // That channel deliberately strips `still.destination` (STC-293 review,
  // #92): a renderer may not choose where main writes, precisely the thing an
  // E2E test setting up its own fixture would otherwise look like. A real
  // destination (not "beside the shot") makes a settled export easy to find,
  // and a short timeout keeps the ignore-it path from costing minutes.
  writeFileSync(join(userData, "settings.json"), JSON.stringify({
    still: { destination: destDir }, thumbnail: { timeoutMs: 3000 },
  }));
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`],
    cwd: root,
    env: {
      ...process.env, STC_RECORDINGS_DIR: recordings, STC_HELPER_BIN: FAKE_HELPER,
      STC_FAKE_STILL_LOG: stillLog, STC_NO_SHUTTER: "1", ...extraEnv,
    },
  });
  const win = await app.firstWindow();
  await win.waitForSelector("#capturestill");
  return { win, recordings, destDir, stillLog };
}

/** The floating panel, once it is up. Identified by its URL, like the overlay's own helper. */
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

async function noThumbnailWindow(ms = 15_000): Promise<void> {
  await expect.poll(
    () => app!.windows().filter((p) => p.url().includes("thumbnail.html")).length,
    { timeout: ms },
  ).toBe(0);
}

const readRequests = (log: string): any[] =>
  existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

/** A whole-display capture, the same door a hotkey uses — no overlay to drive. */
async function captureDisplay(win: Page): Promise<any> {
  return win.evaluate(() => (window as any).recorder.captureStill("display"));
}

describe("the post-capture floating thumbnail", () => {
  test("a capture puts a separate, painted panel on screen", async () => {
    const { win } = await launch();
    const r = await captureDisplay(win);
    expect(r.ok).toBe(true);

    const panel = await thumbnailWindow();
    await expect.poll(() => panel.evaluate(() => document.getElementById("card")!.className))
      .toContain("in");
    // Not the expanded panel yet — nobody has clicked it.
    expect(await panel.evaluate(() => document.getElementById("card")!.className)).not.toContain("expanded");
  }, 60_000);

  test("clicking it expands into the mode picker, redact stub, copy and save", async () => {
    const { win } = await launch();
    await captureDisplay(win);
    const panel = await thumbnailWindow();
    await panel.click("#card");
    await expect.poll(() => panel.evaluate(() => document.getElementById("card")!.className))
      .toContain("expanded");
    // Redact is a stub in this slice (STC-297 is a separate, unstarted ticket) —
    // present in the layout, and refuses to do anything.
    expect(await panel.isDisabled("#redact")).toBe(true);
    expect(await panel.isVisible("#mode")).toBe(true);
  }, 60_000);

  test("Save in the expanded panel writes the decorated file and closes the panel", async () => {
    const { win, destDir } = await launch();
    await captureDisplay(win);
    const panel = await thumbnailWindow();
    await panel.click("#card");
    await expect.poll(() => panel.evaluate(() => document.getElementById("card")!.className))
      .toContain("expanded");

    // Not a status-text poll: a successful Save sends "done" moments after
    // setting its own confirmation text, and main destroys the window on
    // "done" — polling the page for text it may already have closed under is
    // exactly the race that made `still-overlay.e2e.test.ts` flaky once. The
    // window closing IS the confirmation this path is being tested for.
    await panel.click("#save");
    await noThumbnailWindow(15_000);
    expect(readdirSync(destDir).length).toBe(1);
  }, 60_000);

  test("ignoring it still saves — nothing is lost by doing nothing", async () => {
    const { win, destDir } = await launch();
    await captureDisplay(win);
    await thumbnailWindow();
    // No click at all: the timeout is the only thing that can end this.
    await noThumbnailWindow(TEST_TIMEOUT_MS + 10_000);
    expect(readdirSync(destDir).length).toBe(1);
  }, 60_000);

  test("Copy does not close the panel — Save and Close both do", async () => {
    const { win } = await launch();
    await captureDisplay(win);
    const panel = await thumbnailWindow();
    await panel.click("#card");
    await panel.click("#copy");
    await expect.poll(() => panel.textContent("#status"), { timeout: 15_000 }).toMatch(/^Copied/);
    // Still here — a quick share should not cost the chance to also Save.
    expect(app!.windows().some((p) => p.url().includes("thumbnail.html"))).toBe(true);

    await panel.click("#close");
    await noThumbnailWindow();
  }, 60_000);

  test("a second capture replaces the panel, and the replaced shot is still saved", async () => {
    const { win, destDir } = await launch();
    // A long timeout, so only the REPLACEMENT (not either panel's own clock)
    // can be what settles anything within this test — otherwise a slow CI run
    // could let the new panel's timeout also fire and the file count would
    // depend on exactly how long assembling two windows took.
    await win.evaluate(async () => {
      await (window as any).recorder.setSettings({ thumbnail: { timeoutMs: 60_000 } });
    });
    await captureDisplay(win);
    const first = await thumbnailWindow();
    const firstUrl = first.url();

    const r2 = await captureDisplay(win);
    expect(r2.ok).toBe(true);
    // Eventually exactly one panel — the new one — not two stacked.
    await expect.poll(async () => {
      const urls = app!.windows().map((p) => p.url()).filter((u) => u.includes("thumbnail.html"));
      return urls.length === 1 && urls[0] !== firstUrl;
    }, { timeout: 15_000 }).toBe(true);
    // The REPLACED capture was settled, not merely discarded — five captures
    // in five seconds must each be recoverable (the ticket's acceptance list),
    // and losing the outgoing one to a fast second capture would violate it
    // even though stacking itself is deferred.
    await expect.poll(() => readdirSync(destDir).length, { timeout: 15_000 }).toBe(1);
  }, 60_000);

  test("a showing panel is excluded from the next capture's request, when an id resolves", async () => {
    const { win, stillLog } = await launch();
    await captureDisplay(win);
    await thumbnailWindow();
    await captureDisplay(win);

    const captures = readRequests(stillLog).filter((r) => r.kind !== undefined && r.rgba === undefined);
    expect(captures.length).toBe(2);
    // `excludeWindowIds` is OMITTED (not sent as `[]`) when nothing needs
    // excluding — `hotkeys.e2e.test.ts` pins exactly that for a first, no-panel
    // capture. So the strongest claim this harness can make is conditional: IF
    // the field is present, it names real ids. Whether `getMediaSourceId()`
    // reliably resolves one for a hidden, just-created window is the same
    // environment question `docs/STC-290-RUNBOOK.md` already declines to
    // settle for the overlay's own windows — a real screen and a real
    // subsequent capture are what actually prove exclusion; see
    // `docs/STC-296-RUNBOOK.md`.
    if (captures[1].excludeWindowIds !== undefined) {
      expect(Array.isArray(captures[1].excludeWindowIds)).toBe(true);
      expect(captures[1].excludeWindowIds.every((n: unknown) => Number.isInteger(n))).toBe(true);
    }
  }, 60_000);

  test("the skip preference bypasses the panel entirely and copies rather than saves", async () => {
    const { win, destDir, stillLog } = await launch();
    await win.evaluate(async () => {
      await (window as any).recorder.setSettings({ thumbnail: { skip: true } });
    });
    const r = await captureDisplay(win);
    expect(r.ok).toBe(true);
    // A skipped panel is still, briefly, a real (hidden) window compositing in
    // the background — see thumbnail-window.ts's `silent` mode — so what is
    // checkable is that it does not OUTLAST its own export, not that it never
    // existed for an instant.
    await noThumbnailWindow(15_000);
    // The ticket's own words are "go straight to clipboard" — never the file
    // destination, whatever the (otherwise inapplicable) settle-action says.
    expect(readdirSync(destDir).length).toBe(0);
    const exported = readRequests(stillLog).find((x) => x.rgba !== undefined);
    expect(exported?.clipboard).toBe(true);
    expect(exported?.file).toBeUndefined();
  }, 60_000);
});
