import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The ticket's fourth acceptance criterion, as a test (STC-294).
 *
 * > No view component branches on kind outside the adapter.
 *
 * This is not a claim any behavioural test can make. A view that says
 * `if (item.kind === "still")` to pick a button's label produces exactly the
 * right pixels, passes every E2E, and is the thing the criterion forbids — the
 * seam has leaked and nothing is red. So it is checked STRUCTURALLY, in the
 * idiom this repo already uses for rules that are about shape rather than
 * output: `gate-bounds.test.ts` refusing a bare `browser.close()` in a gate,
 * `overlay-listeners.test.ts` holding a three-file chain together.
 *
 * The ticket says what to do when this test is in the way, and it is not
 * "loosen the pattern": *"If still-specific conditionals start appearing in
 * list, grid or detail views, the interface is too narrow and should be
 * widened deliberately rather than special-cased."* Widen `LibraryItem`, and
 * this test goes green on its own.
 */

const repo = join(__dirname, "..", "..");

/**
 * Every file that draws the library. The adapter itself is deliberately absent.
 *
 * `renderer.ts` is NOT in this list, and that is the finding rather than a gap.
 * It carries an unrelated `r.kind` — a capture RESULT's shot kind
 * (`display-crop` / `window`) in the status line — so grepping the whole file
 * fires on legitimate code, and a guard that cries wolf is a guard someone
 * turns off. The library's view is therefore its own module, which must never
 * mention kind at all; `renderLibrary` is the only thing that draws a tile, so
 * greping it is the whole claim rather than a weakened version of it. If a
 * second file ever starts drawing library tiles, add it here.
 */
const VIEWS = [
  "app/src/library-view.ts",
];

/**
 * What a leak looks like.
 *
 * Deliberately NOT "the file contains the word still" — `renderer.ts` is full
 * of legitimate ones (`still:capture`, `#capturestill`, the "Still capture"
 * preferences section), and a pattern that matched those would be turned off
 * within a day. These match the actual failure: reading an item's `kind`, or
 * comparing anything against a kind literal.
 */
const LEAKS: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /\.kind\b/, what: "reads an item's .kind" },
  { pattern: /[=!]==\s*["'](?:still|recording)["']/, what: 'compares against "still"/"recording"' },
  { pattern: /["'](?:still|recording)["']\s*[=!]==/, what: 'compares against "still"/"recording"' },
  { pattern: /case\s+["'](?:still|recording)["']/, what: 'switches on "still"/"recording"' },
];

/**
 * Comments are blanked before scanning, keeping the line numbering.
 *
 * Found the hard way, on this test's first run: the view module EXPLAINS the
 * rule it keeps, so its own doc comment contains `.kind` and the guard flagged
 * it. Refusing to let a file discuss the rule it obeys is how a guard ends up
 * deleted, and the rule is about code either way.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

/** Line-by-line so a failure names the line, not just the file. */
function leaksIn(src: string): string[] {
  const out: string[] = [];
  stripComments(src).split("\n").forEach((line, i) => {
    for (const { pattern, what } of LEAKS) {
      if (pattern.test(line)) out.push(`${i + 1}: ${what} — ${line.trim()}`);
    }
  });
  return out;
}

describe("the library's seam stays in the adapter (STC-294)", () => {
  for (const rel of VIEWS) {
    test(`${rel} does not branch on kind`, () => {
      const src = readFileSync(join(repo, rel), "utf8");
      const found = leaksIn(src);
      expect(found, `${rel} branches on kind — widen LibraryItem instead:\n` +
                    found.join("\n")).toEqual([]);
    });
  }

  /**
   * The guard must be able to FAIL, which is a separate claim from it passing.
   *
   * This repo has paid for the difference three times over — a bound nobody
   * watched fire, a floor with enough slack to hide a missing term, a PiP test
   * that passed with the compositor removed. An assertion that no file matches
   * a pattern is satisfied just as well by a pattern that matches nothing, so
   * the discriminator is checked against control lines that MUST match.
   */
  test("the patterns catch what they exist to catch", () => {
    const wouldLeak = [
      'if (item.kind === "still") btn.textContent = "Open";',
      "const isStill = item.kind !== 'recording';",
      'switch (k) { case "still": return 1; }',
      'if ("recording" === k) return 2;',
    ];
    for (const line of wouldLeak) {
      expect(leaksIn(line), `this should have been caught: ${line}`).not.toEqual([]);
    }
  });

  /**
   * And it must not fire on the things a view legitimately says. A guard that
   * cries wolf is a guard someone deletes.
   */
  test("the patterns leave legitimate view code alone", () => {
    const fine = [
      'const r = await recorder.captureStill("display");',
      'await win.waitForSelector("#capturestill");',
      'if (item.thumbnail.source === "file") img.src = url;',
      'section.textContent = "Still capture";',
      'chip.textContent = f.label;',
      // A file may DISCUSS the rule it keeps. The view module's own header
      // does, which is how this exemption was found.
      '// a view saying item.kind === "still" is what this forbids',
      '/** `if (item.kind === "still")` is the leak this file exists to prevent */',
    ];
    for (const line of fine) {
      expect(leaksIn(line), `this should NOT have been caught: ${line}`).toEqual([]);
    }
  });
});

/**
 * The layering rule `library.ts`'s header states — "library.ts does the
 * scanning and imports node; [library-items.ts] must not" — had itself
 * drifted (STC-345). `cameraSummary`, which reads a raw `anchors.json` blob,
 * existed identically in BOTH files: the real one in `library.ts` (imported,
 * called from `readRecording`), and a byte-for-byte copy in `library-items.ts`
 * that nothing ever called. A dead duplicate is the quiet half of "one value,
 * two copies" — nothing was WRONG today, because nothing reached the second
 * copy, but a future edit to the real one had no reason to know a second
 * existed, and the fix for a bug found tomorrow could easily land in the
 * unreachable copy instead.
 */
describe("library-items.ts owns no I/O-shaped decisions (STC-345)", () => {
  test("cameraSummary lives in library.ts only — library-items.ts never reads a raw anchors document", () => {
    // Comments blanked first: this file's own header discusses the fix by
    // name, which is exactly the case `library-seam.test.ts` already learned
    // to allow for the "no view branches on kind" guard above — a file may
    // DISCUSS a rule it keeps.
    const items = stripComments(readFileSync(join(repo, "app/src/library-items.ts"), "utf8"));
    expect(items).not.toContain("cameraSummary");
    const scanner = readFileSync(join(repo, "app/src/library.ts"), "utf8");
    expect(scanner).toContain("function cameraSummary");
  });
});
