/**
 * Authoring a window with no auto-zoom counterpart at all (STC-331), wired.
 *
 * `zoom-override.test.ts`/`zoom-override-project.test.ts` prove the pure
 * resolution and document logic with no screen; this drives the real editor
 * window the same way `zoom-override.e2e.test.ts` does for phase 1 — a click
 * on the lane's own empty background, a real drag on the resize handles and
 * on the preview's rect tool, and reading `project.json` back off disk.
 *
 * The fixture (`fixtures/basic`) is ~5.000s long with one DERIVED window at
 * [1705ms, 4505ms] (fraction [0.341, 0.901] of the lane) — every click here
 * lands past fraction 0.9, comfortably in the empty stretch after it, so a
 * click can never land on the derived `.zoomblock` by accident.
 */
import { describe, test, expect, afterEach } from "vitest";
import { type ElectronApplication, type Page } from "playwright";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { launchWithTakeInEditor, dragOnStage } from "./_editor-fixture.js";

let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

const MS = 1_000_000;
const CLICK_FRACTION = 0.98;

async function openPreview() {
  const { app: a, editorWin, takeDir } = await launchWithTakeInEditor();
  app = a;
  await expect.poll(() => editorWin.textContent("#clock"), { timeout: 20_000 }).toMatch(/^\d:\d\d:\d\d /);
  await expect.poll(() => editorWin.locator(".zoomblock").count(), { timeout: 10_000 }).toBe(1); // the one derived block
  return { win: editorWin, takeDir };
}

function readProject(takeDir: string): any {
  return JSON.parse(readFileSync(join(takeDir, "project.json"), "utf8"));
}

/**
 * A click on the lane's own empty background — never on a block, never on
 * #manualdraft.
 *
 * `scrollIntoViewIfNeeded()` before measuring is load-bearing, not
 * decoration: `zoom-override.e2e.test.ts`'s own `dragOnStage` needed the
 * identical fix for the identical reason (CLAUDE.md's STC-330 entry has the
 * full account) — on the real CI window's content height (taller than its
 * viewport, unlike this sandbox's Xvfb display), a lane below the preview
 * can sit off-screen until something scrolls it into view, and a click at
 * an off-screen y lands on nothing.
 */
async function clickEmptyLane(win: Page, fraction = CLICK_FRACTION): Promise<void> {
  await win.locator("#override-blocks").scrollIntoViewIfNeeded();
  const box = await win.locator("#override-blocks").boundingBox();
  if (!box) throw new Error("#override-blocks has no box");
  await win.mouse.click(box.x + fraction * box.width, box.y + box.height / 2);
}

/** Drags a manual window's own edge handle by a fraction of the FULL lane width. */
async function dragManualHandle(win: Page, which: "start" | "end", toFraction: number): Promise<void> {
  await win.locator(`#manualhandle-${which}`).scrollIntoViewIfNeeded();
  const laneBox = await win.locator("#override-blocks").boundingBox();
  const handle = await win.locator(`#manualhandle-${which}`).boundingBox();
  if (!laneBox || !handle) throw new Error("lane or handle has no box");
  const fromX = handle.x + handle.width / 2;
  const fromY = handle.y + handle.height / 2;
  const toX = laneBox.x + toFraction * laneBox.width;
  await win.mouse.move(fromX, fromY);
  await win.mouse.down();
  await win.mouse.move((fromX + toX) / 2, fromY);
  await win.mouse.move(toX, fromY);
  await win.mouse.up();
}

describe("clicking the lane's empty background authors a new window", () => {
  test("shows a manual block, the rect tool and the override bar immediately", async () => {
    const { win } = await openPreview();
    expect(await win.isHidden("#overridebar")).toBe(true);
    await clickEmptyLane(win);
    await expect.poll(() => win.locator(".zoomblock.manual").count(), { timeout: 10_000 }).toBe(1);
    expect(await win.isVisible("#overridebar")).toBe(true);
    expect(await win.isVisible("#rectoverlay")).toBe(true);
    // A manual block is drawn selected and already "overridden" — its
    // existence IS its geometry, unlike a derived block's dot.
    const cls = await win.evaluate(() => document.getElementById("manualdraft")!.className);
    expect(cls).toMatch(/\bselected\b/);
  }, 30_000);

  test("committing writes a manual override at the default stage-1 shape, with the project's own preset", async () => {
    const { win, takeDir } = await openPreview();
    await clickEmptyLane(win);
    await win.click("#overridedone");

    await expect.poll(() => readProject(takeDir).overrides?.length, { timeout: 10_000 }).toBe(1);
    const [o] = readProject(takeDir).overrides;
    expect(o.kind).toBe("manual");
    expect(typeof o.id).toBe("string");
    expect(o.id.length).toBeGreaterThan(0);
    // 300ms lead + 2500ms hold = 2800ms, modulo clamping to the take's end.
    expect(o.endNs - o.startNs).toBeLessThanOrEqual(2800 * MS + 1);
    expect(o.endNs - o.startNs).toBeGreaterThan(0);
    expect(o.endNs).toBeLessThanOrEqual(5_000_000_016);
    // A default-sized centred rect, the same shape a bare click on the
    // stage gives a geometry override (DEFAULT_OVERRIDE_RECT_FRACTION,
    // pinned in zoom-override.test.ts, not restated here).
    expect(o.rect.width).toBeGreaterThan(0.05);
    expect(o.rect.width).toBeLessThan(0.9);
    // The project has no zoom.preset override, so its default — "standard" — is what a manual window's required easing resolves to.
    expect(o.easing).toBe("standard");
  }, 30_000);

  test("a second manual window can coexist with the derived one", async () => {
    const { win, takeDir } = await openPreview();
    await clickEmptyLane(win);
    await win.click("#overridedone");
    await expect.poll(() => readProject(takeDir).overrides?.length, { timeout: 10_000 }).toBe(1);
    expect(await win.locator(".zoomblock").count()).toBe(2); // 1 derived + 1 manual
  }, 30_000);
});

