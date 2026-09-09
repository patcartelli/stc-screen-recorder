/**
 * The scrubber, wired (STC-338).
 *
 * `scrubber.test.ts` proves the module DECIDES correctly with no screen. That
 * is a different claim from the app doing what it decided, and this repo has
 * paid for the gap twice — STC-292's renderer-side guard that shadowed the
 * main-side one, and STC-318's canvas assertion that could not see what the
 * canvas was displayed at. Everything here is driven through real keystrokes
 * and the real range input.
 *
 * The fixture is `fixtures/basic`: 4983333349 ns, so 300 export frames
 * (0..299) at 60 fps. Frame numbers below are that take's, not magic.
 */
import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { makeTakeFolder } from "./_take-fixture.js";
import { MIN_TRIM_FRAMES, formatTimecode } from "../src/scrubber.js";

const root = join(__dirname, "..", "..");
let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

const LAST_FRAME = 299;

async function openPreview() {
  const { dir, takeDir } = makeTakeFolder();
  app = await electron.launch({
    args: [root], cwd: root,
    env: { ...process.env, STC_RECORDINGS_DIR: dir },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await expect.poll(() => win.textContent("#takes"), { timeout: 20_000 }).toContain("2026-08-24");
  await win.click("#takes >> text=Preview");
  await expect.poll(() => win.isVisible("#player"), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => win.textContent("#clock"), { timeout: 20_000 }).toMatch(/^\d:\d\d:\d\d /);
  return { win, takeDir };
}

/** The playhead, read off the control whose value IS the frame (rule 1). */
const frameOf = (win: any): Promise<number> =>
  win.evaluate(() => Number((document.getElementById("scrub") as HTMLInputElement).value));

/**
 * Focus the range WITHOUT clicking it. A click on a range input sets its
 * value from the click's x — so `click("#scrub")` seeks to the middle of the
 * track, and a test that clicked to "give it focus" would be asserting
 * against a position it moved itself.
 */
const focusScrub = (win: any) =>
  win.evaluate(() => (document.getElementById("scrub") as HTMLInputElement).focus());

/**
 * `frameOf` alone is not a sync gate: `fill()` sets the scrub's DOM value
 * SYNCHRONOUSLY, so polling it trivially matches before `player.currentNs`
 * has actually caught up — `seek()` decodes and draws before it settles.
 * Every OTHER seekTo in this file happens to seek FORWARD-only, where the
 * gap is too small to matter; a backward seek (slower — see
 * SeekingFrameSource) exposed it: `press("i")` fired while the player was
 * still near the PREVIOUS position, collapsing the trim. `#clock` is set
 * only inside `onTime`, after the seek's `draw()` has resolved, so it is
 * the real signal that `player.currentNs` is where the test expects.
 */
const seekTo = async (win: any, frame: number) => {
  await win.fill("#scrub", String(frame));
  await win.dispatchEvent("#scrub", "input");
  await expect.poll(() => frameOf(win), { timeout: 20_000 }).toBe(frame);
  await expect.poll(() => win.textContent("#clock"), { timeout: 20_000 })
    .toMatch(new RegExp(`^${formatTimecode(frame).replace(/[:.]/g, "\\$&")} /`));
};

describe("the scrubber's domain is export frames (rule 1)", () => {
  test("the control is parameterised in frames and cannot express a position between two", async () => {
    const { win } = await openPreview();
    // The structural half of the snap: max is the take's last frame and the
    // step is one frame, so an unsnapped value is not representable at all.
    // A per-mille control with rounding applied afterwards would pass every
    // behavioural test here and still be able to HOLD an off-grid position.
    expect(await win.getAttribute("#scrub", "max")).toBe(String(LAST_FRAME));
    expect(await win.getAttribute("#scrub", "step")).toBe("1");
    expect(await win.getAttribute("#scrub", "min")).toBe("0");
  }, 60_000);

  test("the readout is frame-accurate, and adjacent frames read differently", async () => {
    const { win } = await openPreview();
    await seekTo(win, 120);
    expect(await win.textContent("#clock")).toBe("0:02:00 / 0:04:59");
    await seekTo(win, 121);
    // Rule 10: seconds alone could not tell these two apart, which is exactly
    // the distinction a one-frame nudge exists to make.
    expect(await win.textContent("#clock")).toBe("0:02:01 / 0:04:59");
  }, 60_000);
});

describe("the keyboard grammar (rule 8), through real keystrokes", () => {
  test("arrows nudge one frame and shift ten", async () => {
    const { win } = await openPreview();
    await seekTo(win, 120);
    await win.keyboard.press("ArrowRight");
    await expect.poll(() => frameOf(win), { timeout: 10_000 }).toBe(121);
    await win.keyboard.press("ArrowLeft");
    await expect.poll(() => frameOf(win), { timeout: 10_000 }).toBe(120);
    await win.keyboard.press("Shift+ArrowRight");
    await expect.poll(() => frameOf(win), { timeout: 10_000 }).toBe(130);
    await win.keyboard.press("Shift+ArrowLeft");
    await expect.poll(() => frameOf(win), { timeout: 10_000 }).toBe(120);
  }, 60_000);

  test("an arrow moves ONE frame, not two", async () => {
    // The wiring fault this exists for, and it is invisible to the pure test:
    // #scrub is a range input with native arrow handling, so a nudge that was
    // handled without being prevented moves the control natively AND by the
    // scrubber's own step. It would read as a vague feel problem rather than
    // as a bug. Ten presses, ten frames — nothing else discriminates.
    const { win } = await openPreview();
    await seekTo(win, 100);
    await focusScrub(win); // native handling is only live on the focused control
    for (let i = 0; i < 10; i++) await win.keyboard.press("ArrowRight");
    await expect.poll(() => frameOf(win), { timeout: 10_000 }).toBe(110);
  }, 60_000);

  test("a nudge at the end of the take stops there", async () => {
    const { win } = await openPreview();
    await seekTo(win, LAST_FRAME - 2);
    await win.keyboard.press("Shift+ArrowRight");
    await expect.poll(() => frameOf(win), { timeout: 10_000 }).toBe(LAST_FRAME);
    await win.keyboard.press("ArrowRight");
    await expect.poll(() => frameOf(win), { timeout: 10_000 }).toBe(LAST_FRAME);
  }, 60_000);

  test("I and O set the in and out points at the playhead", async () => {
    const { win, takeDir } = await openPreview();
    await seekTo(win, 60);
    await win.keyboard.press("i");
    await seekTo(win, 180);
    await win.keyboard.press("o");
    await expect.poll(() => win.textContent("#triminfo"), { timeout: 10_000 }).toMatch(/–/);
    await expect.poll(() => existsSync(join(takeDir, "project.json")), { timeout: 10_000 }).toBe(true);
    const project = JSON.parse(readFileSync(join(takeDir, "project.json"), "utf8"));
    // The trim's ends are ON the grid — the property rule 6 exists to keep.
    // 60 frames at 60 fps is 1 s; 180 is 3 s.
    expect(project.trim.startNs).toBe(1_000_000_000);
    expect(project.trim.endNs).toBe(3_000_000_000);
  }, 60_000);

  test("L shuttles, K stops, and the rate is announced only while shuttling", async () => {
    const { win } = await openPreview();
    await seekTo(win, 0);
    expect(await win.textContent("#shuttle")).toBe("");
    await win.keyboard.press("l");
    await expect.poll(() => win.textContent("#shuttle"), { timeout: 10_000 }).toBe("1x");
    await win.keyboard.press("l");
    await expect.poll(() => win.textContent("#shuttle"), { timeout: 10_000 }).toBe("2x");
    // Rule 7's payoff: J DECELERATES a forward shuttle rather than reversing
    // outright, because there is one ladder and not two.
    await win.keyboard.press("j");
    await expect.poll(() => win.textContent("#shuttle"), { timeout: 10_000 }).toBe("1x");
    await win.keyboard.press("k");
    await expect.poll(() => win.textContent("#shuttle"), { timeout: 10_000 }).toBe("");
    expect(await win.textContent("#playpause")).toBe("Play");
  }, 60_000);

  test("a shuttle actually moves the playhead, and K leaves it where it stopped", async () => {
    const { win } = await openPreview();
    await seekTo(win, 0);
    await win.keyboard.press("l");
    await expect.poll(() => frameOf(win), { timeout: 15_000 }).toBeGreaterThan(5);
    await win.keyboard.press("k");
    const stopped = await frameOf(win);
    await new Promise((r) => setTimeout(r, 400));
    // Rule 3: no momentum. A stop is a stop, not a glide.
    expect(await frameOf(win)).toBe(stopped);
  }, 60_000);

  test("a reverse shuttle runs backwards and stops at the start", async () => {
    const { win } = await openPreview();
    await seekTo(win, 120);
    await win.keyboard.press("j");
    await expect.poll(() => frameOf(win), { timeout: 15_000 }).toBeLessThan(115);
    // The floor reverse needs and forward does not: without it a backward
    // shuttle runs into negative time and asks the source for material that
    // never existed.
    await expect.poll(() => frameOf(win), { timeout: 20_000 }).toBe(0);
    await expect.poll(() => win.textContent("#shuttle"), { timeout: 10_000 }).toBe("");
  }, 60_000);

  test("a focused text field owns the bare keys", async () => {
    // Rule 8, and the load-bearing case: typing a width into the legibility
    // field must not shuttle the take or drop an in point. A pure test cannot
    // see this — it depends on what `document.activeElement` really is.
    const { win } = await openPreview();
    await seekTo(win, 120);
    const before = await win.textContent("#triminfo");
    await win.click("#textpt");
    await win.fill("#textpt", "");
    await win.type("#textpt", "13");
    expect(await frameOf(win)).toBe(120);            // no nudge
    expect(await win.textContent("#shuttle")).toBe("");  // no shuttle
    expect(await win.textContent("#triminfo")).toBe(before); // no in/out
    expect(await win.inputValue("#textpt")).toBe("13");
  }, 60_000);

  test("a modifier chord is not the scrubber's, and the range does not step behind its back", async () => {
    // ⌘⇧C copies the frame, so the scrubber must decline modifier chords —
    // and declining is not enough on its own. The range input acts on arrows
    // BY ITSELF, so a declined ⌘→ moved the playhead anyway: `decideKey` was
    // right and the control was a second author of the position. Caught here
    // and nowhere else; the pure test cannot see a native default action.
    const { win } = await openPreview();
    await seekTo(win, 120);
    await focusScrub(win);
    await win.keyboard.press("Meta+ArrowRight");
    await new Promise((r) => setTimeout(r, 200));
    expect(await frameOf(win)).toBe(120);
  }, 60_000);

  test("keys the grammar does not define do not move the playhead either", async () => {
    // PageUp/PageDown/Up/Down all step a focused range natively. None is in
    // the grammar, so before this each was an unruled way to move the
    // playhead — by a chunk, with no snap discipline and no readout of what
    // it had done.
    const { win } = await openPreview();
    await seekTo(win, 120);
    await focusScrub(win);
    for (const key of ["PageUp", "PageDown", "ArrowUp", "ArrowDown"]) {
      await win.keyboard.press(key);
      await new Promise((r) => setTimeout(r, 80));
      expect(await frameOf(win), `${key} moved the playhead`).toBe(120);
    }
  }, 60_000);
});

describe("the trim is drawn, not fenced (rule 4)", () => {
  test("the playhead still moves outside the trimmed range", async () => {
    const { win } = await openPreview();
    await seekTo(win, 60);
    await win.keyboard.press("i");
    await seekTo(win, 180);
    await win.keyboard.press("o");
    await expect.poll(() => win.textContent("#triminfo"), { timeout: 10_000 }).toMatch(/–/);

    // Outside the kept range in both directions. You must be able to look at
    // what you cut in order to know the cut was right.
    await seekTo(win, 10);
    expect(await frameOf(win)).toBe(10);
    await seekTo(win, 290);
    expect(await frameOf(win)).toBe(290);
  }, 60_000);

  test("the cut material is dimmed rather than removed", async () => {
    const { win } = await openPreview();
    await seekTo(win, 60);
    await win.keyboard.press("i");
    await seekTo(win, 180);
    await win.keyboard.press("o");
    await expect.poll(() => win.textContent("#triminfo"), { timeout: 10_000 }).toMatch(/–/);

    const widths = await win.evaluate(() => {
      const pct = (id: string) => (document.getElementById(id) as HTMLElement).style.width;
      return { head: pct("cut-head"), tail: pct("cut-tail"), kept: pct("kept") };
    });
    // 60/299 and (299-180)/299 of the track, give or take the percentage the
    // trim is stored at in ns.
    expect(parseFloat(widths.head)).toBeGreaterThan(15);
    expect(parseFloat(widths.head)).toBeLessThan(25);
    expect(parseFloat(widths.tail)).toBeGreaterThan(35);
    expect(parseFloat(widths.kept)).toBeGreaterThan(35);
  }, 60_000);
});

describe("rule 5's rubber band, dragged with a real pointer", () => {
  // Neither the pure test (clampTrimFrame/rubberBandPx in isolation) nor the
  // keyboard E2E above reaches this: onHandleMove's PIXEL math — where the
  // clamp sits on screen, and which way the excess is measured — is wiring
  // that only a real drag exercises. Found by hand on a real take (STC-338
  // runbook review): both directions were pinned dead at the clamp with no
  // creep, because `excess`'s sign was inverted in BOTH branches, so
  // `rubberBandPx` always saw a negative number and returned 0. Only the
  // red/wide `.held` styling ever showed — which read as "correct" at a
  // small overshoot and "all red" (frozen, exaggerated) at a large one, the
  // same zero-band bug looking different depending on how far you dragged.
  //
  // The trim used here holds the two handles FAR apart (frame 20 and 280 of
  // 299) rather than close together. On a narrow window the two 10px-wide
  // handle BUTTONS visually overlap almost entirely when they sit only a few
  // frames apart, and whichever is later in the DOM wins a hit-test tie —
  // the first draft of this test put them 10 frames apart and every click
  // meant for #trim-in silently landed on #trim-out instead. Pointer capture
  // (set at mousedown) is what makes the drag itself safe to run PAST the
  // other handle's position once it is under way; it is only the INITIAL
  // click that needs the two apart.
  const IN_START = 20;
  const OUT_START = 280;

  async function setWideTrim(win: any) {
    await seekTo(win, IN_START);
    await win.keyboard.press("i");
    await seekTo(win, OUT_START);
    await win.keyboard.press("o");
    await expect.poll(() => win.textContent("#triminfo"), { timeout: 10_000 }).toMatch(/–/);
  }

  async function dragHandleTo(win: any, handleId: string, clientX: number) {
    const box = await win.locator(`#${handleId}`).boundingBox();
    const y = box.y + box.height / 2;
    await win.mouse.move(box.x + box.width / 2, y);
    await win.mouse.down();
    await win.mouse.move(clientX, y, { steps: 4 });
  }

  test("dragging the IN handle past its clamp creeps RIGHTWARD, growing with distance", async () => {
    const { win } = await openPreview();
    await setWideTrim(win);

    const track = (await win.locator("#timeline").boundingBox())!;
    const clampedX = track.x + ((OUT_START - MIN_TRIM_FRAMES) / LAST_FRAME) * track.width;

    await dragHandleTo(win, "trim-in", clampedX + 40); // well past the clamp
    await expect.poll(
      () => win.evaluate(() => document.getElementById("trim-in")!.classList.contains("held")),
      { timeout: 10_000 },
    ).toBe(true);
    const marginPx = await win.evaluate(() =>
      parseFloat(getComputedStyle(document.getElementById("trim-in")!).marginLeft));
    // -5 is the CSS default with no creep at all — this is the bug's exact
    // signature (pinned dead at the clamp). A working rubber band must have
    // moved the margin toward the pointer, i.e. more positive than -5.
    expect(marginPx).toBeGreaterThan(-5);
    await win.mouse.up();
  }, 60_000);

  test("dragging the OUT handle past its clamp creeps LEFTWARD, growing with distance", async () => {
    const { win } = await openPreview();
    await setWideTrim(win);

    const track = (await win.locator("#timeline").boundingBox())!;
    const clampedX = track.x + ((IN_START + MIN_TRIM_FRAMES) / LAST_FRAME) * track.width;

    await dragHandleTo(win, "trim-out", clampedX - 40); // well past the clamp, toward the start
    await expect.poll(
      () => win.evaluate(() => document.getElementById("trim-out")!.classList.contains("held")),
      { timeout: 10_000 },
    ).toBe(true);
    const marginPx = await win.evaluate(() =>
      parseFloat(getComputedStyle(document.getElementById("trim-out")!).marginLeft));
    // Same signature, opposite side: -5 with no creep is the bug; a working
    // band must have moved the margin the OTHER way, more negative than -5.
    expect(marginPx).toBeLessThan(-5);
    await win.mouse.up();
  }, 60_000);

  test("the creep GROWS with how far past the clamp the pointer goes", async () => {
    // The asymptotic shape (rule 5) is the whole point of a rubber band over
    // a hard stop — this is what a fixed offset (a partial fix that pins the
    // handle at some constant distance regardless of drag distance) would
    // still fail to catch.
    const { win } = await openPreview();
    await setWideTrim(win);

    const track = (await win.locator("#timeline").boundingBox())!;
    const clampedX = track.x + ((OUT_START - MIN_TRIM_FRAMES) / LAST_FRAME) * track.width;
    const marginAt = async (px: number) => {
      await dragHandleTo(win, "trim-in", clampedX + px);
      await new Promise((r) => setTimeout(r, 50));
      const m = await win.evaluate(() =>
        parseFloat(getComputedStyle(document.getElementById("trim-in")!).marginLeft));
      await win.mouse.up();
      return m;
    };
    const near = await marginAt(10);
    await seekTo(win, IN_START); // reset the drag state cleanly between measurements
    await win.keyboard.press("i");
    const far = await marginAt(500);
    expect(far).toBeGreaterThan(near);
    expect(far).toBeLessThan(-5 + 24); // never exceeds RUBBER_BAND_PX
  }, 60_000);
});
describe("the export grid on the track (rule 9)", () => {
  test("ticks are drawn at a stride wide enough to read", async () => {
    const { win } = await openPreview();
    const ticks = await win.evaluate(() => {
      const el = document.getElementById("ticks") as HTMLElement;
      return {
        hidden: el.hasAttribute("hidden"),
        px: parseFloat(el.style.getPropertyValue("--tick-px")),
        trackPx: document.getElementById("timeline")!.getBoundingClientRect().width,
      };
    });
    expect(ticks.hidden).toBe(false);
    // Whatever stride was chosen, it must clear the legibility floor — the
    // point of rule 9 is that ticks are never sub-pixel hatching.
    expect(ticks.px).toBeGreaterThanOrEqual(6);
    // ...and it must be a stride over THIS take rather than a fixed number:
    // 300 frames over the track, so a tick is at most the whole track.
    expect(ticks.px).toBeLessThanOrEqual(ticks.trackPx);
  }, 60_000);
});
