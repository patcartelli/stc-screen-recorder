import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..", "..");

describe("capture decisions", () => {
  test("Swift pure-function assertions all pass", () => {
    const bin = join(mkdtempSync(join(tmpdir(), "stc-dec-")), "dec-test");
    const sdk = execFileSync("xcrun", ["--show-sdk-path"], { encoding: "utf8" }).trim();
    execFileSync("swiftc", [
      "-sdk", sdk, "-target", "arm64-apple-macos13.0", "-o", bin,
      join(root, "helper/src/CaptureDecisions.swift"),
      join(root, "helper/test/decisions/main.swift"),
    ], { stdio: "pipe" });
    const out = execFileSync(bin, { encoding: "utf8" });
    expect(out, out).toContain("ALL PASS");
  });
}, 60_000);
