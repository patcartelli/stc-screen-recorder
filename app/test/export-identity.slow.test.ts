/**
 * Cross-implementation hash check: a UI export and a CLI export of the same
 * take must agree byte-for-byte before the encoder. It runs one UI export and
 * two CLI exports, so it takes minutes and is NOT part of `npm test` — see
 * `npm run test:slow`. A default suite nobody will sit through is a suite
 * nobody runs.
 */
import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { makeTakeFolder } from "./_take-fixture.js";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

function realTake(): string | undefined {
  const stc = join(homedir(), "Desktop", "stc");
  if (!existsSync(stc)) return undefined;
  return readdirSync(stc).map((n) => join(stc, n))
    .filter((p) => existsSync(join(p, "display.mp4")) && existsSync(join(p, "anchors.json")))
    .sort().pop();
}

/**
 * The committed fixture by DEFAULT, a real take only when asked for.
 *
 * This file used to reach into ~/Desktop/stc unconditionally and throw when it
 * found nothing — so it could never run on CI, which is a large part of why
 * `npm run test:slow` was never wired in. CLAUDE.md records four E2E files
 * being moved off the Desktop for exactly this reason; this one was missed,
 * because it is not in `npm test` and nobody was watching it.
 *
 * What this test checks is that the UI runs THE export rather than a second
 * implementation that resembles it. A 90-frame 640x360 fixture proves that as
 * well as a 4K take and in a fraction of the time; the gates are where 4K
 * behaviour is exercised. `STC_EXPORT_IDENTITY_TAKE=real` (or a path) restores
 * the old behaviour for a human who wants the heavier check.
 */
function takeFolder(): { dir: string; takeDir: string } {
  const want = process.env.STC_EXPORT_IDENTITY_TAKE;
  if (!want) return makeTakeFolder();
  const src = want === "real" ? realTake() : want;
  if (!src || !existsSync(src)) {
    throw new Error(
      `STC_EXPORT_IDENTITY_TAKE=${want} but no such take exists. Unset it to use ` +
      "the committed fixture, or record one into ~/Desktop/stc.");
  }
  const dir = mkdtempSync(join(tmpdir(), "stc-export-e2e-"));
  const takeDir = join(dir, "2026-08-24_10-00-00");
  cpSync(src, takeDir, { recursive: true });
  return { dir, takeDir };
}

async function launchWithTake() {
  const { dir, takeDir } = takeFolder();
  // The bundle is built once in vitest.global-setup.ts. Building it here
  // raced every other suite doing the same on app/dist/ — see that file.
  app = await electron.launch({
    args: [root], cwd: root, env: { ...process.env, STC_RECORDINGS_DIR: dir },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await expect.poll(() => win.textContent("#takes"), { timeout: 20_000 }).toContain("2026-08-24");
  await win.click("#takes >> text=Preview");
  await expect.poll(() => win.isVisible("#player"), { timeout: 30_000 }).toBe(true);
  return { win, takeDir };
}

describe("export identity across implementations", () => {
  test("the app's export matches the CLI export byte-for-byte before the encoder", async () => {
    const { win, takeDir } = await launchWithTake();
    await win.click("#export");
    await expect.poll(() => win.textContent("#exportstatus"), { timeout: 600_000 })
      .toMatch(/^Done —/);
    const uiHash = JSON.parse(
      readFileSync(join(takeDir, "export-2026-08-24_10-00-00.json"), "utf8")).preEncodeHash;

    // Same take through the CLI path. Identical hashes prove the UI is running
    // THE export, not a second implementation that happens to look similar.
    const out = execFileSync("node", [join(root, "scripts", "export-gate.mjs"), takeDir],
      { cwd: root, encoding: "utf8", timeout: 800_000 });
    const cliHash = out.match(/hash A: ([0-9a-f]{64})/)?.[1];

    expect(cliHash, `no hash in CLI output:\n${out}`).toBeDefined();
    expect(uiHash).toBe(cliHash);
  }, 480_000);
});
