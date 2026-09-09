/**
 * Why a `start` did not come back `started`, said accurately.
 *
 * Every grant test has the same shape: ask the helper to record, and if it
 * refuses, say why the test cannot run. Four of them said **"this environment
 * has no Screen Recording grant"** for ANY refusal, which is a guess dressed
 * as a finding — and on 2026-09-09 it was the wrong guess on a real Mac. A
 * `npm run test:capture` run reported SKIP-GRANT sixteen times on a machine
 * whose grant was fine; every single start had failed with `-3805`, a leftover
 * app of this project's own holding the display. The message sends the reader
 * to System Settings to fix something that is not broken, and CLAUDE.md
 * already documents both the `-3805` trap and the rule this breaks: a
 * diagnostic that lies is worse than one that admits ignorance.
 *
 * The discriminator was already in the repo and in exactly one file.
 * `multi-display.grant.test.ts` keyed on `code === "no-displays"` — which IS
 * what a missing grant looks like, because `SCShareableContent` returns an
 * empty display list rather than an error when TCC refuses. This module is
 * that rule, lifted out, so the other tests stop guessing.
 *
 * Nothing here decides whether a test is skipped; it decides what the reader
 * is told. A refusal it cannot classify says so rather than picking the most
 * familiar cause — which is the whole point.
 */

export interface StartOutcome {
  ev?: string;
  code?: string;
  detail?: string;
  [k: string]: unknown;
}

/** What a start's refusal actually means, as far as it can be told apart. */
export type StartRefusal =
  /** `SCShareableContent` listed no displays: TCC really has refused. */
  | { kind: "no-grant" }
  /**
   * `-3805`, "application connection being interrupted". Another SCStream of
   * this project's holds the display — usually a leftover `electron .` or an
   * app left running from hardware verification. Nothing to do with
   * permissions, and the honest no-grant signal is `no-displays` instead.
   */
  | { kind: "display-busy" }
  /** Something else. Say so; do not reach for the familiar answer. */
  | { kind: "unclassified" };

export function classifyStartRefusal(started: StartOutcome): StartRefusal {
  if (started.code === "no-displays") return { kind: "no-grant" };
  const detail = typeof started.detail === "string" ? started.detail : "";
  if (detail.includes("-3805") || detail.includes("connection being interrupted")) {
    return { kind: "display-busy" };
  }
  return { kind: "unclassified" };
}

/**
 * The error to throw when a start refused, naming the cause and what to do.
 *
 * `what` names the claim the run cannot make — "STC-306's stream-death stop",
 * "the lossy ring under real capture load" — so a reader who sees several of
 * these knows what went unverified rather than only that something did.
 *
 * Only the `no-grant` case says SKIP-GRANT. The runner and any log-scraping
 * key on that string, and a busy display is not a missing grant: labelling it
 * one is how a real environment problem gets filed under "permissions" and
 * looked for in the wrong place for an hour.
 */
export function explainFailedStart(started: StartOutcome, what: string): Error {
  const said = `start said: ${JSON.stringify(started)}`;
  switch (classifyStartRefusal(started).kind) {
    case "no-grant":
      return new Error(
        `SKIP-GRANT: this environment has no Screen Recording grant, so ${what} is ` +
        "unverified. Grant it to the process that runs the tests, or run from a " +
        `bundle that holds it (tools/test-host). ${said}`,
      );
    case "display-busy":
      return new Error(
        `DISPLAY-BUSY: another SCStream of this project's is holding the display, so ${what} ` +
        "could not be exercised. This is NOT a grant problem — check for a leftover app " +
        "before changing anything in System Settings:\n" +
        "    ps -Ao pid,command | grep -i '[s]tc-screen-recorder\\|[E]lectron'\n" +
        `Kill it and run again. A genuinely missing grant reports "no-displays" instead. ${said}`,
      );
    default:
      return new Error(
        `START-REFUSED: ${what} could not be exercised, and the reason is not one this ` +
        "test can classify — it is neither \"no-displays\" (a missing grant) nor -3805 " +
        `(the display held by another stream). Read the outcome rather than assuming. ${said}`,
      );
  }
}
