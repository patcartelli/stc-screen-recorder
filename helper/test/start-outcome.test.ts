import { describe, test, expect } from "vitest";
import { classifyStartRefusal, explainFailedStart } from "./_start-outcome.js";

/**
 * The classifier, against real payloads.
 *
 * The `-3805` case is not synthesised: it is the outcome an actual
 * `npm run test:capture` produced on 2026-09-09, on a Mac whose Screen
 * Recording grant was fine, while the old code reported SKIP-GRANT sixteen
 * times. Pasting the real thing is the difference between testing the
 * classifier and testing my idea of what the helper says.
 */
const BUSY = {
  code: "stream-failed",
  detail: "SCStream failed to start: Error Domain=com.apple.ScreenCaptureKit.SCStreamErrorDomain "
        + "Code=-3805 \"Failed during stream due to application connection being interrupted\" "
        + "UserInfo={NSLocalizedDescription=Failed during stream due to application connection being interrupted}",
  ev: "error",
  seq: 1,
  t: 332980567023250,
};

/** What TCC actually looks like: SCShareableContent lists nothing. */
const NO_GRANT = { ev: "error", code: "no-displays", seq: 1 };

/**
 * STC-315. The SECOND missing grant, and the one this repo had no vocabulary
 * for: Screen Recording can be perfectly fine and the take still refused,
 * because the cursor is never only in the video.
 */
const NO_TAP = {
  ev: "error",
  code: "event-tap-unavailable",
  detail: "cursor input could not be recorded (CGEvent.tapCreate returned nil) — "
        + "Input Monitoring is the usual cause. The cursor is never only in the "
        + "video, so a take with no cursor track is not started at all.",
  seq: 1,
};

describe("classifyStartRefusal", () => {
  test("no-displays is the missing grant, and it is the ONLY missing grant", () => {
    expect(classifyStartRefusal(NO_GRANT)).toEqual({ kind: "no-grant" });
  });

  test("-3805 is a busy display, not a permission problem", () => {
    expect(classifyStartRefusal(BUSY)).toEqual({ kind: "display-busy" });
  });

  test("the two are told APART — which is the entire point", () => {
    // Before this module both produced "this environment has no Screen
    // Recording grant". A classifier that cannot separate them would pass
    // every test above and still be the bug.
    expect(classifyStartRefusal(BUSY)).not.toEqual(classifyStartRefusal(NO_GRANT));
  });

  test("event-tap-unavailable is the Input Monitoring grant, told apart from the other two", () => {
    expect(classifyStartRefusal(NO_TAP)).toEqual({ kind: "no-input-monitoring" });
    // The load-bearing half: three refusals, three answers. A classifier that
    // folded this into "no-grant" would pass the line above and send the
    // reader to the wrong pane in System Settings — which is the exact defect
    // this module was written to remove, one grant later.
    expect(classifyStartRefusal(NO_TAP)).not.toEqual(classifyStartRefusal(NO_GRANT));
    expect(classifyStartRefusal(NO_TAP)).not.toEqual(classifyStartRefusal(BUSY));
  });

  test("anything else is admitted as unclassified rather than guessed", () => {
    expect(classifyStartRefusal({ ev: "error", code: "disk-full" })).toEqual({ kind: "unclassified" });
    expect(classifyStartRefusal({ ev: "error" })).toEqual({ kind: "unclassified" });
    expect(classifyStartRefusal({})).toEqual({ kind: "unclassified" });
  });

  test("a non-string detail does not throw", () => {
    expect(classifyStartRefusal({ code: "x", detail: 42 as unknown as string }))
      .toEqual({ kind: "unclassified" });
  });
});

describe("explainFailedStart — what the reader is told", () => {
  test("only a real missing grant says SKIP-GRANT", () => {
    // The runner and any log-scraping key on this string. A busy display
    // wearing it is how an environment fault gets filed under permissions.
    expect(explainFailedStart(NO_GRANT, "the capture path").message).toContain("SKIP-GRANT");
    expect(explainFailedStart(BUSY, "the capture path").message).not.toContain("SKIP-GRANT");
    expect(explainFailedStart({ code: "?" }, "the capture path").message).not.toContain("SKIP-GRANT");
    // STC-315: Input Monitoring is a real missing grant too, so it earns the
    // string — the runner's skip accounting must see it as a skip and not as
    // a failure of the thing under test.
    expect(explainFailedStart(NO_TAP, "the capture path").message).toContain("SKIP-GRANT");
  });

  test("the Input Monitoring message names ITS pane, and says what it now blocks", () => {
    const m = explainFailedStart(NO_TAP, "STC-249's channel independence").message;
    expect(m).toContain("Input Monitoring");
    // Not the Screen Recording DIAGNOSIS: sending someone to a grant they
    // already hold is the failure mode this whole module exists for. It may
    // still MENTION Screen Recording — saying the two grants are keyed to the
    // same process identity is what tells a reader WHICH process to grant —
    // so the assertion is on the misdiagnosis, not on the words.
    expect(m).not.toContain("has no Screen Recording");
    expect(explainFailedStart(NO_GRANT, "x").message).toContain("has no Screen Recording");
    // The surprising half — it blocks EVERY capture test now, not cursor ones
    expect(m).toContain("not only cursor ones");
    expect(m).toContain("STC-315");
  });

  test("the busy message names the cause, denies the wrong one, and gives the command", () => {
    const m = explainFailedStart(BUSY, "STC-306's stream-death stop").message;
    expect(m).toContain("DISPLAY-BUSY");
    expect(m).toContain("NOT a grant problem");
    expect(m).toContain("ps -Ao pid,command");
    // and it says what the honest no-grant signal would have been, so the
    // reader can tell the next run apart without coming back here
    expect(m).toContain("no-displays");

    // The grep is SCOPED to this project's path. It used to carry
    // `\\|[E]lectron`, which matches every other Electron app's crashpad
    // helper — measured 2026-09-09 on a real Mac: nine lines, five of them
    // Linear, Discord, Claude and Wispr Flow, with the two that mattered
    // buried in the middle. A diagnostic that buries its own answer in noise
    // is the same defect as one that omits it.
    expect(m).not.toContain("[E]lectron");

    // Since STC-292 the app survives its last window, so the old "kill it"
    // is advice that can lose a live take, and "look for a leftover app" is
    // advice that sends you to a Dock icon that is not there. Both halves are
    // asserted: WHERE to quit it from, and WHY `ps` alone cannot tell you it
    // is safe to kill.
    expect(m).toMatch(/menu bar/i);
    expect(m).toMatch(/mid-recording/i);
  });

  test("every message names WHAT went unverified and quotes the outcome", () => {
    for (const o of [NO_GRANT, BUSY, { code: "weird" }]) {
      const m = explainFailedStart(o, "the lossy ring under real capture load").message;
      expect(m).toContain("the lossy ring under real capture load");
      expect(m).toContain("start said:");
    }
  });
});
