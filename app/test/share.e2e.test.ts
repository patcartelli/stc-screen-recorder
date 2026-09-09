import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { exportManifestName, exportMediaName } from "../src/share.js";

/**
 * STC-242 — share, end to end through the real handlers.
 *
 * `share.test.ts` covers every decision; this covers the wiring those
 * decisions hang off, which is where the bugs that survive unit tests live: a
 * handler that reads the wrong settings block, a preload method wired to the
 * wrong channel, a copy that lands somewhere other than where the plan said.
 *
 * It drives `window.recorder` directly rather than clicking, for the reason
 * STC-292 records: a UI-driven test can only ever reach the first refusal it
 * meets, so a main-side guard tested through the UI can be satisfied by a
 * renderer-side one and prove nothing. The final test here goes at the IPC on
 * purpose.
 */

const root = join(__dirname, "..", "..");
let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

const TAKE = "2026-08-24_10-00-00";

interface Launched { win: Page; recordings: string; takeDir: string; site: string }

/**
 * The site folder is seeded on DISK rather than chosen through the picker.
 *
 * `share:chooseDestination` opens a native folder dialog, which no automated
 * test can answer — the same reason `nothing-lost.e2e.test.ts` seeds
 * `still.destination`. What is under test is what happens with a destination
 * configured, not the dialog.
 */
async function launch(opts: { withExport?: boolean; slug?: string } = {}): Promise<Launched> {
  const { dir: recordings, takeDir } = makeTakeFolder(TAKE);
  const site = mkdtempSync(join(tmpdir(), "stc-site-"));
  const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
  writeFileSync(join(userData, "settings.json"), JSON.stringify({
    share: { destination: site, slug: opts.slug ?? "network" },
  }));
  if (opts.withExport !== false) {
    // Stand in for a real export: the publish path cares that the file is
    // there and copies its bytes, not what is inside it.
    writeFileSync(join(takeDir, exportMediaName(TAKE)), Buffer.from("fake-mp4-bytes"));
    writeFileSync(join(takeDir, exportManifestName(TAKE)), JSON.stringify({
      version: 1, output: { fps: 60, width: 1920, height: 1080 },
    }));
  }
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`], cwd: root,
    env: { ...process.env, STC_RECORDINGS_DIR: recordings },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForSelector("#share");
  // Publishing acts on the OPEN take — main holds it, so the preview has to be
  // opened for there to be one.
  await win.evaluate((d) => (window as any).recorder.openPreview(d), takeDir);
  return { win, recordings, takeDir, site };
}

const publish = (win: Page) => win.evaluate(() => (window as any).recorder.publish());

describe("share to the site folder", () => {
  test("copies the export under the SLUG's name, not the take's", async () => {
    const { win, site } = await launch();
    const r = await publish(win);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.name).toBe("network.mp4");
    // The whole point: the published name carries no timestamp, so the page
    // can embed a fixed path across re-recordings.
    expect(r.name).not.toContain(TAKE);
    expect(existsSync(join(site, "network.mp4"))).toBe(true);
    expect(readFileSync(join(site, "network.mp4"), "utf8")).toBe("fake-mp4-bytes");
    // First publish into an empty folder replaced nothing, and says so.
    expect(r.replaced).toBe(false);
  }, 60_000);

  /**
   * Re-publishing overwrites, deliberately — and REPORTS it.
   *
   * The overwrite is the design (one stable path per demo, so a re-shoot needs
   * no page edit). Being quiet about it is not: someone who did not expect it
   * should learn from the app rather than from `git status`.
   */
  test("re-publishing replaces, and says that it replaced", async () => {
    const { win, site } = await launch();
    expect((await publish(win)).replaced).toBe(false);
    writeFileSync(join(site, "network.mp4"), Buffer.from("older-video"));
    const second = await publish(win);
    expect(second.ok).toBe(true);
    expect(second.replaced).toBe(true);
    expect(readFileSync(join(site, "network.mp4"), "utf8")).toBe("fake-mp4-bytes");
  }, 60_000);

  test("refuses, with the reason, when the take has not been exported", async () => {
    const { win, site } = await launch({ withExport: false });
    const r = await publish(win);
    expect(r.ok).toBe(false);
    expect(r.plan).toBe("no-export");
    expect(r.message).toMatch(/export/i);
    // Nothing was written on a refusal — a failed publish must not leave a
    // partial file the site would then serve.
    expect(existsSync(join(site, "network.mp4"))).toBe(false);
  }, 60_000);

  test("offers a snippet carrying the dimensions the export actually encoded", async () => {
    const { win } = await launch();
    const r = await publish(win);
    expect(r.snippet).toContain('src="/lab/network/network.mp4"');
    // 1920x1080 comes from the MANIFEST, not from the project as it now
    // stands — the project is editable after an export.
    expect(r.snippet).toContain('width="1920"');
    expect(r.snippet).toContain('height="1080"');
  }, 60_000);

  test("with no manifest, the snippet says so rather than pasting a zero", async () => {
    const { win, takeDir } = await launch();
    writeFileSync(join(takeDir, exportManifestName(TAKE)), "not json");
    const r = await publish(win);
    expect(r.ok).toBe(true);
    expect(r.snippet).toContain("{width}");
    expect(r.snippet).not.toContain('width="0"');
  }, 60_000);

  test("reveal reports honestly when nothing has been published", async () => {
    const { win } = await launch();
    const r = await win.evaluate(() => (window as any).recorder.revealPublished());
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/nothing published/i);
  }, 60_000);

  /**
   * The main-side guard, reached through the IPC rather than the UI.
   *
   * `recorder:setSettings` strips `share.destination` so the renderer cannot
   * make this process copy a file to a path of its choosing — the same rule
   * `still.destination` already follows. STC-292's lesson is that testing this
   * through the preferences UI would prove nothing: whichever guard is met
   * first is the only one exercised, and a renderer-side check would satisfy
   * the assertion with main's own guard removed.
   */
  test("the renderer cannot set the site folder through setSettings", async () => {
    const { win, site } = await launch();
    const after = await win.evaluate(() => (window as any).recorder.setSettings({
      share: { destination: "/tmp/somewhere-else", slug: "evil" },
    }));
    // The slug went through — it decides only what the file is called.
    expect(after.share.slug).toBe("evil");
    // The destination did not.
    expect(after.share.destination).toBe(site);
  }, 60_000);
});
