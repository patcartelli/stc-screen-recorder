import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "../../app/src/helper-client.js";

const root = join(__dirname, "..", "..");

/**
 * STC-289's bound, in the chain stop-bounds.test.ts asserts for `stop`.
 *
 * `StillCapture.timeoutSeconds` covers the WHOLE still — content enumeration,
 * the screenshot, the PNG encode and shot.json — and answers `still-timeout`
 * exactly once, naming the step it was on. The client gives every request a
 * flat timeout; the helper's bound plus the answer's trip back must fit
 * inside it, or the app gives up on a still the helper was still going to
 * answer. Asserted as a composition, not a bare number, because a bound's own
 * slack will hide a missing term.
 */
const swiftConstant = (file: string, name: string): number => {
  const src = readFileSync(join(root, file), "utf8");
  const m = src.match(new RegExp(`${name}:\\s*Double\\s*=\\s*([\\d.]+)`));
  expect(m, `${name} not found in ${file} — did it get renamed?`).not.toBeNull();
  return Number(m![1]) * 1000;
};

/** The reply carries the document and makes one IPC round trip. An allowance. */
const REPLY_AND_IPC_MS = 2_000;

/** The ticket's latency target: a still that feels slower than ⌘⇧4 will not get used. */
const LATENCY_TARGET_MS = 200;

describe("the still chain (STC-289)", () => {
  const stillMs = () => swiftConstant("helper/src/Still.swift", "timeoutSeconds");

  test("the helper answers a still before the client stops listening", () => {
    expect(stillMs()).toBeGreaterThan(0);
    expect(stillMs() + REPLY_AND_IPC_MS).toBeLessThanOrEqual(DEFAULT_REQUEST_TIMEOUT_MS);
  });

  // The backstop is for a wedged machine, not a slow capture: it must sit far
  // enough above the target that a still near the target never trips it, and
  // far enough below the client's timeout that the answer names its step
  // instead of the client reporting a mute timeout.
  test("the backstop is well clear of the latency target", () => {
    expect(stillMs()).toBeGreaterThanOrEqual(LATENCY_TARGET_MS * 10);
  });
});
