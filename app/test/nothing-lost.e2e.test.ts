import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseShot } from "../../transform/src/shot.js";
import { SETTLE_READY_MS } from "../src/thumbnail.js";

/**
 * STC-301 gate 4 — nothing lost.
 *
 * > "A harness that fires N captures in quick succession, lets every thumbnail
 * > time out untouched, and asserts N files on disk with valid `shot.json`
 * > beside each. Covers the failure mode that would actually make the tool
 * > untrustworthy."
 *
 * That last sentence is why this gate exists and why it is worth more than its
 * size suggests. Every other still test asks whether one capture is CORRECT;
 * this one asks whether a burst of them is COMPLETE — and a screenshot tool
 * that occasionally loses one is worse than one that is merely wrong, because
 * you cannot tell by looking.
 *
 * ## Why it is an E2E and not a `scripts/*-gate.mjs`
 *
 * It needs Electron and the stand-in helper; it needs no browser and inspects
 * no pixels. A sixth gate PROCESS would have to be added to `worstCaseJobMs`,
 * given its own declared bound and counted against the job's cap — machinery
 * CLAUDE.md records getting wrong twice — to buy nothing this does not already
 * get by running on every push.
 *
 * ## What makes it deterministic on a CI runner
 *
 * The ticket's Constraints section demands an answer to that, having paid for
 * flaky gates three times. Three things:
 *
 *  - The panel's timeout is set to the FLOOR (3 s) on disk before launch, so
 *    the settle is bounded and known rather than the 6 s default.
 *  - Nothing here polls for a panel to appear or races an animation. It waits
 *    on the only durable artefact — directories on disk — with a generous
 *    bound, and the directories are written by `capture-still` itself, before
 *    any panel exists.
 *  - The captures are fired through `still:capture`'s `display` action, which
 *    opens no overlay and needs no pointer, so there is no window-server
 *    interaction to lose a race with.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

/**
 * How many captures count as "quick succession".
 *
 * The ticket's own acceptance wording elsewhere is "five captures in five
 * seconds produce five recoverable shots" (STC-296), so five is the number the
 * product was specified against rather than one picked to be comfortable.
 */
const N = 5;

/**
 * Teardown gets a bound of its own, and the number is derived rather than felt.
 *
 * This gate deliberately leaves the app mid-burst: a panel replaced before its
 * page had finished loading is settling, and a settle waits up to
 * `SETTLE_READY_MS` for the first composite (STC-296, #102) before it exports.
 * So `app.close()` can legitimately have that much work behind it — and
 * vitest's default hook timeout is 10 s, which is the SAME NUMBER, making the
 * teardown a coin flip. Observed failing 1 run in 5 here with the test body
 * itself green, which is the shape of flake the ticket's Constraints section
 * refuses.
 *
 * A bound that does not clear the wait it is sitting on top of is the "a new
 * bound must be checked against every bound already covering the same code"
 * trap CLAUDE.md records three times. It is derived from `SETTLE_READY_MS`
 * rather than restated, so raising that wait cannot silently un-do this.
 */
const TEARDOWN_MS = SETTLE_READY_MS + 20_000;

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; }, TEARDOWN_MS);

interface Launched { win: Page; recordings: string; destDir: string }