describe("resizing a manual window by its edges", () => {
  test("dragging the end handle later changes the committed endNs", async () => {
    const { win, takeDir } = await openPreview();
    // A click near the START of the lane (default span [~200ms, ~3000ms])
    // leaves room for the end handle to move LATER — a click near the end
    // (this file's usual CLICK_FRACTION) clamps the default endNs to the
    // take's own duration already, which the next test's own failure first
    // caught: there was nowhere left for "later" to go.
    await clickEmptyLane(win, 0.1);
    const before = await win.evaluate(() => (document.getElementById("manualdraft") as HTMLElement).style.width);
    await dragManualHandle(win, "end", 1.0); // drag to the very end of the lane
    const after = await win.evaluate(() => (document.getElementById("manualdraft") as HTMLElement).style.width);
    expect(parseFloat(after)).toBeGreaterThan(parseFloat(before));

    await win.click("#overridedone");
    await expect.poll(() => readProject(takeDir).overrides?.length, { timeout: 10_000 }).toBe(1);
    const [o] = readProject(takeDir).overrides;
    // Dragged to the lane's own end — within a frame or two of the take's duration.
    expect(o.endNs).toBeGreaterThan(4_900 * MS);
  }, 30_000);

  test("the start handle cannot be dragged past the end handle minus the minimum duration", async () => {
    const { win, takeDir } = await openPreview();
    await clickEmptyLane(win);
    await dragManualHandle(win, "start", 1.0); // try to drag start past end
    await win.click("#overridedone");
    await expect.poll(() => readProject(takeDir).overrides?.length, { timeout: 10_000 }).toBe(1);
    const [o] = readProject(takeDir).overrides;
    expect(o.endNs).toBeGreaterThan(o.startNs); // never crossed, never zero-width
  }, 30_000);
});

describe("the rect tool on a manual window", () => {
  test("a real drag on the stage writes the dragged rect", async () => {
    const { win, takeDir } = await openPreview();
    await clickEmptyLane(win);
    await dragOnStage(win, { x: 0.2, y: 0.2 }, { x: 0.6, y: 0.5 });
    await win.click("#overridedone");

    await expect.poll(() => readProject(takeDir).overrides?.length, { timeout: 10_000 }).toBe(1);
    const [o] = readProject(takeDir).overrides;
    expect(o.rect.x).toBeCloseTo(0.2, 1);
    expect(o.rect.y).toBeCloseTo(0.2, 1);
    expect(o.rect.width).toBeCloseTo(0.4, 1);
    expect(o.rect.height).toBeCloseTo(0.3, 1);
  }, 30_000);
});

describe("the preset picker on a manual window", () => {
  test("a chosen easing is written on the override, required rather than falling back to the project", async () => {
    const { win, takeDir } = await openPreview();
    await clickEmptyLane(win);
    await win.selectOption("#overridepreset", "snappy");
    await win.click("#overridedone");

    await expect.poll(() => readProject(takeDir).overrides?.[0]?.easing, { timeout: 10_000 }).toBe("snappy");
  }, 30_000);
});

describe("deleting a manual window", () => {
  test("\"Delete window\" removes the whole entry, not just its geometry", async () => {
    const { win, takeDir } = await openPreview();
    await clickEmptyLane(win);
    await win.click("#overridedone");
    await expect.poll(() => readProject(takeDir).overrides?.length, { timeout: 10_000 }).toBe(1);

    await win.click(".zoomblock.manual");
    await expect.poll(() => win.textContent("#overrideclear"), { timeout: 10_000 }).toBe("Delete window");
    await win.click("#overrideclear");

    await expect.poll(() => readProject(takeDir).overrides?.length ?? 0, { timeout: 10_000 }).toBe(0);
    expect(await win.locator(".zoomblock.manual").count()).toBe(0);
  }, 30_000);
});

describe("re-opening a manual window without dragging", () => {
  test("does not lose it — entering edit mode to just look is a no-op, same as a derived block", async () => {
    const { win, takeDir } = await openPreview();
    await clickEmptyLane(win);
    await dragOnStage(win, { x: 0.15, y: 0.15 }, { x: 0.55, y: 0.55 });
    await win.click("#overridedone");
    await expect.poll(() => readProject(takeDir).overrides?.length, { timeout: 10_000 }).toBe(1);
    const before = readProject(takeDir).overrides[0];

    await win.click(".zoomblock.manual");
    await expect.poll(() => win.isVisible("#overridebar"), { timeout: 10_000 }).toBe(true);
    await win.keyboard.press("Escape");

    await expect.poll(() => win.isHidden("#overridebar"), { timeout: 10_000 }).toBe(true);
    expect(readProject(takeDir).overrides?.length).toBe(1);
    expect(readProject(takeDir).overrides[0]).toEqual(before);
  }, 30_000);
});
