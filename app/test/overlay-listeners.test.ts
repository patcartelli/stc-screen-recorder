import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Two properties of the overlay that only source can state, both of them
 * lessons from `still-overlay.e2e.test.ts` going red on master (#209, #213).
 */
const src = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8");
const SESSION = src("src", "overlay-session.ts");
const VIEW = src("src", "overlay.ts");
const E2E = src("test", "still-overlay.e2e.test.ts");

/** The env var that turns real input off. One name, three files. */
const FLAG = "STC_OVERLAY_SYNTHETIC_INPUT";

describe("the overlay takes input from ONE source at a time", () => {
  /**
   * The flake, and the only thing that fixed it.
   *
   * The E2E suite injects events through `window.overlay.send`, and the view's
   * own DOM handlers call that same bridge — so the window server was a second
   * writer. A real `pointermove` at the parked cursor landing between an
   * injected move and its pointerup rewrote the marquee: measured here as a
   * crop 540 wide instead of 200, 540 being exactly anchor-to-screen-centre.
   * On CI it landed the other way and the polluted rect confirmed to nothing,
   * which `reduce` makes a no-op, so the overlay never settled and the
   * assertion read `expected '' to contain 'macOS 14'` with no other evidence.
   *
   * Measured over 12 runs each, identical code but for this flag: 3 failures
   * without it, 0 with it.
   *
   * The chain is three files and would rot silently — dropping the env var
   * from the suite reintroduces the flake and nothing else would notice, which
   * is how a fix becomes a comment about a fix.
   */
  test("the E2E suite disables real input, and both halves of the chain honour it", () => {
    expect(E2E).toContain(FLAG);
    // The session turns the env var into a query parameter for the view…
    expect(SESSION).toContain(FLAG);
    expect(SESSION).toMatch(/synthetic:\s*"1"/);
    // …and the view reads that parameter and gates its listeners on it.
    expect(VIEW).toMatch(/get\("synthetic"\)/);
    expect(VIEW).toMatch(/if\s*\(!SYNTHETIC_INPUT\)\s*installRealInput\(\)/);
  });

  test("real input is installed by default — the flag suppresses, never enables", () => {
    // A view that only ever listened when asked to would pass the test above
    // and ship an overlay no human could use. The guard is the negation.
    expect(VIEW).not.toMatch(/if\s*\(SYNTHETIC_INPUT\)\s*installRealInput\(\)/);
    expect(VIEW).toContain("function installRealInput()");
  });
});

/**
 * The overlay's `screen` subscriptions must be matched by removals.
 *
 * `OverlaySession` keeps its display list live while the overlay is up,
 * because a snapshot taken in the constructor is a HANG rather than a stale
 * readout: `confirm()` refuses a rect that overlaps none of the displays it is
 * given, `reduce` treats an unconfirmable Return as a no-op, and the promise
 * `still:capture` awaits is then settled by nothing.
 *
 * This is a SEPARATE latent fault from the flake above — it was the first
 * hypothesis for it and turned out not to be the cause — but it is the same
 * unbounded wait, and `selection.test.ts` pins the no-op that makes it fatal.
 *
 * The subscriptions are on Electron's `screen`, a PROCESS-WIDE emitter that
 * outlives the session, so one leaked listener per capture would accumulate
 * for the life of the app and broadcast into a destroyed session. The removals
 * are load-bearing rather than tidiness.
 *
 * Source-level because the alternative needs a display server that can gain
 * and lose a monitor on demand, which no machine in this project's CI has —
 * the same reason `gate-bounds.test.ts` reads the gates' source rather than
 * running them. It checks the pairing, which is what a leak breaks; it cannot
 * check that the handler does the right thing, and does not claim to.
 */
describe("the overlay's screen subscriptions", () => {
  const eventsFor = (call: "on" | "removeListener"): string[] =>
    [...SESSION.matchAll(new RegExp(`screen\\.${call}\\(\\s*"([^"]+)"`, "g"))]
      .map((m) => m[1]!)
      .sort();

  test("every screen event it listens to is also removed", () => {
    const added = eventsFor("on");
    // A guard that passes because nothing subscribes would be vacuous — it
    // must fail if the live-display refresh is deleted, not just the removals.
    expect(added.length).toBeGreaterThan(0);
    expect(eventsFor("removeListener")).toEqual(added);
  });

  test("the display list is rebuilt, not read once into a constant", () => {
    // Subscribing and then doing nothing with the event would satisfy the
    // pairing test above while restoring the original bug.
    expect(SESSION).toMatch(/this\.ctx\.displays\s*=\s*screen\.getAllDisplays\(\)/);
  });
});
