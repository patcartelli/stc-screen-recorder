import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Build the helper ONCE for the whole run. Previously each suite rebuilt it in
 * its own beforeAll; run concurrently they raced on build/stc-helper — one
 * signing it while the other overwrote it — and whichever lost had its entire
 * file reported as failed-to-collect, silently skipping every test in it.
 *
 * A non-zero exit must throw: swiftc leaves the previous binary in place on
 * failure, so an unchecked build silently tests stale code.
 */
export default function setup() {
  execFileSync(fileURLToPath(new URL("./helper/build.sh", import.meta.url)), { stdio: "pipe" });
}
