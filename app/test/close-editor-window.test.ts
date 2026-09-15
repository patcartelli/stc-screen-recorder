/**
 * `closeEditorWindow`'s three outcomes, pinned at the SOURCE (STC-386).
 *
 * Master run 418 went red at `preview.e2e.test.ts:132` with "Target page,
 * context or browser has been closed" — on a Close button that worked. The
 * editor's handler calls `window.close()` synchronously, so the click can
 * destroy the page Playwright is still doing its post-click bookkeeping on,
 * and `click()` then rejects for a click that landed.
 *
 * Reproducing that live needs a real window to lose a real click at a real
 * instant, which is the multi-way timing coincidence this repo has already
 * paid for chasing (STC-343's discard race, pinned the same way). So the
 * helper's decision is driven directly against a stub page instead.
 *
 * The load-bearing test is the THIRD one. A fix that simply swallowed the
 * click's error would pass the first two and is exactly how a tolerance
 * becomes a test that cannot fail — the repo's own "a green tick bought by
 * loosening an assertion" lesson. Case 3 is the positive discriminator: with
 * `catch(() => {})` in place of the real body it passes silently, and here it
 * must still throw, with the CLICK's error rather than the close's.
 */
import { describe, test, expect } from "vitest";
import type { Page } from "playwright";
import { closeEditorWindow } from "./_editor-fixture.js";

/**
 * A page that answers only what the helper asks of it: `click` and
 * `waitForEvent("close")`. `never` models the outcome that does not happen —
 * a close that never fires, or a click that never settles.
 */
function stubPage(opts: {
  click: "resolve" | "reject";
  close: "fire" | "never";
}): Page {
  const clickError = new Error('page.click: Target page, context or browser has been closed');
  return {
    click: async () => {
      if (opts.click === "reject") throw clickError;
    },
    waitForEvent: (event: string, o?: { timeout?: number }) => {
      expect(event).toBe("close");
      if (opts.close === "fire") return Promise.resolve(undefined);
      // A close that never comes must REJECT the way Playwright's own
      // timeout does, not hang the test out to the runner's bound.
      return new Promise((_, rej) =>
        setTimeout(() => rej(new Error(`waitForEvent("close") timed out`)), o?.timeout ?? 0));
    },
  } as unknown as Page;
}

describe("closeEditorWindow (STC-386)", () => {
  test("the ordinary path: the click lands and the window closes", async () => {
    await expect(closeEditorWindow(stubPage({ click: "resolve", close: "fire" }), 50))
      .resolves.toBeUndefined();
  });

  test("the race: the click loses its own page to the close it caused", async () => {
    // This is run 418's failure. It must now be a PASS, because the only way
    // to lose the page to this click is to have closed the window with it.
    await expect(closeEditorWindow(stubPage({ click: "reject", close: "fire" }), 50))
      .resolves.toBeUndefined();
  });

  test("a click that genuinely failed still throws, with the CLICK's error", async () => {
    // The tolerance may not become a blanket catch. No close means the click
    // did not do its job, and the click's own message is the informative one
    // — "could not find #closepreview" says more than a close that timed out
    // waiting on a click that never happened.
    await expect(closeEditorWindow(stubPage({ click: "reject", close: "never" }), 20))
      .rejects.toThrow(/Target page, context or browser has been closed/);
  });

  test("a click that lands on a button that does nothing still throws", async () => {
    // The `closed` await is the real assertion and is not skipped on the
    // happy path: a Close button wired to nothing must still fail the suite.
    await expect(closeEditorWindow(stubPage({ click: "resolve", close: "never" }), 20))
      .rejects.toThrow(/timed out/);
  });
});