async function launch(): Promise<Launched> {
  const recordings = mkdtempSync(join(tmpdir(), "stc-nothinglost-"));
  const destDir = mkdtempSync(join(tmpdir(), "stc-nothinglost-dest-"));
  const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
  // Seeded on DISK: `recorder:setSettings` strips `still.destination` by design
  // (STC-293 review, #92). The timeout is the FLOOR, so the settle is bounded.
  writeFileSync(join(userData, "settings.json"), JSON.stringify({
    still: { destination: destDir },
    thumbnail: { timeoutMs: 3000, settleAction: "save" },
  }));
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`],
    cwd: root,
    env: {
      ...process.env, STC_RECORDINGS_DIR: recordings, STC_HELPER_BIN: FAKE_HELPER,
      STC_NO_SHUTTER: "1",
    },
  });
  const win = await app.firstWindow();
  await win.waitForSelector("#capturestill");
  return { win, recordings, destDir };
}

/** Every take directory that holds a shot, with the document it carries. */
function shotsIn(recordings: string): { name: string; dir: string }[] {
  return readdirSync(recordings)
    .map((name) => ({ name, dir: join(recordings, name) }))
    .filter((t) => existsSync(join(t.dir, "shot.json")));
}

describe("gate 4: nothing is lost in a burst of captures", () => {
  test(`${N} captures in quick succession leave ${N} recoverable shots`, async () => {
    const { win, recordings } = await launch();

    // Fired one after another with no waiting between them beyond the await —
    // which is what a person mashing a hotkey produces, and what the panel's
    // replace-the-showing-one path has to survive.
    const results = [];
    for (let i = 0; i < N; i++) {
      results.push(await win.evaluate(() => (window as any).recorder.captureStill("display")));
    }
    expect(results.every((r) => r.ok), JSON.stringify(results)).toBe(true);

    // N distinct directories: the one-second collision guard in `newTakeDir`
    // is what makes this true, and a burst is exactly when it matters.
    const dirs = results.map((r) => r.dir as string);
    expect(new Set(dirs).size, `captures shared a directory: ${JSON.stringify(dirs)}`).toBe(N);

    const shots = shotsIn(recordings);
    expect(shots.length, `only ${shots.length} of ${N} captures left a shot.json`).toBe(N);

    // Every one of them loads. Not "the file exists" — `parseShot` refuses
    // rather than defaults, so a document it accepts is one that can actually
    // be rendered, which is what "recoverable" has to mean.
    for (const s of shots) {
      const doc = parseShot(JSON.parse(readFileSync(join(s.dir, "shot.json"), "utf8")));
      expect(existsSync(join(s.dir, doc.frame.file)), `${s.name} has no ${doc.frame.file}`).toBe(true);
    }
  }, 120_000);

  /**
   * And every one of them SETTLES, untouched.
   *
   * The shots being on disk is the helper's doing and happens before any panel
   * exists. What this half proves is the ticket's actual sentence — "lets every
   * thumbnail time out untouched" — which is a different claim: N panels must
   * each reach an export without a person touching any of them.
   *
   * What that exercises has CHANGED under the gate, and the assertion is worth
   * more for it. It used to be the replace path — a capture arriving while a
   * panel showed replaced it, and the outgoing shot had to be settled rather
   * than discarded. Captures stack now (#104), so what a burst reaches is N
   * panels alive at once, each holding its own timer and settling on its own
   * clock, with N exports overlapping in the destination folder. The property
   * asserted is identical and the mechanism underneath it is not, which is the
   * point of asserting the OUTCOME (N files) rather than the mechanism.
   *
   * `N` is 5 because the ticket says five, and `MAX_STACKED` happens to be 5
   * as well, so today this burst fills the stack exactly and evicts nothing.
   * Lower the cap and the same burst would additionally exercise overflow
   * eviction — a broader run of the same assertion, not a broken one, which is
   * why nothing here is pinned to that coincidence.
   */
  test(`ignoring all ${N} panels still exports all ${N}`, async () => {
    const { win, recordings, destDir } = await launch();
    for (let i = 0; i < N; i++) {
      await win.evaluate(() => (window as any).recorder.captureStill("display"));
    }

    // Waits on the durable artefact rather than on any panel's animation: the
    // exported files. The bound is generous because it covers N settles plus
    // the last panel's own 3 s timeout, and the failure message says how far it
    // got rather than only that it waited.
    await expect.poll(() => readdirSync(destDir).length, { timeout: 60_000 }).toBe(N);

    // Belt and braces: the shots are still there too. An export that consumed
    // its source would pass the line above and lose the take.
    expect(shotsIn(recordings).length).toBe(N);
    for (const f of readdirSync(destDir)) {
      expect(readFileSync(join(destDir, f)).length, `${f} is empty`).toBeGreaterThan(0);
    }
  }, 180_000);
});
