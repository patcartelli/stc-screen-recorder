import { describe, test, expect } from "vitest";
import {
  initialState, show, expand, isExpired, dismiss, positionFor,
  clampTimeoutMs, parseCorner, parseSettleAction,
  DEFAULT_THUMBNAIL_TIMEOUT_MS, MIN_THUMBNAIL_TIMEOUT_MS, CORNERS,
  type ThumbnailState,
} from "../src/thumbnail.js";

/**
 * STC-296's panel decisions, without a window or a real clock.
 *
 * The wiring — a real `BrowserWindow`, the real timer, hiding it for a
 * subsequent capture — is `app/test/thumbnail.e2e.test.ts`'s job; this is
 * everything that can be settled by argument.
 */

describe("the panel state machine", () => {
  test("starts idle", () => {
    expect(initialState()).toEqual({ kind: "idle" });
  });

  test("a capture always shows the panel, from idle or from a still-open one", () => {
    const now = 1_000;
    expect(show(now, 6000)).toEqual({ kind: "showing", expiresAt: 7000 });
    // A second capture while the panel is EXPANDED still produces a fresh
    // `showing` state — stacking is deferred (see the module doc), so this
    // slice replaces rather than queues, and the caller is the one that
    // destroys whatever window the old state pointed at.
    const expanded: ThumbnailState = { kind: "expanded" };
    expect(show(now, 6000)).not.toBe(expanded);
    expect(show(now, 6000).kind).toBe("showing");
  });

  test("clicking expands, and is idempotent once already expanded", () => {
    const showing = show(0, 6000);
    expect(expand(showing)).toEqual({ kind: "expanded" });
    expect(expand(expand(showing))).toEqual({ kind: "expanded" });
  });

  test("clicking idle does nothing — there is nothing to expand", () => {
    expect(expand(initialState())).toEqual({ kind: "idle" });
  });

  test("isExpired is true only once showing and past its own deadline", () => {
    const showing = show(0, 3000);
    expect(isExpired(showing, 2999)).toBe(false);
    expect(isExpired(showing, 3000)).toBe(true);
    expect(isExpired(showing, 999_999)).toBe(true);
  });

  test("isExpired is never true once expanded — the click cancels the clock", () => {
    const expanded = expand(show(0, 3000));
    expect(isExpired(expanded, 999_999)).toBe(false);
  });

  test("isExpired is false for idle", () => {
    expect(isExpired(initialState(), 999_999)).toBe(false);
  });

  test("dismiss always returns to idle", () => {
    expect(dismiss()).toEqual({ kind: "idle" });
  });
});

describe("the timeout preference", () => {
  test("an absent or non-numeric value is the default", () => {
    for (const bad of [undefined, null, "6000", {}, NaN, Infinity]) {
      expect(clampTimeoutMs(bad), JSON.stringify(bad)).toBe(DEFAULT_THUMBNAIL_TIMEOUT_MS);
    }
  });

  test("never less than the floor — the ticket's own rule", () => {
    expect(clampTimeoutMs(0)).toBe(MIN_THUMBNAIL_TIMEOUT_MS);
    expect(clampTimeoutMs(-500)).toBe(MIN_THUMBNAIL_TIMEOUT_MS);
    expect(clampTimeoutMs(2999)).toBe(MIN_THUMBNAIL_TIMEOUT_MS);
  });

  test("a value at or above the floor is kept, rounded", () => {
    expect(clampTimeoutMs(3000)).toBe(3000);
    expect(clampTimeoutMs(10_000.6)).toBe(10_001);
  });
});

describe("the corner preference", () => {
  test("all four corners round-trip", () => {
    for (const c of CORNERS) expect(parseCorner(c)).toBe(c);
  });

  test("anything else falls back to the default rather than to nothing", () => {
    for (const bad of [undefined, null, "middle", 1, {}]) {
      expect(parseCorner(bad)).toBe("bottom-right");
    }
  });
});

describe("the settle-action preference", () => {
  test("only \"copy\" is copy; everything else is the save default", () => {
    expect(parseSettleAction("copy")).toBe("copy");
    for (const other of ["save", undefined, null, "COPY", 1, {}]) {
      expect(parseSettleAction(other), JSON.stringify(other)).toBe("save");
    }
  });
});

describe("corner positioning", () => {
  // A work area that is NOT at the origin and NOT the same as a display's full
  // bounds — the one a single-monitor-at-(0,0) test would hide.
  const workArea = { x: 200, y: 100, width: 1600, height: 900 };
  const size = { width: 220, height: 150 };

  test("each corner lands inside the work area, margin from both edges it names", () => {
    expect(positionFor("bottom-right", workArea, size, 20))
      .toEqual({ x: 200 + 1600 - 220 - 20, y: 100 + 900 - 150 - 20 });
    expect(positionFor("top-left", workArea, size, 20))
      .toEqual({ x: 220, y: 120 });
    expect(positionFor("top-right", workArea, size, 20))
      .toEqual({ x: 200 + 1600 - 220 - 20, y: 120 });
    expect(positionFor("bottom-left", workArea, size, 20))
      .toEqual({ x: 220, y: 100 + 900 - 150 - 20 });
  });

  test("a bigger margin pushes it further from both edges it applies to", () => {
    const tight = positionFor("bottom-right", workArea, size, 10);
    const loose = positionFor("bottom-right", workArea, size, 40);
    expect(loose.x).toBeLessThan(tight.x);
    expect(loose.y).toBeLessThan(tight.y);
  });
});
