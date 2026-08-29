/**
 * `frameAt(0) never resolved` means one of two opposite things.
 *
 * On CI's shared video hardware the decoder accepts chunks and emits nothing —
 * the machine declining, twice on one PR (run 33228579869). But the very same
 * symptom is what a broken `SeekingFrameSource` would produce, and the seek
 * gate reported both through `fail()`, the CODE label, so a machine fault
 * reddened PRs while a real regression would have looked identical.
 *
 * Labelling the whole branch ENVIRONMENT would fix the first and break the
 * second: a retry — or a skip — that absorbs a regression is worse than none,
 * the rule `gate-retry` already follows for its own marker. So the branch is
 * split on the source's own STATE, never on the text of a message. Pattern
 * matching a timeout string is the fragile version and is deliberately not used
 * anywhere here.
 *
 * The machine's signature is precise: we fed the decoder, it is configured, it
 * reported no error, and nothing came out. Anything else — never fed, errored,
 * waiting on a keyframe we did not send, not configured, or already producing
 * frames — is OURS, and stays loud.
 */

/** @returns {"machine" | "ours"} */
export function classifyDecoderStall(debug) {
  if (!debug || typeof debug !== "object") return "ours";

  const {
    decoderState, decodeQueueSize, nextFeed, nextOutIndex, needsKeyframe, failure,
  } = /** @type {Record<string, unknown>} */ (debug);

  // It told us something. Silence is the whole basis for blaming the machine.
  if (failure) return "ours";
  // A decoder we never configured, or already closed, is our sequencing.
  if (decoderState !== "configured") return "ours";
  // Nothing submitted: its silence proves nothing about the hardware.
  if (!(typeof nextFeed === "number" && nextFeed > 0)) return "ours";
  if (!(typeof decodeQueueSize === "number" && decodeQueueSize > 0)) return "ours";
  // Frames already came out, so the pipeline worked and then stopped — a
  // different bug from one that never started, and not the silent case.
  if (!(nextOutIndex === 0)) return "ours";
  // The documented mid-stream flush trap: a flushed decoder demands a keyframe
  // and we are waiting for output that cannot come until we send one.
  if (needsKeyframe) return "ours";

  return "machine";
}
