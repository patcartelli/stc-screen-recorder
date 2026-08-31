import { describe, test, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withoutComments } from "./_source-text.js";
import { UNATTRIBUTED_SAFE_MARKERS } from "../../scripts/gate-skip-rate.mjs";

const root = join(__dirname, "..", "..");
const TEST_DIRS = [join("transform", "test"), join("app", "test"), join("helper", "test")];

/**
 * `scripts/gate-skip-rate.mjs` measures a run's gates from its logs. With
 * per-step attribution it scopes each verdict to that gate's own step, which is
 * always correct. GitHub only adds attribution some hours after a run, though,
 * so a run anyone actually wants to check after a change has none — and the
 * script then falls back to matching the WHOLE job log.
 *
 * That fallback is sound for exactly one reason: no test prints those markers.
 * The determinism markers are excluded from it precisely because
 * transform/test/gate-retry.test.ts does print them, and reading that fixture
 * as a live skip is how this measurement was published wrong the first time —
 * 100% when the truth was 60%.
 *
 * So the flag is asserted against the test tree, not trusted as a comment. Add
 * a test that prints "SEEK GATE: PASS" and the fallback starts lying silently;
 * this fails instead.
 *
 * The markers are imported rather than written out, so this file does not
 * contain them literally and cannot flag itself — the same prose-versus-code
 * problem that has now caught three guards in this repo.
 */
describe("the unattributed fallback is only safe while no test prints its markers", () => {
  const testSources = TEST_DIRS.flatMap((dir) =>
    readdirSync(join(root, dir), { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(ts|mjs)$/.test(e.name))
      .map((e) => ({
        path: join(dir, e.name),
        // Comments stripped. This file's own prose mentions a marker while
        // explaining the rule, and the first draft duly flagged itself — the
        // same prose-versus-code trap that has now caught four guards here,
        // and the first time one of them caught it on its own.
        src: withoutComments(readFileSync(join(root, dir, e.name), "utf8")),
      })));

  test("the test tree is not empty, or this asserts nothing", () => {
    expect(testSources.length).toBeGreaterThan(10);
  });

  test("no test emits a marker the fallback treats as a real gate verdict", () => {
    const offenders: string[] = [];
    for (const marker of UNATTRIBUTED_SAFE_MARKERS) {
      for (const f of testSources) {
        if (f.src.includes(marker)) offenders.push(`${f.path} contains ${JSON.stringify(marker)}`);
      }
    }
    expect(offenders,
      "a test printing one of these makes gate-skip-rate misread a passing gate as " +
      `skipped on any run without step attribution:\n${offenders.join("\n")}`).toEqual([]);
  });

  test("determinism is NOT in the safe set, because a test does print its markers", () => {
    expect(UNATTRIBUTED_SAFE_MARKERS.join("\n")).not.toMatch(/Determinism/);
  });
});
