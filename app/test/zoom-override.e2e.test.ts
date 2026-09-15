/**
 * The manual zoom override lane and rect tool, wired (STC-330).
 *
 * `zoom-override.test.ts` and `zoom-override-project.test.ts` prove the pure
 * resolution logic and the document round trip with no screen; this drives
 * the real editor window — clicking a block, dragging a real pointer on the
 * preview, changing the preset — and reads `project.json` back off disk,
 * the same "pure tests prove decideKey decides, this proves the app does
 * what it decided" split `scrubber.e2e.test.ts` already established.
 *
 * The fixture (`fixtures/basic`) has one click at t=2005ms, 2155ms up — one
 * derived zoom window at [1705ms, 4505ms] (300ms lead, 2500ms hold), so
 * `windowId` is "1705000000" and there is exactly one `.zoomblock`.
 */
import { describe, test, expect, afterEach } from "vitest";
import { type ElectronApplication } from "playwright";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { launchWithTakeInEditor, closeEditorWindow } from "./_editor-fixture.js";

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

const WINDOW_ID = "1705000000";

async function openPreview() {
  const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
  app = a;
  await expect.poll(() => editorWin.textContent("#clock"), { timeout: 20_000 }).toMatch(/^\d:\d\d:\d\d /);
  await expect.poll(() => editorWin.locator(".zoomblock").count(), { timeout: 10_000 }).toBe(1);
  return { win: editorWin, takeDir };
}

function readProject(takeDir: string): any {
  return JSON.parse(readFileSync(join(takeDir, "project.json"), "utf8"));
}

const blockClass = (win: any): Promise<string> =>
  win.evaluate(() => document.querySelector(".zoomblock")!.className);

/**
 * The FIRST fix here settled `#stage`'s own box and it was not enough — the
 * same 6 tests failed identically on the next real-hardware run, which rules
 * out a plain reflow race (that fix already waits for `#rectoverlay` to be
 * visible and for the box to stop moving). The remaining suspect is the box
 * itself: `#rectoverlay` is `position: absolute; inset: 0` of `#stagewrap`,
 * not of `#stage` — editor.html's own comment claims "`#stage` always fills
 * `#stagewrap` at its own natural size, so `inset: 0` tracks it", which is
 * exactly the kind of invariant that can silently stop holding (a scrollbar,
 * a constrained window height on a real display this sandbox cannot
 * reproduce) without anything here noticing. Rather than trust that claim a
 * second time, measure the element pointer events actually land on —
 * `#rectoverlay` itself — so a click computed from it can never miss it,
 * whatever `#stage`'s own box turns out to be. Still settled the same way
 * `redaction.e2e.test.ts`'s `settledCanvasBox` is, since the reflow race is
 * real even if it was not the whole story.
 */
async function settledRectoverlayBox(
  win: any, ms = 10_000,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const read = () => win.locator("#rectoverlay").boundingBox();
  const start = Date.now();
  let last = await read();
  for (;;) {
    await new Promise((r) => setTimeout(r, 120));
    const now = await read();
    if (last && now && now.x === last.x && now.y === last.y
        && now.width === last.width && now.height === last.height && now.width > 0) {
      return now;
    }
    if (Date.now() - start > ms) {
      throw new Error(`#rectoverlay never settled: ${JSON.stringify({ last, now })}`);
    }
    last = now;
  }
}

/**
 * FOUND (2026-09-14, real hardware, via pointer-event instrumentation this
 * function used to carry): `.zoomblock` is a `<button>`, clicking it moves
 * focus to it, and it sits at the BOTTOM of the editor's timeline while
 * `#stage` sits at the TOP — on a window whose content is taller than its
 * viewport (true on the real CI window size, not under this sandbox's Xvfb
 * display), Chromium scrolls the newly-focused button into view, which
 * scrolls #stage/#rectoverlay PARTLY OFF THE TOP (`getBoundingClientRect()`
 * returned `y: -150`). Every failing drag's start point landed at a
 * NEGATIVE viewport y — off-screen, so `mouse.down()` there hit nothing
 * (`pointerdown` count: 0, confirmed directly). The one gesture that kept
 * passing targeted dead centre (0.5, 0.5), which happened to still clear
 * zero. `scrollIntoViewIfNeeded` before measuring is the fix, and it is
 * unconditional rather than reasoned about, because the same trap applies
 * however layout got that way on a given machine.
 */
