import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";

/**
 * Source media is never mutated — enforced at the process boundary, not by
 * the renderer's good behaviour. export:write accepted any leaf name with a
 * known extension, which included the take's own display.mp4 and sidecars.
 */
const root = join(__dirname, "..", "..");
let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

describe("export:write", () => {
  test("refuses to overwrite the take's own files, and still writes an export", async () => {
    const { dir, takeDir } = makeTakeFolder();
    app = await electron.launch({ args: [root], cwd: root, env: { ...process.env, STC_RECORDINGS_DIR: dir } });
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    await expect.poll(() => win.textContent("#takes"), { timeout: 20_000 }).toContain("2026-08-24");
    await win.click("#takes >> text=Preview");
    await expect.poll(() => win.isVisible("#player"), { timeout: 30_000 }).toBe(true);

    const before = statSync(join(takeDir, "display.mp4")).size;
    const anchorsBefore = readFileSync(join(takeDir, "anchors.json"), "utf8");
    const attempt = (name: string) => win.evaluate(async (n: string) => {
      try { await (window as any).recorder.writeExport(n, new ArrayBuffer(8)); return "wrote"; }
      catch (e: any) { return String(e?.message ?? e); }
    }, name);

    for (const name of ["display.mp4", "camera.mp4", "anchors.json", "events.json", "project.json", "take.json"]) {
      expect(await attempt(name), name).toMatch(/refusing to overwrite/);
    }
    expect(statSync(join(takeDir, "display.mp4")).size).toBe(before);
    expect(readFileSync(join(takeDir, "anchors.json"), "utf8")).toBe(anchorsBefore);
    // The legitimate name still works.
    expect(await attempt("export-probe.mp4")).toBe("wrote");
    expect(statSync(join(takeDir, "export-probe.mp4")).size).toBe(8);
  }, 120_000);
});
