import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { withoutComments } from "./_source-text.js";
import { PROJECT_VERSIONS, isProjectVersion } from "../src/project-version.js";

/**
 * One list of project versions, enforced structurally (STC-318).
 *
 * This is not checkable behaviourally in a way that would have caught the bug
 * it exists for. `main.ts`'s gate accepted 1-3 while `parseProject` accepted
 * 1-4, so **project-4 documents could not be saved at all** — and every unit
 * test passed (they never cross the process line) and every E2E test passed
 * (each happened to write a v3). The two lists were each internally
 * consistent; only their disagreement was the fault.
 *
 * Same family as every "one value, two copies" defect in CLAUDE.md, with the
 * process boundary hiding it — the fifth instance, and the second where the
 * copies are not even in the same runtime.
 *
 * ## Why this is NOT a repo-wide grep, said out loud
 *
 * The first draft scanned every source file for a `.version !== N && …` chain
 * and immediately cried wolf on `session.ts` and `shot.ts`, which chain on
 * ANCHORS and SHOT versions — different documents, different lists, both
 * legitimate. A guard that fires on correct code is a guard someone turns off,
 * and CLAUDE.md already records what that costs twice over.
 *
 * So the scope is the two files that gate a PROJECT document, named. That is
 * weaker than a sweep and it is the honest strength: a third gate elsewhere
 * would not be caught, and the mitigation is that `isProjectVersion` is the
 * only exported way to ask, so writing a new chain means deliberately not
 * using it. Half a guard nobody disables beats a whole one everybody does —
 * `spaces-seam.test.ts` reached the same conclusion about UV.
 */
const root = join(__dirname, "..", "..");

/**
 * The files that decide whether a PROJECT document is readable. Named, not
 * swept — see the header. Both were a hand-rolled chain until this change.
 */
const GATES = [
  join("app", "src", "main.ts"),
  join("transform", "src", "trim.ts"),
];

const sourceOf = (rel: string) =>
  // Comments AND strings blanked: this module's own doc comment quotes the
  // pattern it forbids, and an error message may legitimately name a version.
  // The lesson library-seam.test.ts and spaces-seam.test.ts both learned on
  // their first run.
  withoutComments(readFileSync(join(root, rel), "utf8"))
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g,
             (m) => m.replace(/[^\n]/g, " "));

/** A hand-rolled chain: `.version !== 1 && … !== 2`, in either polarity. */
const CHAIN = /\.version\s*[!=]==?\s*\d[\s\S]{0,80}?\.version\s*[!=]==?\s*\d/;

describe("project versions have one owner (STC-318)", () => {
  for (const rel of GATES) {
    test(`${rel} asks isProjectVersion instead of listing versions`, () => {
      const src = sourceOf(rel);
      expect(src, `${rel} must call isProjectVersion()`).toContain("isProjectVersion");
      const line = CHAIN.exec(src)?.[0]?.replace(/\s+/g, " ").trim();
      expect(line, `${rel} hand-rolls a project version list: ${line}`).toBeUndefined();
    });
  }

  /**
   * The controls. `toBeUndefined()` is satisfied just as well by a pattern
   * that matches nothing — this repo has been bitten by that four times, and
   * the thing this guard forbids READ AS CORRECT for a day while silently
   * breaking every save of a project-4 document.
   */
  test("the pattern catches both real chains it was written for", () => {
    const real = [
      // app/src/main.ts, exactly as it stood while project-4 was unwritable.
      "  if (doc?.version !== 1 && doc?.version !== 2 && doc?.version !== 3) {",
      // transform/src/trim.ts, as it stood before this change.
      "  if (doc.version !== 1 && doc.version !== 2 && doc.version !== 3 && doc.version !== 4) return fallback;",
      "if (p.version === 3 || p.version === 4) return true;",
    ];
    for (const line of real) {
      expect(CHAIN.test(line), `should have been caught: ${line}`).toBe(true);
    }
  });

  test("the pattern leaves legitimate code in those files alone", () => {
    const fine = [
      "    expect(out.version).toBe(3);",
      "  if (doc.version !== 1) return fallback;",       // one check is not a list
      "  return { version: TRANSFORM_VERSION };",
      "  if (!isProjectVersion(doc?.version)) throw new Error();",
      "  const v = anchors.version === 1 ? a : b;",
    ];
    for (const line of fine) {
      expect(CHAIN.test(line), `should NOT have been caught: ${line}`).toBe(false);
    }
  });

  test("the guard can FAIL — the chain put back is caught", () => {
    // Watched failing rather than assumed: the real main.ts line, run through
    // the same blanking the guard uses.
    const planted = sourceOf(GATES[0]!)
      + "\nif (doc?.version !== 1 && doc?.version !== 2) throw 0;\n";
    expect(CHAIN.test(planted)).toBe(true);
  });
});

describe("isProjectVersion", () => {
  test("accepts exactly the versions with a schema on disk", () => {
    const schemas = readdirSync(join(root, "schema"))
      .map((f) => /^project-(\d+)\.schema\.json$/.exec(f)?.[1])
      .filter((n): n is string => !!n)
      .map(Number)
      .sort((a, b) => a - b);
    // The list and the schema files cannot drift: minting project-6 without
    // adding it here, or vice versa, fails right here.
    expect([...PROJECT_VERSIONS]).toEqual(schemas);
  });

  test("refuses everything else, including the near misses", () => {
    for (const v of [0, 6, -1, 1.5, "1", null, undefined, NaN, [1]]) {
      expect(isProjectVersion(v), `${JSON.stringify(v)}`).toBe(false);
    }
    for (const v of PROJECT_VERSIONS) expect(isProjectVersion(v)).toBe(true);
  });
});
