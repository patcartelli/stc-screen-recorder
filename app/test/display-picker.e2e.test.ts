import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";

/**
 * The display picker (STC-247), end to end through the real app: the real IPC
 * handlers, the real settings file, the real start path. The helper stand-in
 * answers `devices` with two displays and records the start payload; it
 * captures nothing, and nothing here claims anything about capture — whether
 * the helper records the RIGHT screen for a given id is the grant test's and
 * the hardware runbook's to prove.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

async function launch(opts: { userData: string; recordings: string; startLog?: string; displays?: string }) {
  app = await electron.launch({
    args: [root, `--user-data-dir=${opts.userData}`],
    cwd: root,
    env: {
      ...process.env,
      STC_RECORDINGS_DIR: opts.recordings,
      STC_HELPER_BIN: FAKE_HELPER,
      ...(opts.startLog ? { STC_FAKE_START_LOG: opts.startLog } : {}),
      ...(opts.displays ? { STC_FAKE_DISPLAYS: opts.displays } : {}),
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  return win;
}

const optionValues = (win: any) =>
  win.$$eval("#display option", (os: HTMLOptionElement[]) => os.map((o) => o.value));
const optionTexts = (win: any) =>
  win.$$eval("#display option", (os: HTMLOptionElement[]) => os.map((o) => o.textContent));

describe("the display picker", () => {
  test("offers Automatic first, then what the helper enumerates, and defaults to Automatic", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const { dir: recordings } = makeTakeFolder();
    const win = await launch({ userData, recordings });

    await expect.poll(() => optionValues(win), { timeout: 20_000 }).toEqual(["", "1", "2"]);
    const texts = await optionTexts(win);
    expect(texts[0]).toBe("Automatic");
    expect(texts[1]).toContain("Built-in Display");
    expect(texts[1]).toContain("(main)");
    expect(texts[2]).toContain("External Display");
    expect(texts[2]).not.toContain("(main)");
    expect(await win.inputValue("#display")).toBe("");
  }, 180_000);

  test("a picked display survives a restart", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const { dir: recordings } = makeTakeFolder();

    let win = await launch({ userData, recordings });
    await expect.poll(() => optionValues(win), { timeout: 20_000 }).toEqual(["", "1", "2"]);
    await win.selectOption("#display", "2");
    await expect.poll(() => win.inputValue("#display")).toBe("2");
    await app!.close();
    app = undefined;

    win = await launch({ userData, recordings });
    await expect.poll(() => win.inputValue("#display"), { timeout: 20_000 }).toBe("2");
  }, 180_000);

  // THE assertion: the choice has to reach the process that opens the stream,
  // and nothing else in the suite can see whether it does.
  test("recording with a display picked sends its displayId to the helper", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const { dir: recordings } = makeTakeFolder();
    const startLog = join(mkdtempSync(join(tmpdir(), "stc-startlog-")), "start.jsonl");

    const win = await launch({ userData, recordings, startLog });
    await expect.poll(() => win.isEnabled("#record"), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => optionValues(win), { timeout: 20_000 }).toEqual(["", "1", "2"]);
    await win.selectOption("#display", "2");
    await expect.poll(() => win.inputValue("#display")).toBe("2");

    await win.click("#record");
    await expect.poll(() => existsSync(startLog), { timeout: 30_000 }).toBe(true);
    const cmd = JSON.parse(readFileSync(startLog, "utf8").trim().split("\n")[0]!);
    expect(cmd.cmd).toBe("start");
    expect(cmd.displayId, `start payload was ${JSON.stringify(cmd)}`).toBe(2);
    // Fixed at start, released at stop: not changeable mid-take.
    await expect.poll(() => win.isDisabled("#display"), { timeout: 20_000 }).toBe(true);
  }, 180_000);

  test("Automatic sends no displayId at all — the helper's first, as in phase 1", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const { dir: recordings } = makeTakeFolder();
    const startLog = join(mkdtempSync(join(tmpdir(), "stc-startlog-")), "start.jsonl");

    const win = await launch({ userData, recordings, startLog });
    await expect.poll(() => win.isEnabled("#record"), { timeout: 30_000 }).toBe(true);
    await win.click("#record");
    await expect.poll(() => existsSync(startLog), { timeout: 30_000 }).toBe(true);
    const cmd = JSON.parse(readFileSync(startLog, "utf8").trim().split("\n")[0]!);
    expect("displayId" in cmd, `start payload was ${JSON.stringify(cmd)}`).toBe(false);
  }, 180_000);

  // The stored choice outlives the display. Dropping it silently would record
  // the wrong screen without a word; the helper refuses such a start with
  // display-not-found, so the user should see the stale choice before then.
  test("a stored display that is no longer listed is shown as not connected, not dropped", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const { dir: recordings } = makeTakeFolder();

    let win = await launch({ userData, recordings });
    await expect.poll(() => optionValues(win), { timeout: 20_000 }).toEqual(["", "1", "2"]);
    await win.selectOption("#display", "2");
    await expect.poll(() => win.inputValue("#display")).toBe("2");
    await app!.close();
    app = undefined;

    const onlyMain = JSON.stringify([{ id: 1, main: true, name: "Built-in Display", pointW: 1800, pointH: 1169,
                                       pixelW: 3600, pixelH: 2338, originX: 0, originY: 0 }]);
    win = await launch({ userData, recordings, displays: onlyMain });
    await expect.poll(() => win.inputValue("#display"), { timeout: 20_000 }).toBe("2");
    const texts = await optionTexts(win);
    expect(texts.at(-1)).toBe("Display 2 (not connected)");
  }, 180_000);
});
