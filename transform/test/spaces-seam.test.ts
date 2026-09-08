import { describe, test, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * STC-314's "done means", as a test.
 *
 * > A new file that needs a conversion has exactly one place to get it.
 *
 * No behavioural test can make that claim. A file that re-derives
 * `output.width / display.pointWidth` produces exactly the right pixels today
 * and is the thing the ticket forbids — it is a second owner, and the two will
 * disagree the first time either changes. So it is checked STRUCTURALLY, in
 * the idiom this repo already uses for rules about shape rather than output:
 * `library-seam.test.ts` on the library's adapter, `gate-bounds.test.ts`
 * refusing a bare `browser.close()`, `overlay-listeners.test.ts` holding a
 * three-file chain together.
 *
 * ## What is guarded, and what deliberately is not
 *
 * The EVENT SPACE is guarded, because the review's own line is "`render.ts` is
 * the only event-space conversion today; keep it that way" and the pattern for
 * it is unambiguous: display geometry (`originX`, `pointWidth`, …) adjacent to
 * an arithmetic operator is a conversion and nothing else.
 *
 * UV is NOT grepped, and that is a finding rather than a gap. `* content.width`
 * looks like a UV conversion and is also how you centre a rect, compute an
 * aspect ratio, find a midpoint, size an ellipse and fit a preview into a box —
 * `still-render.ts`, `overlay.ts` and `thumbnail-renderer.ts` are full of
 * legitimate ones. A pattern matching those would be turned off within a day,
 * and CLAUDE.md already records what that costs. The UV conversions are held to
 * one owner by review and by `spaces.test.ts` instead, which is weaker and is
 * said out loud rather than papered over with a guard that cries wolf.
 */

const repo = join(__dirname, "..", "..");
const SRC = join(repo, "transform", "src");

/** Everything in the transform except the module that owns the conversions. */
const OWNER = "spaces.ts";
const SCANNED = readdirSync(SRC).filter((f) => f.endsWith(".ts") && f !== OWNER);

/**
 * What a second owner looks like: display geometry next to an arithmetic
 * operator.
 *
 * Deliberately NOT "the file mentions originX". `shot.ts` validates and copies
 * these fields (`originX: d.originX`) and `types.ts` declares them — both are
 * legitimate, neither converts anything, and neither puts an operator against
 * one. The adjacency IS the discriminator.
 */
const GEOMETRY = String.raw`originX|originY|pointWidth|pointHeight|backingScale`;
const LEAKS: readonly { pattern: RegExp; what: string }[] = [
  { pattern: new RegExp(String.raw`[-+*/]\s*[\w.]*\.(?:${GEOMETRY})\b`),
    what: "does arithmetic with display geometry" },
  { pattern: new RegExp(String.raw`\.(?:${GEOMETRY})\s*[-+*/][^/*]`),
    what: "does arithmetic with display geometry" },
];

/**
 * Comments AND string literals are blanked before scanning, keeping the line
 * numbering.
 *
 * A file must be able to DISCUSS the rule it keeps — `render.ts`'s comment
 * still says "global points → display-local points → output pixels" and
 * spaces.ts's header spells the old expression out. Refusing that is how a
 * guard ends up deleted; learned on library-seam.test.ts's first run.
 *
 * The strings half was learned on THIS test's first run, and by the guard
 * itself rather than by reading it: `shot.ts` refuses a bad document with
 * `"display.originX/originY must be numbers"`, and `.originX` followed by a
 * slash is indistinguishable from a division until you notice it is inside a
 * message. An error message naming a field is exactly as legitimate as a
 * comment naming it, and arithmetic never lives in a string — so blanking
 * costs the guard nothing and buys it the right not to cry wolf.
 *
 * Comments go first: a quote inside a comment is blanked before it can open a
 * fake string, and a `//` inside a string cannot survive to eat the line
 * because the string is gone by then.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "")
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g,
             (m) => m.replace(/[^\n]/g, " "));
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

describe("every coordinate conversion has one owner (STC-314)", () => {
  test("the scan actually covers the transform", () => {
    // A guard over an empty list passes forever. This is the same failure as a
    // pattern that matches nothing, one level up.
    expect(SCANNED.length).toBeGreaterThan(15);
    expect(SCANNED).toContain("render.ts");
    expect(SCANNED).not.toContain(OWNER);
  });

  for (const file of SCANNED) {
    test(`${file} does not re-derive an event-space conversion`, () => {
      const found = leaksIn(readFileSync(join(SRC, file), "utf8"));
      expect(found, `${file} converts display geometry itself — call spaces.ts ` +
                    `(displayToOutput/mapPoint/mapVector) instead:\n${found.join("\n")}`)
        .toEqual([]);
    });
  }

  /**
   * The guard must be able to FAIL, which is a separate claim from it passing.
   *
   * This repo has paid for the difference four times over — a bound nobody
   * watched fire, a floor with enough slack to hide a missing term, a PiP test
   * that passed with the compositor removed, a `SYSTEM_CLAIMED` list that
   * matched nothing. `toEqual([])` is satisfied just as well by a pattern that
   * matches nothing, so the controls are the load-bearing half.
   *
   * The first three lines are render.ts's own code from before this ticket.
   */
  test("the patterns catch what they exist to catch", () => {
    const wouldLeak = [
      "const sx = project.output.width / display.pointWidth;",
      "const sy = project.output.height / display.pointHeight;",
      "x: (s.x - display.originX) * sx,",
      "y: (s.y - d.originY) * scale,",
      "const px = width * shot.display.backingScale;",
      "return p.x - display.originX;",
    ];
    for (const line of wouldLeak) {
      expect(leaksIn(line), `this should have been caught: ${line}`).not.toEqual([]);
    }
  });

  /**
   * And it must not fire on the things a file legitimately says. A guard that
   * cries wolf is a guard someone turns off — and every one of these is real
   * code in shot.ts, types.ts or still-decorate.ts today.
   */
  test("the patterns leave legitimate code alone", () => {
    const fine = [
      "      backingScale: d.backingScale, originX: d.originX, originY: d.originY,",
      "    id: d.id as number, pointWidth: d.pointWidth as number,",
      // The real line from shot.ts that this guard flagged on its first run:
      // the fields are named inside the MESSAGE, and `.originX/originY` reads
      // as a division until you see the quotes.
      '  if (!isNum(d.originX) || !isNum(d.originY)) throw new ShotLoadError("display.originX/originY must be numbers");',
      '  const what = "output.width / display.pointWidth";',
      "  return pxPerPointFrom(shot.frame.width, sourcePoints ?? 0) ?? shot.display.backingScale;",
      "  originX: number;",
      "  const m = displayToOutput(session.anchors.display, project.output);",
      "// global points → display-local points → output pixels",
      "/** `output.width / display.pointWidth` is what this module owns */",
    ];
    for (const line of fine) {
      expect(leaksIn(line), `this should NOT have been caught: ${line}`).toEqual([]);
    }
  });
});
