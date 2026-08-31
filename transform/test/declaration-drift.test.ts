import { describe, test, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { withoutComments } from "./_source-text.js";

const root = join(__dirname, "..", "..");
const SCRIPTS = join(root, "scripts");

/**
 * `scripts/*.d.mts` are HAND-WRITTEN, and nothing checked them against the
 * `.mjs` they describe.
 *
 * `tsconfig.json` has `allowJs` off, so tsc reads the declaration and never
 * looks at the implementation — the two can say different things and all three
 * typecheck passes stay green. This bit twice in one day: `worstCaseJobMs`
 * gained a parameter and `bounded` gained a thunk label, and both times the
 * stale declaration produced an error. Those errored the SAFE way.
 *
 * The dangerous direction is the other one. A declaration that promises MORE
 * than the code delivers — a name that was renamed or removed, a `function`
 * that became a constant — typechecks clean at every call site and fails at
 * runtime, in a script that only runs on CI or by hand.
 *
 * So this imports each module for real and checks the declared surface exists.
 * It cannot check parameter types; it catches the failure that actually
 * reaches runtime.
 */
const DECLARED = /^export declare (?:const|function)\s+([A-Za-z_$][\w$]*)/gm;
const DECLARED_FN = /^export declare function\s+([A-Za-z_$][\w$]*)/gm;

const names = (src: string, re: RegExp) =>
  [...withoutComments(src).matchAll(re)].map((m) => m[1]!);

const files = readdirSync(SCRIPTS)
  .filter((n) => n.endsWith(".d.mts"))
  .map((n) => ({
    decl: n,
    impl: n.replace(/\.d\.mts$/, ".mjs"),
    src: readFileSync(join(SCRIPTS, n), "utf8"),
  }));

describe("hand-written declarations match the modules they describe", () => {
  test("there are declarations to check, or this asserts nothing", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    test(`${f.decl} — every declared export exists in ${f.impl}`, async () => {
      expect(existsSync(join(SCRIPTS, f.impl)), `${f.impl} does not exist`).toBe(true);
      const mod = await import(pathToFileURL(join(SCRIPTS, f.impl)).href);

      const missing = names(f.src, DECLARED).filter((n) => !(n in mod));
      expect(missing,
        `${f.decl} declares names that ${f.impl} does not export. Every call site ` +
        `typechecks and fails at runtime:\n${missing.join(", ")}`).toEqual([]);

      const notFunctions = names(f.src, DECLARED_FN)
        .filter((n) => n in mod && typeof mod[n] !== "function");
      expect(notFunctions,
        `${f.decl} declares these as functions but ${f.impl} exports something ` +
        `else:\n${notFunctions.join(", ")}`).toEqual([]);
    });
  }
});
