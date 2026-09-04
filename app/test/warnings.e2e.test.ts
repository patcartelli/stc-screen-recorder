import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";

/**
 * A warning the helper sends on its reliable channel reaches the user.
 *
 * The renderer's handler matched a handful of codes and dropped the rest. The
 * one that hurt: `event-tap-unavailable`. The captured pixels carry no cursor
 * by design, so a take whose input tap never installed has no cursor anywhere,
 * and it looked exactly like a good take while it was being recorded.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

async function recordWithWarning(code: string, extraEnv: Record<string, string> = {}) {
  const { dir: recordings } = makeTakeFolder();
  app = await electron.launch({
    args: [root, `--user-data-dir=${mkdtempSync(join(tmpdir(), "stc-ud-"))}`],
    cwd: root,
    env: { ...process.env, STC_RECORDINGS_DIR: recordings, STC_HELPER_BIN: FAKE_HELPER,
           STC_FAKE_WARNING: code, ...extraEnv },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await expect.poll(() => win.isEnabled("#record"), { timeout: 30_000 }).toBe(true);
  await win.click("#record");
  await expect.poll(() => win.textContent("#state"), { timeout: 30_000 }).toBe("recording");
  return win;
}

describe("helper warnings during a take", () => {
  test("an input tap that could not be installed is stated, with what it costs", async () => {
    const win = await recordWithWarning("event-tap-unavailable");
    await expect.poll(() => win.locator("#alert").isVisible(), { timeout: 10_000 }).toBe(true);
    expect(await win.textContent("#alert")).toMatch(/Cursor input is NOT being recorded/);
    expect(await win.textContent("#alert")).toMatch(/Input Monitoring/);
    // The take carries on: it is the user's call whether a cursor-less take is
    // worth keeping, and the button must still be able to end it.
    expect(await win.textContent("#record")).toBe("Stop");
  }, 120_000);

  test("a code the UI has no words for is still shown, by name", async () => {
    const win = await recordWithWarning("some-new-fault");
    await expect.poll(() => win.locator("#alert").isVisible(), { timeout: 10_000 }).toBe(true);
    expect(await win.textContent("#alert")).toContain("some-new-fault");
  }, 120_000);

  test("a display stream that dies ends the take, and the UI says so (STC-306)", async () => {
    // Long enough for the poll above to see "recording" before the stand-in
    // ends the take on its own; the assertions below then wait for the end.
    const win = await recordWithWarning("event-tap-unavailable", { STC_FAKE_STREAM_DEATH_MS: "2500" });
    // The helper stopped by itself: an unsolicited `stopped` with reason
    // stream-stopped, which the supervisor reports as recording-ended. The
    // button must not go on saying "Stop" for a take that has already ended.
    await expect.poll(() => win.textContent("#state"), { timeout: 15_000 }).toBe("idle");
    await expect.poll(() => win.textContent("#record"), { timeout: 10_000 }).toBe("Record");
    await expect.poll(() => win.locator("#alert").isVisible(), { timeout: 10_000 }).toBe(true);
    // The LAST word is the end of the take, not the tap warning that preceded
    // it, and it says what happened rather than quoting a reason code.
    await expect.poll(() => win.textContent("#alert"), { timeout: 10_000 })
      .toMatch(/display capture stopped unexpectedly, so the recording was stopped/);
    expect(await win.textContent("#alert")).toMatch(/up to that point was saved/);
    expect(await win.textContent("#alert")).not.toMatch(/press Stop/);
  }, 120_000);

  test("an idle display reconfiguration is not an alert", async () => {
    const win = await recordWithWarning("display-reconfigured");
    // Give it the time the others needed to appear, then require it did not.
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await win.locator("#alert").isVisible()).toBe(false);
  }, 120_000);
});
