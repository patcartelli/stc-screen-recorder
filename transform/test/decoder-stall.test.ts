import { describe, test, expect } from "vitest";
import { classifyDecoderStall } from "../../scripts/decoder-stall.mjs";

/**
 * `frameAt(0) never resolved` means one of two opposite things, and the seek
 * gate reported both through fail() — the CODE label — until now. On CI's
 * shared video hardware that turned a machine fault into a red PR twice in one
 * night, on a PR whose entire subject was that distinction.
 *
 * The discriminator is STRUCTURAL, not a string match on the message: the
 * source's own debug state says whether we fed the decoder and it stayed
 * silent, or whether we never fed it properly in the first place. Pattern
 * matching a timeout string is the fragile version and was explicitly rejected.
 */

/** Observed on CI run 33228579869, twice: 8 chunks in, nothing out, no error. */
const MACHINE = {
  decoderState: "configured",
  decodeQueueSize: 8,
  pending: 0,
  nextFeed: 8,
  nextOutIndex: 0,
  currentIndex: -1,
  needsKeyframe: false,
  failure: null,
  waiting: true,
};

describe("telling a silent decoder from a broken seek path", () => {
  test("fed, configured, no error, nothing out — the machine", () => {
    expect(classifyDecoderStall(MACHINE)).toBe("machine");
  });

  // Everything below is OURS, and must never be retried or skipped away. A
  // retry that absorbs a regression is worse than no retry — the rule
  // gate-retry already follows, applied to the state instead of the message.
  test("never fed — we did not submit a chunk, so silence proves nothing", () => {
    expect(classifyDecoderStall({ ...MACHINE, nextFeed: 0, decodeQueueSize: 0 })).toBe("ours");
  });

  test("the decoder reported an error — we got an answer, and it was a failure", () => {
    expect(classifyDecoderStall({ ...MACHINE, failure: "DataError: bad chunk" })).toBe("ours");
  });

  test("waiting for a keyframe we never sent — the documented mid-stream flush trap", () => {
    expect(classifyDecoderStall({ ...MACHINE, needsKeyframe: true })).toBe("ours");
  });

  test("a decoder that is not configured is our sequencing, not their silicon", () => {
    expect(classifyDecoderStall({ ...MACHINE, decoderState: "closed" })).toBe("ours");
    expect(classifyDecoderStall({ ...MACHINE, decoderState: "unconfigured" })).toBe("ours");
  });

  test("frames already came out — a stall after progress is not the silent case", () => {
    expect(classifyDecoderStall({ ...MACHINE, nextOutIndex: 5 })).toBe("ours");
  });

  // Absent or malformed debug must not be read as "machine" — that is the
  // direction that loses a regression.
  test("missing or unusable debug is OURS, never the machine", () => {
    expect(classifyDecoderStall(undefined)).toBe("ours");
    expect(classifyDecoderStall(null)).toBe("ours");
    expect(classifyDecoderStall({} as never)).toBe("ours");
    expect(classifyDecoderStall("nope" as never)).toBe("ours");
  });
});