async function dragOnStage(
  win: any, from: { x: number; y: number }, to: { x: number; y: number },
): Promise<void> {
  await expect.poll(() => win.isVisible("#rectoverlay"), { timeout: 10_000 }).toBe(true);
  await win.locator("#rectoverlay").scrollIntoViewIfNeeded();
  const box = await settledRectoverlayBox(win);
  const p = (f: { x: number; y: number }) => ({ x: box.x + f.x * box.width, y: box.y + f.y * box.height });
  const a = p(from), b = p(to);
  await win.mouse.move(a.x, a.y);
  await win.mouse.down();
  // Two moves, not one: a single move can be coalesced with the press
  // (redaction.e2e.test.ts's own precedent for the same reason), and this is
  // testing that a DRAG is followed rather than that a click lands.
  await win.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2);
  await win.mouse.move(b.x, b.y);
  await win.mouse.up();
}

describe("selecting a block", () => {
  test("shows the rect tool and the override bar", async () => {
    const { win } = await openPreview();
    expect(await win.isHidden("#overridebar")).toBe(true);
    expect(await win.isHidden("#rectoverlay")).toBe(true);
    await win.click(".zoomblock");
    await expect.poll(() => win.isVisible("#overridebar"), { timeout: 10_000 }).toBe(true);
    expect(await win.isVisible("#rectoverlay")).toBe(true);
    expect(await blockClass(win)).toMatch(/\bselected\b/);
  });

  test("seeks the preview into the window", async () => {
    const { win } = await openPreview();
    // The playhead (#scrub's own value IS the export frame, STC-338 rule 1)
    // starts at 0; the window is [1705ms, 4505ms], so its midpoint lands
    // somewhere in [102, 270] at 60fps — asserting a RANGE rather than the
    // exact midpoint frame, since that rounding is an implementation detail
    // this test should not pin.
    const frameOf = () => win.evaluate(() => Number((document.getElementById("scrub") as HTMLInputElement).value));
    expect(await frameOf()).toBe(0);
    await win.click(".zoomblock");
    await expect.poll(frameOf, { timeout: 10_000 }).toBeGreaterThan(100);
    expect(await frameOf()).toBeLessThan(271);
  });
});

describe("dragging a rect", () => {
  test("a real drag writes a geometry override with the dragged rect", async () => {
    const { win, takeDir } = await openPreview();
    await win.click(".zoomblock");
    await dragOnStage(win, { x: 0.2, y: 0.2 }, { x: 0.7, y: 0.6 });
    await win.click("#overridedone");

    await expect.poll(() => existsSync(join(takeDir, "project.json")), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => readProject(takeDir).overrides?.length, { timeout: 10_000 }).toBe(1);
    const project = readProject(takeDir);

    expect(project.version).toBe(6);
    const [o] = project.overrides;
    expect(o.kind).toBe("geometry");
    expect(o.windowId).toBe(WINDOW_ID);
    expect(o.rect.x).toBeCloseTo(0.2, 1);
    expect(o.rect.y).toBeCloseTo(0.2, 1);
    expect(o.rect.width).toBeCloseTo(0.5, 1);
    expect(o.rect.height).toBeCloseTo(0.4, 1);
  }, 30_000);

  test("a bare click (no drag) still writes a default-sized rect", async () => {
    const { win, takeDir } = await openPreview();
    await win.click(".zoomblock");
    await dragOnStage(win, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }); // down+up at the same point
    await win.click("#overridedone");

    await expect.poll(() => readProject(takeDir).overrides?.length ?? 0, { timeout: 10_000 }).toBe(1);
    const [o] = readProject(takeDir).overrides;
    // Centred roughly on the click, non-trivially sized (not the whole frame,
    // not a sliver) — the exact fraction is DEFAULT_OVERRIDE_RECT_FRACTION,
    // pinned in zoom-override.test.ts, not restated here.
    expect(o.rect.width).toBeGreaterThan(0.05);
    expect(o.rect.width).toBeLessThan(0.9);
    expect(o.rect.x + o.rect.width / 2).toBeCloseTo(0.5, 1);
    expect(o.rect.y + o.rect.height / 2).toBeCloseTo(0.5, 1);
  }, 30_000);

  test("the block shows the overridden dot once a rect is committed", async () => {
    const { win } = await openPreview();
    await win.click(".zoomblock");
    await dragOnStage(win, { x: 0.1, y: 0.1 }, { x: 0.4, y: 0.4 });
    await win.click("#overridedone");
    await expect.poll(() => blockClass(win), { timeout: 10_000 }).toMatch(/\boverridden\b/);
  }, 30_000);
});

