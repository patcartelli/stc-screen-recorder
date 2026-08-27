import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

/** A minimal but valid take — enough to list, without copying 40MB of video. */
function fakeTake(root: string, name: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "anchors.json"), JSON.stringify({
    version: 1, timebase: { numer: 125, denom: 3 }, t0Ns: "1000",
    display: { id: 1, pointWidth: 1920, pointHeight: 1080, pixelWidth: 3840, pixelHeight: 2160,
               backingScale: 2, originX: 0, originY: 0 },
    capture: { width: 3840, height: 2160, codec: "h264", firstFrameNs: 200_000_000 },
    files: { display: "display.mp4" }, stop: { t: 12_000_000_000, reason: "user" },
  }));
  writeFileSync(join(dir, "events.json"), JSON.stringify({ version: 1, events: [] }));
  writeFileSync(join(dir, "display.mp4"), Buffer.alloc(8192));
  return dir;
}

async function launch(recordings: string) {
  // The bundle is built once in vitest.global-setup.ts. Building it here
  // raced every other suite doing the same on app/dist/ — see that file.
  app = await electron.launch({ args: [root], cwd: root,
    env: { ...process.env, STC_RECORDINGS_DIR: recordings } });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  return win;
}

describe("take management", () => {
  test("renaming labels the take without renaming its directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stc-manage-"));
    const takeDir = fakeTake(dir, "2026-08-24_10-00-00");
    const win = await launch(dir);
    await expect.poll(() => win.textContent("#takes"), { timeout: 20_000 }).toContain("2026-08-24");

    await win.click("#takes >> text=Rename");
    await win.fill(".labelinput", "Bug repro");
    await win.press(".labelinput", "Enter");

    await expect.poll(() => win.textContent("#takes"), { timeout: 20_000 }).toContain("Bug repro");
    // Identity on disk is untouched — the label is a sidecar, not a path.
    expect(existsSync(takeDir), "the directory was renamed").toBe(true);
    expect(JSON.parse(readFileSync(join(takeDir, "take.json"), "utf8")).label).toBe("Bug repro");
    // And the timestamp stays visible, because that is what paths use.
    expect(await win.textContent("#takes")).toContain("2026-08-24_10-00-00");
  }, 120_000);

  test("deleting moves the take to the Trash rather than destroying it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stc-del-"));
    fakeTake(dir, "2026-08-24_10-00-00");
    fakeTake(dir, "2026-08-24_11-00-00");
    const win = await launch(dir);
    await expect.poll(() => win.textContent("#takes"), { timeout: 20_000 }).toContain("2026-08-24_11-00-00");

    // Answer the confirmation dialog: index 0 is "Move to Trash".
    await app!.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    await win.click("#takes .take:first-child >> text=Delete");

    await expect.poll(() => win.textContent("#takes"), { timeout: 30_000 })
      .not.toContain("2026-08-24_11-00-00");
    expect(existsSync(join(dir, "2026-08-24_11-00-00"))).toBe(false);

    // "It vanished" is what rm -rf looks like too. The claim is that it is
    // RECOVERABLE, so check it actually landed in the Trash.
    //
    // Asked through Electron on purpose: ~/.Trash is TCC-protected, and the
    // process running these tests cannot read it while the app can. Checking
    // from here would report an empty Trash and quietly turn this into an
    // assertion about nothing.
    // getBuiltinModule, not import(): vitest's SSR transform rewrites a dynamic
    // import inside evaluate() into __vite_ssr_dynamic_import__, which does not
    // exist in the Electron process the code is shipped to.
    // existsSync on the exact path, not readdir: macOS refuses to ENUMERATE
    // ~/.Trash (EPERM on scandir without Full Disk Access) while still allowing
    // a targeted stat. getBuiltinModule rather than import(), because vitest's
    // SSR transform rewrites dynamic imports into something that does not exist
    // in the Electron process this code is shipped to.
    const trashed = await app!.evaluate(({ app: electronApp }) => {
      const fs = (process as any).getBuiltinModule("node:fs");
      const path = (process as any).getBuiltinModule("node:path");
      const p = path.join(electronApp.getPath("home"), ".Trash", "2026-08-24_11-00-00");
      const there = fs.existsSync(p);
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* leave it in Trash */ }
      return there;
    });
    expect(trashed, "the take is not in the Trash — it was destroyed").toBe(true);
    // The other take is untouched.
    expect(existsSync(join(dir, "2026-08-24_10-00-00"))).toBe(true);
    expect(await win.textContent("#takes")).toContain("2026-08-24_10-00-00");
  }, 120_000);

  test("cancelling the confirmation keeps the take", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stc-cancel-"));
    fakeTake(dir, "2026-08-24_10-00-00");
    const win = await launch(dir);
    await expect.poll(() => win.textContent("#takes"), { timeout: 20_000 }).toContain("2026-08-24");

    await app!.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });  // Cancel
    });
    await win.click("#takes >> text=Delete");
    await new Promise((r) => setTimeout(r, 800));

    expect(existsSync(join(dir, "2026-08-24_10-00-00")), "cancel deleted it anyway").toBe(true);
    expect(await win.textContent("#takes")).toContain("2026-08-24_10-00-00");
  }, 120_000);
});

describe("opening a take that cannot be read", () => {
  test("reports the failure instead of leaving a dead button", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stc-corrupt-"));
    const takeDir = fakeTake(dir, "2026-08-24_10-00-00");
    // Lists fine (anchors valid, video non-empty) but is not decodable. This is
    // the shape of a truncated or half-written recording.
    writeFileSync(join(takeDir, "display.mp4"), Buffer.alloc(8192, 0x41));

    const win = await launch(dir);
    await expect.poll(() => win.textContent("#takes"), { timeout: 20_000 }).toContain("2026-08-24");
    await win.click("#takes >> text=Preview");

    // loadSession writes careful error messages; they must reach the user
    // rather than becoming an unhandled rejection nobody sees.
    await expect.poll(() => win.locator("#alert").isVisible(), { timeout: 30_000 }).toBe(true);
    expect(await win.textContent("#alert")).toMatch(/could not open|no frames|unreadable|failed/i);

    // The player must not be left half-open, and the app must stay usable.
    expect(await win.isVisible("#player")).toBe(false);
    expect(await win.locator("#takes >> text=Preview").isEnabled()).toBe(true);
  }, 120_000);
});
