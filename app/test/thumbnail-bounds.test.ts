import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SETTLE_READY_MS } from "../src/thumbnail.js";

/**
 * The panel's two settle bounds, and the clearance between them.
 *
 * `thumbnail-window.ts` cannot be imported here — it pulls in `electron`, which
 * a plain test runner has no runtime for — so its constant is READ OUT OF THE
 * SOURCE, the way `helper/test/stop-bounds.test.ts` reads reason literals out
 * of the Swift call sites. That is not a workaround: a test carrying its own
 * copy of the number would be the third copy, and a third copy is the drift
 * this file exists to prevent.
 */

const windowSrc = readFileSync(
  fileURLToPath(new URL("../src/thumbnail-window.ts", import.meta.url)), "utf8");

/** The backstop, parsed from the module that owns it. */
function backstopMs(): number {
  const m = /export const SETTLE_BACKSTOP_MS = ([0-9_]+);/.exec(windowSrc);
  // Throws rather than defaulting: a rename must break this loudly, not
  // silently compare against a number nobody is using any more.
  if (!m?.[1]) throw new Error("SETTLE_BACKSTOP_MS not found in thumbnail-window.ts");
  return Number(m[1].replace(/_/g, ""));
}

describe("the settle chain", () => {
  test("the readiness wait clears the window's destroy backstop", () => {
    // Below, not merely different: main destroys the window SETTLE_BACKSTOP_MS
    // after asking it to settle, so a readiness wait at or above that can
    // never finish — the panel would still lose the shot, just later.
    expect(SETTLE_READY_MS).toBeLessThan(backstopMs());
  });

  test("with room to spare — the export itself still has to run", () => {
    // The wait is not the whole settle: composite, encode and pasteboard all
    // happen after it, inside the same backstop. A clearance of one
    // millisecond would satisfy the assertion above and leave no time to do
    // the work the wait exists to enable.
    expect(backstopMs() - SETTLE_READY_MS).toBeGreaterThanOrEqual(3_000);
  });

  test("the backstop is really read from the other module, not restated here", () => {
    // Guards the parse itself: if the regex stopped matching, `backstopMs`
    // throws, and both assertions above would fail for the wrong reason.
    expect(backstopMs()).toBeGreaterThan(0);
    expect(windowSrc).toContain("SETTLE_BACKSTOP_MS");
  });
});
