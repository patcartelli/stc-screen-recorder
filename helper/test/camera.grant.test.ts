/**
 * Requires a Camera grant for STCTestHost, so it is NOT part of `npm test` —
 * see vitest.grant.config.ts and `npm run test:capture`.
 *
 * It is a separate FILE rather than a skip on purpose. A skipped test reads
 * as covered and quietly rots; a named script that someone has to run is at
 * least honest about being a manual step.
 */
import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const APP = join(root, "tools/test-host/STCTestHost.app");
const HELPER = join(root, "helper/build/stc-helper");

describe("camera grant — requires Camera access for STCTestHost", () => {
  // The property under test is inheritance: a bare CLI binary takes the TCC
  // identity of the bundle that launched it. Terminal-testing the helper proves
  // nothing about the shipped app, which is why this goes through the bundle.
  test("the helper inherits Camera authorization from the launching bundle", () => {
    const out = join(mkdtempSync(join(tmpdir(), "stc-cam-")), "result.json");
    execFileSync("open", ["-W", APP, "--args", "--camera-probe", "--helper", HELPER, "--out", out]);
    const result = JSON.parse(readFileSync(out, "utf8"));

    if (result.helperAuth === "notDetermined" || result.helperAuth === "denied") {
      throw new Error(
        `SKIP-GRANT: STCTestHost has no Camera grant (helperAuth=${result.helperAuth}). ` +
        `The Camera pane only lists apps that have already REQUESTED access, so the ` +
        `bundle will not appear there until it has. Working procedure: ` +
        `(1) run 'open -W ${APP} --args --camera-request --out /tmp/cam-request.json' ` +
        `to raise the system prompt, (2) click Allow, (3) re-run this test (or ` +
        `'npm run test:capture').`,
      );
    }
    if (typeof result.helperAuth === "string" && result.helperAuth.startsWith("unexpected-reply:")) {
      // The helper replied to seq 1, just not with a camera-probe event — an
      // error mid-reply, most likely. Fail loudly with what it actually said
      // rather than letting this read as an assertion mismatch against
      // "authorized", which looks like a plain auth failure.
      throw new Error(
        `Helper answered seq 1 with ${result.helperAuth} instead of camera-probe ` +
        `(code=${result.helperReplyCode ?? "?"}, detail=${result.helperReplyDetail ?? "?"}).`,
      );
    }
    expect(result.helperAuth).toBe("authorized");
    expect(Array.isArray(result.helperDevices)).toBe(true);
  }, 60_000);
});
