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
import { launchWithTakeInEditor, dragOnStage } from "./_editor-fixture.js";

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
    await win.click("#closepreview");
    await expect.poll(() => app!.windows().length, { timeout: 10_000 }).toBeLessThan(before);
  }, 30_000);
});
