import { mark } from "./mark.js";
import { setDecoderPreference, type DecoderPreference } from "@transform/decoder-preference";

/**
 * Applies the decoder preference the runner handed the page, and MARKS it.
 *
 * scripts/gate.mjs checks that the page used the preference the runner sent —
 * and that check runs after `bounded(page.evaluate(...))` returns, so on a
 * WEDGED run it never runs at all. The runs the check exists for are precisely
 * the runs it cannot speak for: the trail from a wedge names the blocking call
 * but says nothing about which decoder was being asked for when it blocked.
 *
 * That gap made an experiment unfalsifiable. #56 asked the gates for
 * `prefer-software` on the theory that CI's paravirtualized hardware decoder is
 * what wedges them. Measured 2026-09-01 over the runs since: the gates still
 * skip (3 of 12 post-change runs), and the trail still stops at the first
 * decoder touch 317-406 ms in — the same signature as before. That reads as
 * "the preference was not the cause", but it is only worth that much if the
 * page actually GOT the preference, and a wedged run carried no evidence
 * either way. A mark costs one console line and settles it.
 *
 * It is emitted through `mark()` rather than logged, because a console message
 * is the only channel that survives a blocked main thread (see mark.ts) — which
 * is the same reason the trail exists at all.
 *
 * Reading the global lives HERE and nowhere else. Four harness entries carried
 * an identical copy of it, and CLAUDE.md has this repo fixing "one value, two
 * copies" five times over; the fifth was a hand-rolled project literal that
 * could not know what parseProject would have applied. transform/test/
 * decoder-preference-mark.test.ts is the sixth's tripwire.
 */
export function applyDecoderPreference(): void {
  // Undefined outside a gate, which is Chromium's own default — and worth
  // marking as loudly as a set one. "No preference" is itself the state #56
  // moved away from, so a trail that omitted it would be ambiguous exactly
  // where it needs to be plain.
  const p = (globalThis as { __decoderPreference?: DecoderPreference }).__decoderPreference;
  setDecoderPreference(p);
  mark(`decoder preference: ${p ?? "unset (Chromium default)"}`);
}
