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
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const APP = join(root, "tools/test-host/STCTestHost.app");
const HELPER = join(root, "helper/build/stc-helper");

// Every wait needs a bound and a reason (CLAUDE.md). execFileSync is
// synchronous, so it is immune to vitest's own test timeout — an unbounded
// call here would hang the whole grant run with no message. 60s matches the
// watchdog main.swift itself installs (`--timeout`, default 60s).
const OPEN_TIMEOUT_MS = 60_000;

describe("camera grant — requires Camera access for STCTestHost", () => {
  // The property under test is inheritance: a bare CLI binary takes the TCC
  // identity of the bundle that launched it. Terminal-testing the helper proves
  // nothing about the shipped app, which is why this goes through the bundle.
  test("the helper inherits Camera authorization from the launching bundle", () => {
    if (!existsSync(APP)) {
      throw new Error(
        `${APP} does not exist. Build it first: tools/test-host/build.sh ` +
        `(do not auto-build here — codesign can block forever on a hidden GUI ` +
        `keychain dialog; see CLAUDE.md).`,
      );
    }
    const out = join(mkdtempSync(join(tmpdir(), "stc-cam-")), "result.json");
    try {
      execFileSync("open", ["-W", APP, "--args", "--camera-probe", "--helper", HELPER, "--out", out],
        { timeout: OPEN_TIMEOUT_MS });
    } catch (err: any) {
      if (err?.signal || err?.code === "ETIMEDOUT") {
        throw new Error(
          `'open -W ${APP}' did not return within ${OPEN_TIMEOUT_MS}ms and was killed ` +
          `(signal=${err.signal ?? "?"}). The bundle likely wedged — check for a stray ` +
          `process (ps -Ao pid,command | grep STCTestHost) or a stuck system prompt.`,
        );
      }
      throw err;
    }
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
  }, OPEN_TIMEOUT_MS + 10_000);
});
