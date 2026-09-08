import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "../../app/src/helper-client.js";

const root = join(__dirname, "..", "..");

/**
 * STC-259 step 3.
 *
 * The question the ticket asked was whether `Capture.swift` and
 * `CameraCapture.swift` need a bound on their first `AVAssetWriter` append, the
 * way the writer-gate harness now bounds its own. The answer is no, and it is
 * not a judgement call: `WriterGate.append` holds its lock ACROSS the append —
 * that IS the STC-254 fix — so a bound there would have to abandon a thread
 * still holding that lock, and `closeAndMarkFinished()` would go on blocking
 * forever anyway. Nothing is bought at the append. The wedge is contained one
 * layer out, at teardown, where both files already carry a backstop.
 *
 * What was missing is this file. Those two backstops and the client timeout
 * they have to fit inside are three numbers in two languages, and until now the
 * only thing relating them was a comment. `start` got this treatment after
 * STC-258 — two correctly-bounded waits set too close together, which drifted
 * into a flake that only showed up under load — and `stop` never did.
 */
const swiftConstant = (file: string, name: string): number => {
  const src = readFileSync(join(root, file), "utf8");
  const m = src.match(new RegExp(`${name}:\\s*Double\\s*=\\s*([\\d.]+)`));
  expect(m, `${name} not found in ${file} — did it get renamed?`).not.toBeNull();
  return Number(m![1]) * 1000;
};

/**
 * What has to happen AFTER the helper's stop backstop fires and before the
 * client's timeout does: `finishUp` writes events.json and anchors.json — a
 * long take's events.json is not small — and the answer then makes an IPC round
 * trip. An allowance, not a measurement, and the only unverified term here.
 */
const SIDECARS_AND_IPC_MS = 5_000;

describe("the stop chain (STC-259 step 3)", () => {
  // Read INSIDE each test, not in the describe body. A constant renamed out
  // from under the regex is the likeliest way this file quietly stops checking
  // anything, and a failure at collection time is reported as a broken file
  // rather than as the named assertion that caught it.
  const cameraMs = () => swiftConstant("helper/src/CameraCapture.swift", "stopTimeoutSeconds");
  const displayMs = () => swiftConstant("helper/src/Capture.swift", "stopTimeoutSeconds");
  const shutdownMarginMs = () => swiftConstant("helper/src/main.swift", "shutdownBackstopMarginSeconds");

  // CaptureSession.stop() waits on a DispatchGroup the camera teardown is
  // entered into. If the camera's backstop were the later one the display side
  // would give up first and report `<reason>-timeout` with a stopWarning for a
  // camera that was about to answer cleanly — a diagnostic that lies.
  test("the camera teardown answers before the display teardown gives up", () => {
    expect(cameraMs()).toBeGreaterThan(0);
    expect(cameraMs()).toBeLessThan(displayMs());
  });

  // The outermost link. Every wait here is bounded and each answers exactly
  // once, so the failure mode is not a hang — it is the client giving up on a
  // `stop` the helper was still going to answer, leaving the app holding a
  // recording it cannot end. Asserted as a COMPOSITION: the helper's bound plus
  // what it still has to do afterwards, not just the bare number, because a
  // bound's own slack will otherwise hide a missing term.
  test("the helper answers a stop before the client stops listening", () => {
    expect(displayMs() + SIDECARS_AND_IPC_MS).toBeLessThanOrEqual(DEFAULT_REQUEST_TIMEOUT_MS);
  });

  // STC-304's new outermost link. App.shutdown's own backstop exists only to
  // catch `stop` never answering at all — not on time, but literally never,
  // meaning even stop's OWN backstop (displayMs) failed to fire. It is
  // expressed as displayMs + this margin, in Swift, so the two numbers
  // cannot independently drift apart the way cameraMs/displayMs could; the
  // one thing left to guard is the margin staying a REAL margin. Zero would
  // put both backstops on the same nominal deadline — the exact "an inner
  // bound set exactly equal to the outer one, so the informative message
  // always lost the race" trap this codebase already hit once (STC-259's
  // ATTEMPT_MS).
  test("shutdown's backstop clears stop's own backstop by a deliberate margin, not by luck", () => {
    expect(shutdownMarginMs()).toBeGreaterThan(0);
  });
});

/**
 * The still export chain (STC-293), on the same rule.
 *
 * `export-still` is a request like any other, so its backstop has to fit inside
 * the client's timeout with room for the answer to travel. It shipped set
 * EXACTLY equal to it — 30 s against 30 s — which is not a near miss: the
 * client's generic "request timed out" wins that race every time, so the
 * helper's own message, the one that names the operation and the bound, could
 * never reach anybody. The bound was not wrong; it was unreachable, which is
 * the same class of defect as a diagnostic that lies.
 */
describe("the still export chain (STC-293)", () => {
  const exportMs = () => swiftConstant("helper/src/StillEncode.swift", "timeoutSeconds");
  const stillMs = () => swiftConstant("helper/src/Still.swift", "timeoutSeconds");

  /** An encode answer is one small JSON line; this is the round trip, not the work. */
  const ANSWER_IPC_MS = 2_000;

  test("the export backstop fires before the client gives up, with room to answer", () => {
    expect(exportMs() + ANSWER_IPC_MS).toBeLessThanOrEqual(DEFAULT_REQUEST_TIMEOUT_MS);
  });

  test("equal bounds are refused, not merely discouraged", () => {
    // The exact shipped defect. Stated as its own assertion because the one
    // above would still pass at 29 s with a 1 s allowance, and "under by
    // something" is not the property that matters — "under by enough to
    // deliver the message" is.
    expect(exportMs()).toBeLessThan(DEFAULT_REQUEST_TIMEOUT_MS);
  });

  test("capture-still clears the same client timeout", () => {
    // Not new, but unasserted until now: the one-frame path has its own 10 s
    // backstop and it lives under the same 30 s ceiling.
    expect(stillMs() + ANSWER_IPC_MS).toBeLessThanOrEqual(DEFAULT_REQUEST_TIMEOUT_MS);
  });

  test("an export may take longer than a capture, and the bounds say so", () => {
    // A still capture is one screenshot; an export reads up to 130 MB off disk
    // and encodes it. If these ever invert, one of them has been set by habit
    // rather than by what it covers.
    expect(exportMs()).toBeGreaterThan(stillMs());
  });
});
