import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder, makePipTakeFolder } from "./_take-fixture.js";

/**
 * The camera toggle, end to end through the real app.
 *
 * Each piece of increment 5 is individually plausible and jointly untestable by
 * inspection — which is exactly the shape of the 4b defect where every part
 * looked right and the app still could not open a camera take. These drive the
 * real IPC handlers, the real settings file, and the real start path.
 *
 * No camera is involved. The helper stand-in speaks the control plane and
 * records the start payload; it captures nothing, and nothing here claims
 * anything about capture.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

async function launch(opts: {
  userData: string; recordings: string; startLog?: string; camera?: string;
}) {
  app = await electron.launch({
    // Electron honours --user-data-dir, which is what makes "sticky" testable:
    // a second launch against the same directory is a genuine restart.
    args: [root, `--user-data-dir=${opts.userData}`],
    cwd: root,
    env: {
      ...process.env,
      STC_RECORDINGS_DIR: opts.recordings,
      STC_HELPER_BIN: FAKE_HELPER,
      ...(opts.startLog ? { STC_FAKE_START_LOG: opts.startLog } : {}),
      ...(opts.camera ? { STC_FAKE_CAMERA: opts.camera } : {}),
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  return win;
}

describe("the camera toggle", () => {
  test("defaults to off, and the setting survives a restart", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const { dir: recordings } = makeTakeFolder();

    let win = await launch({ userData, recordings });
    // Opt-in: a camera must never be on because nobody said otherwise.
    await expect.poll(() => win.isChecked("#camera"), { timeout: 20_000 }).toBe(false);
    await win.check("#camera");
    await expect.poll(() => win.isChecked("#camera")).toBe(true);
    await app!.close();
    app = undefined;

    win = await launch({ userData, recordings });
    await expect.poll(() => win.isChecked("#camera"), { timeout: 20_000 }).toBe(true);
  }, 180_000);

  // THE assertion for this increment. Everything else can be right while the
  // flag never reaches the process that opens the device, and nothing else in
  // the suite can see that.
  test("recording with the toggle on sends camera: true to the helper", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const { dir: recordings } = makeTakeFolder();
    const startLog = join(mkdtempSync(join(tmpdir(), "stc-startlog-")), "start.jsonl");

    const win = await launch({ userData, recordings, startLog });
    await expect.poll(() => win.isEnabled("#record"), { timeout: 30_000 }).toBe(true);
    await win.check("#camera");
    await expect.poll(() => win.isChecked("#camera")).toBe(true);

    await win.click("#record");
    await expect.poll(() => existsSync(startLog), { timeout: 30_000 }).toBe(true);

    const cmd = JSON.parse(readFileSync(startLog, "utf8").trim().split("\n")[0]!);
    expect(cmd.cmd).toBe("start");
    expect(cmd.camera, `start payload was ${JSON.stringify(cmd)}`).toBe(true);
    // While a take is running the setting must not look changeable: the device
    // is opened at start and closed at stop.
    await expect.poll(() => win.isDisabled("#camera"), { timeout: 20_000 }).toBe(true);
  }, 180_000);

  test("recording with the toggle off sends camera: false", async () => {
    const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const { dir: recordings } = makeTakeFolder();
    const startLog = join(mkdtempSync(join(tmpdir(), "stc-startlog-")), "start.jsonl");

    const win = await launch({ userData, recordings, startLog });
    await expect.poll(() => win.isEnabled("#record"), { timeout: 30_000 }).toBe(true);
    await win.click("#record");
    await expect.poll(() => existsSync(startLog), { timeout: 30_000 }).toBe(true);

    const cmd = JSON.parse(readFileSync(startLog, "utf8").trim().split("\n")[0]!);
    expect(cmd.camera).toBe(false);
  }, 180_000);

  // Task 1 through the app, and it needs a POSITIVE discriminator.
  //
  // "the PiP region has lit pixels" is vacuous here: the display frame fills
  // that corner whether or not a PiP is drawn, so the first version of this
  // test passed with the wiring deliberately removed. fixtures/basic and
  // fixtures/pip are byte-identical in display.mp4, events.json and frames.json
  // and differ ONLY by the camera track — so at the same t, any pixel
  // difference in that rectangle IS the PiP, and everywhere else must be
  // identical.
  //
  // A take the app records has NO project.json. Without the camera-aware
  // default it previews with an invisible PiP next to a perfectly good
  // camera.mp4, which is exactly how the first real hardware take behaved.
  test("a camera take with no project.json still previews its PiP", async () => {

    // t = 0.4 x 5 s = 2.0 s, inside the camera track (1.035 s - 3.024 s).
    const sampleAt = async (win: any) => {
      await expect.poll(() => win.textContent("#takes"), { timeout: 20_000 }).toContain("2026-08-26");
      await win.click("#takes >> text=Preview");
      await expect.poll(() => win.isVisible("#player"), { timeout: 30_000 }).toBe(true);
      await win.fill("#scrub", "400");
      await win.dispatchEvent("#scrub", "input");
      await expect.poll(() => win.textContent("#clock"), { timeout: 30_000 }).toMatch(/0:02/);
      // Both runs seek to the SAME tick — value/1000 x durationNs, and the two
      // fixtures share frames.json — so the pixel comparison below is exact.
      // But a read taken mid-draw would differ for a reason that has nothing to
      // do with the PiP, and would surface as the "fixtures have drifted"
      // failure, accusing the wrong thing. Wait for two identical reads.
      // Bounded, because a canvas that never settles is a real failure and must
      // say so rather than hanging.
      const read = () => win.evaluate(() => {
        const c = document.getElementById("stage") as HTMLCanvasElement;
        const ctx = c.getContext("2d")!;
        const w = Math.round(c.width * 0.125), h = Math.round((w * 720) / 1280);
        const x = c.width - w - 32, y = c.height - h - 32;
        const join = (d: Uint8ClampedArray) => Array.from(d).join(",");
        return {
          pip: join(ctx.getImageData(x, y, w, h).data),
          elsewhere: join(ctx.getImageData(0, 0, c.width, y).data),
        };
      });

      let prev = await read();
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const next = await read();
        if (next.pip === prev.pip && next.elsewhere === prev.elsewhere) return next;
        prev = next;
      }
      throw new Error("the preview canvas never settled after seeking to 0:02");
    };

    const userDataA = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const { dir: noCam } = makeTakeFolder("2026-08-26_12-00-00");
    const a = await sampleAt(await launch({ userData: userDataA, recordings: noCam }));
    await app!.close(); app = undefined;

    const userDataB = mkdtempSync(join(tmpdir(), "stc-ud-"));
    const { dir: withCam } = makePipTakeFolder("2026-08-26_12-00-00", { withProject: false });
    const b = await sampleAt(await launch({ userData: userDataB, recordings: withCam }));

    // Everything outside the PiP is the same take, so it must render the same.
    // If this fails the two fixtures have drifted and the comparison below
    // proves nothing.
    expect(b.elsewhere, "the takes differ outside the PiP — fixtures have drifted")
      .toBe(a.elsewhere);
    // And inside it, the camera take must differ. This is the assertion that
    // fails when the camera-aware project default is not wired up.
    expect(b.pip, "the PiP rectangle is identical with and without a camera track")
      .not.toBe(a.pip);
  }, 240_000);
});

/**
 * STC-287 — the camera used to be invisible from the moment you ticked the box.
 *
 * It opens off the critical path, so it goes live about a second after
 * recording starts; measured across five real takes the PiP is absent for
 * 1.26-1.39 s. The helper announced all of this from the beginning —
 * `camera-started` with the device name, warnings for every failure — and the
 * app subscribed to none of it. The renderer's warning handler matched exactly
 * one code and dropped the rest, so a camera that could not open looked
 * identical to one that worked.
 */
