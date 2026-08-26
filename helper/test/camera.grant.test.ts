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
        `Grant Camera to STC Signing Probe in System Settings > Privacy & Security > Camera, ` +
        `then re-run. Until then the camera path is unverified.`,
      );
    }
    expect(result.helperAuth).toBe("authorized");
    expect(Array.isArray(result.helperDevices)).toBe(true);
  }, 60_000);
});
