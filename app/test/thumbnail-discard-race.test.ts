import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The discard-vs-timeout race, source-level (STC-343).
 *
 * A discard (swipe release, or the right-click Delete) asks main to trash the
 * capture — an async round trip. The panel's own timeout is a SEPARATE timer
 * in the main process with no idea a discard is in flight, so before this the
 * timer could fire in the gap before `deleteShot` resolves: `settleAndDestroy`
 * would hide the window, and if the delete then FAILS, the renderer's
 * recovery (it restores the panel and reports the error) happens inside a
 * window main has already hidden — invisible, and still headed for a silent
 * destroy at `SETTLE_BACKSTOP_MS` regardless of the failure.
 *
 * There is no live way to prove the race is closed here: reproducing it needs
 * a real `BrowserWindow`, a real timer landing inside a real IPC round trip,
 * AND an injected delete failure, all at once — the kind of multi-way timing
 * coincidence this repo has already paid for chasing as a live test (see
 * CLAUDE.md's overlay flake and STC-292's Dock trap). So this pins the source
 * property that makes the race impossible BY CONSTRUCTION instead: the
 * `discarding` event is sent before anything async, and both the renderer
 * that sends it and the window that receives it agree on the name.
 */
const src = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8");
const RENDERER = src("src", "thumbnail-renderer.ts");
const WINDOW = src("src", "thumbnail-window.ts");

describe("discard stops the panel's own timer before anything async", () => {
  test("the renderer sends \"discarding\" as the FIRST statement in discard(), before settling or the delete", () => {
    const fn = RENDERER.match(/async function discard\(\): Promise<void> \{([\s\S]*?)\n\}/);
    expect(fn, "discard() not found").toBeTruthy();
    const body = fn![1]!;
    const sentAt = body.indexOf('kind: "discarding"');
    const settlingAt = body.indexOf("settling = true");
    const deleteAt = body.indexOf("window.thumb.deleteShot");
    expect(sentAt).toBeGreaterThan(-1);
    expect(settlingAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(-1);
    // Order matters: sending it AFTER the delete had already started would
    // leave exactly the gap this exists to close.
    expect(sentAt).toBeLessThan(settlingAt);
    expect(sentAt).toBeLessThan(deleteAt);
  });

  test("thumbnail-window.ts clears the timer on \"discarding\", without marking the panel expanded", () => {
    const branch = WINDOW.match(/ev\.kind === "discarding"\) \{([\s\S]*?)\}/);
    expect(branch, '"discarding" branch not found in onEvent').toBeTruthy();
    expect(branch![1]).toContain("this.clearTimers()");
    // A discarded panel is not an expanded one — conflating them would be a
    // second, unrelated way for this fix to be wrong.
    expect(branch![1]).not.toContain("this.expanded = true");
  });

  test("the event name agrees on both sides of the process boundary", () => {
    expect(RENDERER).toContain('kind: "discarding"');
    expect(WINDOW).toMatch(/kind:\s*"discarding"/);
  });

  /**
   * The controls: this guard must be able to fire. Planting the old,
   * unordered shape (send after the delete starts) proves the position
   * assertion is not vacuously true.
   */
  test("control: a discard() that sends \"discarding\" AFTER the delete starts fails the ordering assertion", () => {
    const planted = `async function discard(): Promise<void> {
  settling = true;
  await window.thumb.deleteShot(dir);
  window.thumb.event({ kind: "discarding" });
}`;
    const fn = planted.match(/async function discard\(\): Promise<void> \{([\s\S]*?)\n\}/)!;
    const body = fn[1]!;
    const sentAt = body.indexOf('kind: "discarding"');
    const deleteAt = body.indexOf("window.thumb.deleteShot");
    expect(sentAt).toBeGreaterThan(deleteAt);
  });

  test("control: a branch that sets expanded instead of clearing timers fails the handler assertion", () => {
    const planted = `if (this.done) return;
    if (ev.kind === "discarding") {
      this.expanded = true;
    }`;
    const branch = planted.match(/ev\.kind === "discarding"\) \{([\s\S]*?)\}/)!;
    expect(branch[1]).not.toContain("this.clearTimers()");
  });
});