describe("the camera says what it is doing (STC-287)", () => {
  const dirs = () => ({
    userData: mkdtempSync(join(tmpdir(), "stc-ud-")),
    recordings: makeTakeFolder().dir,
  });

  test("a camera that opens is named, once it actually opens", async () => {
    const win = await launch({ ...dirs(), camera: "FaceTime HD Camera" });
    await win.waitForSelector("#camera");
    if (!(await win.isChecked("#camera"))) await win.click("#camera");
    await win.click("#record");
    await expect.poll(() => win.textContent("#camera-state"), { timeout: 20_000 })
      .toContain("FaceTime HD Camera");
  }, 60_000);

  // THE case. Before this, a camera that failed produced nothing whatsoever in
  // the UI — the user's only clue was a take with no picture-in-picture.
  test("a camera that fails to open says so instead of failing silently", async () => {
    const win = await launch({ ...dirs(), camera: "fail" });
    await win.waitForSelector("#camera");
    if (!(await win.isChecked("#camera"))) await win.click("#camera");
    await win.click("#record");
    await expect.poll(() => win.textContent("#camera-state"), { timeout: 20_000 })
      .toContain("failed");
    await expect.poll(() => win.textContent("#alert"), { timeout: 20_000 })
      .toContain("picture-in-picture");
  }, 60_000);

  test("a take whose camera recorded nothing says so in the library", async () => {
    // anchors.camera.present is false — the clamshell case, where the device
    // opens and delivers zero frames. It used to be indistinguishable from a
    // take recorded with no camera at all.
    const { dir, takeDir } = makePipTakeFolder("2026-01-01_00-00-00-empty", { withProject: false });
    const anchorsPath = join(takeDir, "anchors.json");
    const a = JSON.parse(readFileSync(anchorsPath, "utf8"));
    a.camera = { present: false };
    writeFileSync(anchorsPath, JSON.stringify(a));
    const win = await launch({ userData: mkdtempSync(join(tmpdir(), "stc-ud-")), recordings: dir });
    await expect.poll(() => win.textContent("#takes"), { timeout: 20_000 })
      .toContain("recorded no frames");
  }, 60_000);

  test("a working camera take states when its picture-in-picture starts", async () => {
    const { dir } = makePipTakeFolder("2026-01-01_00-00-01-pip", { withProject: false });
    const win = await launch({ userData: mkdtempSync(join(tmpdir(), "stc-ud-")), recordings: dir });
    await expect.poll(() => win.textContent("#takes"), { timeout: 20_000 })
      .toMatch(/picture-in-picture starts/);
  }, 60_000);
});
