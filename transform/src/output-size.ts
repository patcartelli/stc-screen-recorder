import type { Size } from "./spaces.js";

/**
 * What size a take exports at (STC-335).
 *
 * The transform has always honoured any output size — `exportSession` reads
 * `project.output` and sizes the canvas, the muxer and the encoder from it,
 * and `composite()` scales through `spaces.ts`. What was missing is that
 * NOTHING EVER WROTE THOSE TWO NUMBERS: `defaultProject` sets them to the
 * capture size and the edit UI only ever persisted the trim, so the machinery
 * was complete and unreachable, and a web-sized file meant hand-editing
 * `project.json`.
 *
 * This module is the decision half. It answers "how wide will this be shown"
 * rather than "how many pixels", and it is the ONE place the three constraints
 * below are enforced — a caller that computed `width / aspect` itself would
 * get an odd height, which is the specific bug this exists to prevent.
 *
 * ## The three rules, and why each is not taste
 *
 * **Height follows from the capture's aspect ratio, never typed.** Two free
 * fields are a way to letterbox or stretch a recording by accident, and the
 * result looks like a rendering fault rather than a setting.
 *
 * **Both dimensions must be even.** H.264's 4:2:0 chroma subsampling cannot
 * express an odd one. This is the rule most likely to be broken by a plausible
 * implementation: `Math.round(width / aspect)` produces an odd height about
 * half the time, and the failure arrives from the encoder, far from the cause.
 *
 * **Upscaling is offered but never silently done.** The pixels are not there.
 * An option wider than the capture is returned with `upscales: true` so the UI
 * can show it disabled and say why — a preset that simply vanished on a small
 * capture would read as a bug in the list rather than a fact about the take.
 *
 * ## Where the target widths come from
 *
 * `EMBED_CSS_WIDTH` is the site's own measurement, not a round number someone
 * liked: `/lab` is a 1280 px container with 24 px padding either side above
 * 840 px, so a demo is 1232 CSS px at its widest. 2x is what a retina display
 * asks for. It is stated here rather than in the UI because it is the reason
 * the preset exists, and a number whose derivation lives somewhere else is the
 * one that gets "tidied" to 1200 by the next person.
 */

/** The site's `/lab` container at its widest, in CSS pixels. See the header. */
export const EMBED_CSS_WIDTH = 1232;

export interface OutputOption {
  /** Stable across renders; the UI's value, never stored in the document. */
  id: string;
  label: string;
  size: Size;
  /**
   * Wider than the capture, so choosing it would invent pixels. The UI must
   * refuse it; it is returned rather than dropped so it can say why.
   */
  upscales: boolean;
}

/** Nearest even integer, at least 2 — a zero-height video is not a video. */
function even(n: number): number {
  return Math.max(2, 2 * Math.round(n / 2));
}

/**
 * The output size for a target width, with the capture's aspect ratio.
 *
 * Both dimensions come back even. The height is derived from the width AFTER
 * the width is evened, not from the requested width: evening the width is a
 * change to the aspect the export will actually use, and deriving the height
 * from the pre-rounded number would leave the two disagreeing by a pixel on
 * exactly the sizes where it is visible.
 */
export function outputSizeFor(capture: Size, targetWidth: number): Size {
  const width = even(targetWidth);
  return { width, height: even((width * capture.height) / capture.width) };
}

/** Is this output the capture's own size — the default, and no rescale at all? */
export function isCaptureSize(capture: Size, output: Size): boolean {
  return output.width === capture.width && output.height === capture.height;
}

/**
 * What the export UI offers, capture size first.
 *
 * Capture size is ALWAYS present and always first: it is the existing
 * behaviour, the default, and the only option guaranteed not to resample. A
 * capture that is itself an odd size is offered verbatim rather than evened —
 * it recorded and it will encode, and quietly changing the one option that
 * means "leave it alone" would be the worst of the four.
 */
export function outputOptions(capture: Size): OutputOption[] {
  const out: OutputOption[] = [{
    id: "capture",
    label: `Capture size · ${capture.width}×${capture.height}`,
    size: { width: capture.width, height: capture.height },
    upscales: false,
  }];

  for (const scale of [1, 2]) {
    const target = EMBED_CSS_WIDTH * scale;
    const size = outputSizeFor(capture, target);
    // Compared on the TARGET rather than the evened width: a 1232-wide capture
    // offered a "1232" preset is offering its own size twice, and rounding
    // could otherwise make the duplicate differ by a pixel and look deliberate.
    if (isCaptureSize(capture, size)) continue;
    out.push({
      id: `embed-${scale}x`,
      label: `Embed ${scale}× · ${size.width}×${size.height}`,
      size,
      upscales: target > capture.width,
    });
  }
  return out;
}

/**
 * Which option a project's current output corresponds to, or `null` for a size
 * nothing offers.
 *
 * `null` is a real answer rather than a fallback to "capture": a project
 * hand-edited to 1920 (the workaround this ticket replaces, and every take
 * edited before it) must not have that setting silently reported as something
 * else, and must not lose it by being re-persisted as the capture size.
 */
export function selectedOption(capture: Size, output: Size): OutputOption | null {
  return outputOptions(capture).find(
    (o) => o.size.width === output.width && o.size.height === output.height,
  ) ?? null;
}
