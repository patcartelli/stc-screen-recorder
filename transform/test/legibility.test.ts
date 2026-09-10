import { describe, test, expect } from "vitest";
import {
  DEFAULT_TEXT_PT, EMBED_TARGETS, LEGIBILITY_WARN_PX, legibility,
  legibilitySentence, zoomFactorForCrop,
} from "../src/legibility.js";
import { EMBED_CSS_WIDTH } from "../src/output-size.js";
import { displayToOutput } from "../src/spaces.js";

describe("legibility — the arithmetic, derived independently (STC-318)", () => {
  /**
   * The same answer built the long way, out of `spaces.ts`'s own conversion
   * rather than out of the module under test. If the two ever disagree, one of
   * them has stopped describing what the export actually does — and this is
   * the only check here that could catch that, because everything else in this
   * file shares `legibility()`'s formula.
   */
  function viaSpaces(pointWidth: number, pointHeight: number, outputWidth: number,
                     textPt: number, embedWidthPx: number): number {
    const m = displayToOutput(
      { originX: 0, originY: 0, pointWidth, pointHeight },
      { width: outputWidth, height: Math.round(outputWidth * pointHeight / pointWidth) },
    );
    const textInOutputPx = textPt * m.sx;          // points → output pixels
    const cssPerOutputPx = embedWidthPx / outputWidth; // output pixels → CSS pixels
    return textInOutputPx * cssPerOutputPx;
  }

  test("agrees with the conversion spaces.ts already owns", () => {
    for (const [pw, ph] of [[1728, 1117], [1920, 1080], [3840, 2160], [1512, 982]]) {
      for (const outW of [1232, 1920, 2464, 3456]) {
        for (const embed of [640, 720, 1232]) {
          expect(legibility({ pointWidth: pw! }, 13, embed).textPx)
            .toBeCloseTo(viaSpaces(pw!, ph!, outW, 13, embed), 9);
        }
      }
    }
  });

  test("THE OUTPUT WIDTH CANCELS — exporting smaller does not make text bigger", () => {
    // The finding, asserted on the independent derivation rather than on the
    // module (which cannot disagree with itself, since it never sees the
    // output width at all). Four wildly different export sizes, one answer.
    const at = (outW: number) => viaSpaces(1728, 1117, outW, 13, EMBED_CSS_WIDTH);
    const sizes = [1232, 1920, 2464, 3456].map(at);
    for (const s of sizes) expect(s).toBeCloseTo(sizes[0]!, 9);
    // ...and it is the value legibility() reports without being told the size.
    expect(legibility({ pointWidth: 1728 }, 13, EMBED_CSS_WIDTH).textPx)
      .toBeCloseTo(sizes[0]!, 9);
  });

  test("THE TICKET'S OWN FORMULA IS WRONG ON A RETINA DISPLAY, by a factor of two", () => {
    // STC-318 says `T * E / output.width`. That is only `T * E / pointWidth`
    // when the two are equal — true at 1x, false on every retina Mac. This is
    // the control that makes the correction a measured claim rather than an
    // assertion in a comment.
    const pointWidth = 1728, captureWidth = 3456, textPt = 13, embed = 720;
    const ticketsAnswer = (textPt * embed) / captureWidth;
    const truth = legibility({ pointWidth }, textPt, embed).textPx;
    expect(ticketsAnswer).toBeCloseTo(2.71, 2);
    expect(truth).toBeCloseTo(5.42, 2);
    expect(truth / ticketsAnswer).toBeCloseTo(2, 9);   // exactly backingScale
    // And they land on opposite sides of the threshold at a plausible width.
    expect(legibility({ pointWidth }, textPt, 1232).verdict).toBe("ok");
    expect((textPt * 1232) / captureWidth).toBeLessThan(LEGIBILITY_WARN_PX);
  });

  test("the ticket's worked example is reproduced on the display it assumed", () => {
    // "13pt in a 1920-wide export embedded at 720px renders at ~4.9px" is right
    // for a 1920-POINT display, which is what it silently assumed.
    expect(legibility({ pointWidth: 1920 }, 13, 720).textPx).toBeCloseTo(4.875, 3);
  });

  test("backingScale is not an input — a 1x and a 2x capture read the same", () => {
    // The first draft of this compared two IDENTICAL calls, which is satisfied
    // by any function at all. The real claim needs the long derivation: the
    // same 1728-point display captured at 1728 and at 3456 differs by exactly
    // backingScale in every pixel count, and by nothing in apparent text size.
    const oneX = viaSpaces(1728, 1117, 1728, 13, EMBED_CSS_WIDTH);
    const twoX = viaSpaces(1728, 1117, 3456, 13, EMBED_CSS_WIDTH);
    expect(twoX).toBeCloseTo(oneX, 9);
    expect(legibility({ pointWidth: 1728 }, 13, EMBED_CSS_WIDTH).textPx).toBeCloseTo(oneX, 9);
  });
});

