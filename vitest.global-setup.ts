import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Build the helper AND the app bundle ONCE for the whole run. Previously each
 * suite rebuilt the helper in its own beforeAll; run concurrently they raced on
 * build/stc-helper — one signing it while the other overwrote it — and
 * whichever lost had its entire file reported as failed-to-collect, silently
 * skipping every test in it.
 *
 * The app bundle had the SAME bug one directory over, and it outlived the
 * helper's fix because it fails as a timeout in a UI assertion rather than as a
 * build error, so it read as flakiness. Six test files each ran app/build.mjs
 * per launch: measured at 17 builds in one `vitest run app/test`, 5 of them in
 * flight at once, all writing app/dist/{main.mjs,preload.cjs,renderer.js}.
 * esbuild truncates an output file before rewriting it, so a sampler watching
 * those paths caught all three at ZERO bytes mid-run — renderer.js 282 times,
 * it being the largest. An Electron launch landing in that window loads an
 * empty renderer: the page renders, no script runs, #takes stays empty, and
 * take-library.e2e.test.ts's 20 s poll fails. Load only widens the window,
 * which is why it looked like contention between two sessions on one machine.
 *
 * app/test/build-once.test.ts keeps the per-test builds from coming back.
 *
 * A non-zero exit must throw: swiftc leaves the previous binary in place on
 * failure, so an unchecked build silently tests stale code.
 */
export default function setup() {
  execFileSync(fileURLToPath(new URL("./helper/build.sh", import.meta.url)), { stdio: "pipe" });
  execFileSync("node", [fileURLToPath(new URL("./app/build.mjs", import.meta.url))], {
    cwd: fileURLToPath(new URL(".", import.meta.url)), stdio: "pipe",
  });
}