describe("the preset picker", () => {
  test("a chosen easing is written on the override and read back on reopen", async () => {
    const { win, takeDir } = await openPreview();
    await win.click(".zoomblock");
    await dragOnStage(win, { x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 });
    await win.selectOption("#overridepreset", "snappy");
    await win.click("#overridedone");

    await expect.poll(() => readProject(takeDir).overrides?.[0]?.easing, { timeout: 10_000 }).toBe("snappy");

    // Reopening the same block shows the stored preset, not the default.
    await win.click(".zoomblock");
    await expect.poll(() => win.inputValue("#overridepreset"), { timeout: 10_000 }).toBe("snappy");
    await win.click("#overridedone");
  }, 30_000);
});

describe("removing an override", () => {
  test("clears the entry from project.json", async () => {
    const { win, takeDir } = await openPreview();
    await win.click(".zoomblock");
    await dragOnStage(win, { x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 });
    await win.click("#overridedone");
    await expect.poll(() => readProject(takeDir).overrides?.length, { timeout: 10_000 }).toBe(1);

    await win.click(".zoomblock");
    await expect.poll(() => win.isEnabled("#overrideclear"), { timeout: 10_000 }).toBe(true);
    await win.click("#overrideclear");

    await expect.poll(() => readProject(takeDir).overrides?.length ?? 0, { timeout: 10_000 }).toBe(0);
    await expect.poll(() => win.isHidden("#overridebar"), { timeout: 10_000 }).toBe(true);
    expect(await blockClass(win)).not.toMatch(/\boverridden\b/);
  }, 30_000);
});

describe("re-opening a block without dragging", () => {
  test("does not lose an existing override — entering edit mode to just look is a no-op", async () => {
    const { win, takeDir } = await openPreview();
    await win.click(".zoomblock");
    await dragOnStage(win, { x: 0.15, y: 0.15 }, { x: 0.55, y: 0.55 });
    await win.click("#overridedone");
    await expect.poll(() => readProject(takeDir).overrides?.length, { timeout: 10_000 }).toBe(1);
    const before = readProject(takeDir).overrides[0];

    // Open the block again and leave immediately with Escape — no drag.
    await win.click(".zoomblock");
    await expect.poll(() => win.isVisible("#overridebox"), { timeout: 10_000 }).toBe(true);
    await win.keyboard.press("Escape");

    await expect.poll(() => win.isHidden("#overridebar"), { timeout: 10_000 }).toBe(true);
    expect(readProject(takeDir).overrides?.length).toBe(1);
    expect(readProject(takeDir).overrides[0]).toEqual(before);
  }, 30_000);
});

describe("closing the whole window mid-edit", () => {
  // #closepreview calls window.close() directly (editor.ts) — a different
  // path from switching takes in the SAME window (which runs closeTake()'s
  // own mid-edit reset, exercised structurally rather than through a second
  // take fixture here). This is the smoke test for THAT path: an override
  // dragged but never committed with Done must not make the window's own
  // teardown throw, whatever main.ts's beforeunload handler does with it.
  test("does not throw with an override drafted but never committed", async () => {
    const { win } = await openPreview();
    await win.click(".zoomblock");
    await dragOnStage(win, { x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 });
    expect(await win.isVisible("#overridebox")).toBe(true);
    const before = app!.windows().length;
    await closeEditorWindow(win);
    await expect.poll(() => app!.windows().length, { timeout: 10_000 }).toBeLessThan(before);
  }, 30_000);
});
