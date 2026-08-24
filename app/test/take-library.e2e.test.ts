import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, existsSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

/** The newest real recording on this machine, if there is one. */
function realTake(): string | undefined {
  const stc = join(homedir(), "Desktop", "stc");
  if (!existsSync(stc)) return undefined;
  const dirs = readdirSync(stc)
    .map((n) => join(stc, n))
    .filter((p) => existsSync(join(p, "display.mp4")) && existsSync(join(p, "anchors.json")))
    .sort();
  return dirs[dirs.length - 1];
}

async function launch(recordingsDir: string) {
  execFileSync("node", [join(root, "app", "build.mjs")], { cwd: root, stdio: "pipe" });
  app = await electron.launch({
    args: [root], cwd: root,
    env: { ...process.env, STC_RECORDINGS_DIR: recordingsDir },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  return win;
}

describe("take library in the app", () => {
  test("an empty recordings folder says so instead of looking broken", async () => {
    const win = await launch(mkdtempSync(join(tmpdir(), "stc-empty-")));
    await expect.poll(() => win.textContent("#takes"), { timeout: 20_000 })
      .toContain("No recordings yet");
  }, 60_000);

  test("a real recording is listed with metadata read from its sidecars", async () => {
    const src = realTake();
    if (!src) throw new Error(
      "no real recording on this machine to verify against — record one, or this " +
      "test is asserting nothing. (~/Desktop/stc/<take>)");

    const dir = mkdtempSync(join(tmpdir(), "stc-lib-e2e-"));
    cpSync(src, join(dir, "2026-08-24_10-00-00"), { recursive: true });

    const win = await launch(dir);
    await expect.poll(() => win.textContent("#takes"), { timeout: 20_000 })
      .toContain("2026-08-24_10-00-00");
    const text = (await win.textContent("#takes"))!;
    expect(text).toMatch(/\d+:\d\d/);            // duration
    expect(text).toMatch(/\d+×\d+/);             // resolution
    expect(text).toMatch(/\d+ events/);
    expect(text).toMatch(/\d+ (MB|GB)/);
  }, 90_000);

  test("a broken take is reported in the list, and does not hide a good one", async () => {
    const src = realTake();
    if (!src) throw new Error("no real recording to verify against");
    const dir = mkdtempSync(join(tmpdir(), "stc-lib-broken-"));
    cpSync(src, join(dir, "2026-08-24_10-00-00"), { recursive: true });
    mkdirSync(join(dir, "2026-08-24_11-00-00"));
    writeFileSync(join(dir, "2026-08-24_11-00-00", "anchors.json"), "{ truncated");

    const win = await launch(dir);
    await expect.poll(() => win.textContent("#takes"), { timeout: 20_000 })
      .toContain("2026-08-24_11-00-00");
    const text = (await win.textContent("#takes"))!;
    expect(text).toContain("2026-08-24_10-00-00");   // the good one survives
    expect(text).toMatch(/unreadable|anchors/i);     // the bad one explains itself
  }, 90_000);
});
