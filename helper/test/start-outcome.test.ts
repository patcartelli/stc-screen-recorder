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
  });

  test("the busy message names the cause, denies the wrong one, and gives the command", () => {
    const m = explainFailedStart(BUSY, "STC-306's stream-death stop").message;
    expect(m).toContain("DISPLAY-BUSY");
    expect(m).toContain("NOT a grant problem");
    expect(m).toContain("ps -Ao pid,command");
    // and it says what the honest no-grant signal would have been, so the
    // reader can tell the next run apart without coming back here
    expect(m).toContain("no-displays");
  });

  test("every message names WHAT went unverified and quotes the outcome", () => {
    for (const o of [NO_GRANT, BUSY, { code: "weird" }]) {
      const m = explainFailedStart(o, "the lossy ring under real capture load").message;
      expect(m).toContain("the lossy ring under real capture load");
      expect(m).toContain("start said:");
    }
  });
});
