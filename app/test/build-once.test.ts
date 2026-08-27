import { describe, test, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The app bundle must be built ONCE per run, in the global setup — never inside
 * a test.
 *
 * vitest.global-setup.ts already says why, for the helper: suites that each
 * rebuilt it raced on the same output path. The app bundle had exactly that
 * bug one directory over and nobody had noticed, because it fails as a timeout
 * in a UI assertion rather than as a build error.
 *
 * Measured on 2026-08-27, `vitest run app/test`: 17 builds in one run, 5 of
 * them in flight at once, all writing app/dist/{main.mjs,preload.cjs,
 * renderer.js}. esbuild truncates an output file before rewriting it, so a
 * sampler watching those three paths through a run caught every one of them at
 * ZERO bytes — renderer.js 282 times, it being the largest and slowest to
 * write. An Electron launch landing in that window loads an empty renderer:
 * the page renders, no script runs, #takes stays empty, and the 20 s poll in
 * take-library.e2e.test.ts fails. Load does not cause this; it only widens the
 * window, which is why it looked like machine contention between two sessions.
 */
const root = join(__dirname, "..", "..");
/** This file names build.mjs to assert about it; scanning itself would self-trip. */
const SELF = "build-once.test.ts";

describe("the app bundle is built once per run, not per test", () => {
  test("no test file shells out to app/build.mjs", () => {
    const offenders: string[] = [];
    for (const dir of ["app/test", "transform/test", "helper/test"]) {
      for (const f of readdirSync(join(root, dir))) {
        if (!f.endsWith(".ts") || f === SELF) continue;
        const src = readFileSync(join(root, dir, f), "utf8");
        src.split("\n").forEach((line, i) => {
          if (/build\.mjs/.test(line)) offenders.push(`${dir}/${f}:${i + 1} ${line.trim()}`);
        });
      }
    }
    expect(offenders, `these rebuild app/dist/ mid-run and race each other:\n${offenders.join("\n")}`)
      .toEqual([]);
  });

  test("the global setup builds it, so removing the per-test builds did not remove it entirely", () => {
    // Without this the first assertion is satisfiable by building it NOWHERE,
    // and every E2E test would then run against a stale or absent bundle.
    const setup = readFileSync(join(root, "vitest.global-setup.ts"), "utf8");
    expect(setup).toMatch(/build\.mjs/);
  });
});
