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

async function launchWithTake() {
  const src = realTake();
  if (!src) throw new Error("no real recording to export — record one first (~/Desktop/stc)");
  const dir = mkdtempSync(join(tmpdir(), "stc-export-e2e-"));
  const takeDir = join(dir, "2026-08-24_10-00-00");
  cpSync(src, takeDir, { recursive: true });
  execFileSync("node", [join(root, "app", "build.mjs")], { cwd: root, stdio: "pipe" });
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
  }, 1_800_000);
});