describe("the verdict and its threshold", () => {
  test("warns strictly below the threshold, and the boundary is not a warning", () => {
    // pointWidth chosen so the answer lands exactly on the threshold.
    const pointWidth = (13 * 1232) / LEGIBILITY_WARN_PX;
    expect(legibility({ pointWidth }, 13, 1232).textPx).toBeCloseTo(LEGIBILITY_WARN_PX, 9);
    expect(legibility({ pointWidth }, 13, 1232).verdict).toBe("ok");
    expect(legibility({ pointWidth: pointWidth + 1 }, 13, 1232).verdict).toBe("warn");
  });

  test("A FULL 4K DESKTOP IS UNREADABLE AT EVERY EMBED WIDTH THE SITE HAS", () => {
    // Written expecting the /lab width to rescue it. It does not, and that is
    // the most useful thing this function has to say. A display 3840 POINTS
    // wide — a 4K monitor at 1x, not a retina one — puts 13pt text at 4.2px in
    // the /lab column and 2.4px at 720. To clear 9px it would need 28pt text.
    //
    // So for a demo recorded on such a display the answer is not a font
    // setting: it is zoom, or recording a smaller logical display. That is a
    // decision made AT CAPTURE TIME, which is why this ticket is worth having
    // before the recording rather than after it.
    const display = { pointWidth: 3840 };
    expect(legibility(display, 13, 720).textPx).toBeCloseTo(2.44, 2);
    expect(legibility(display, 13, EMBED_CSS_WIDTH).textPx).toBeCloseTo(4.17, 2);
    expect(legibility(display, 16, EMBED_CSS_WIDTH).verdict).toBe("warn");
    const needed = (LEGIBILITY_WARN_PX * 3840) / EMBED_CSS_WIDTH;
    expect(needed).toBeCloseTo(28.05, 2);
    expect(legibility(display, Math.ceil(needed), EMBED_CSS_WIDTH).verdict).toBe("ok");
  });

  test("a retina laptop at /lab clears the threshold, and that is the contrast", () => {
    // The same 13pt text on a 1728-point display reads at 9.3px. Nothing about
    // the export differs — only how many points of screen were recorded. This
    // is the control that stops the test above being read as "the threshold is
    // too strict".
    expect(legibility({ pointWidth: 1728 }, 13, EMBED_CSS_WIDTH).textPx).toBeCloseTo(9.27, 2);
    expect(legibility({ pointWidth: 1728 }, 13, EMBED_CSS_WIDTH).verdict).toBe("ok");
  });

  test("a malformed display gives 0 and warns, never NaN or Infinity", () => {
    for (const pointWidth of [0, -1]) {
      const l = legibility({ pointWidth }, 13, 1232);
      expect(l.textPx).toBe(0);
      expect(l.verdict).toBe("warn");
      expect(Number.isFinite(l.textPx)).toBe(true);
    }
  });
});

describe("zoom", () => {
  test("a crop half the frame wide doubles the apparent size", () => {
    expect(zoomFactorForCrop(0.5)).toBe(2);
    expect(zoomFactorForCrop(1)).toBe(1);
    const plain = legibility({ pointWidth: 3840 }, 13, 720);
    const zoomed = legibility({ pointWidth: 3840 }, 13, 720, zoomFactorForCrop(0.5));
    expect(zoomed.textPx).toBeCloseTo(plain.textPx * 2, 9);
    // The point of the feature: zoom is what rescues an unreadable take.
    expect(plain.verdict).toBe("warn");
    expect(legibility({ pointWidth: 3840 }, 13, 720, zoomFactorForCrop(0.25)).verdict).toBe("ok");
  });

  test("a zero-width crop does not divide by zero", () => {
    expect(zoomFactorForCrop(0)).toBe(1);
  });
});

describe("the sentence and the targets", () => {
  test("reads as a fact, and says so when it is a warning", () => {
    const ok = legibilitySentence(legibility({ pointWidth: 1728 }, 13, EMBED_CSS_WIDTH));
    expect(ok).toBe("At 1232px, 13pt text renders at 9.3px");
    const warn = legibilitySentence(legibility({ pointWidth: 3840 }, 13, 720));
    expect(warn).toBe("At 720px, 13pt text renders at 2.4px — below 9px, hard to read");
  });

  test("names the zoom only when there is one", () => {
    expect(legibilitySentence(legibility({ pointWidth: 1728 }, 13, 1232, 1)))
      .not.toContain("zoom");
    expect(legibilitySentence(legibility({ pointWidth: 1728 }, 13, 1232, 2)))
      .toContain("at 2.0× zoom");
  });

  test("/lab's width is the SAME VALUE the export presets use, not a copy", () => {
    // One measurement, one owner. A second literal here would drift the first
    // time the site's container changed, and the two would disagree about the
    // same page.
    expect(EMBED_TARGETS.find((t) => t.id === "lab")!.widthPx).toBe(EMBED_CSS_WIDTH);
  });

  test("only the target that could actually be measured is offered", () => {
    // The ticket asks for three. Two need someone who can see the site's
    // layout; inventing them would produce a list that looked authoritative
    // and was not. Asserted so that adding one is a deliberate act with a
    // measurement behind it.
    expect(EMBED_TARGETS.map((t) => t.id)).toEqual(["lab"]);
  });

  test("the default text size is the ticket's", () => {
    expect(DEFAULT_TEXT_PT).toBe(13);
  });
});
