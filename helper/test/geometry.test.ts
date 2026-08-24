import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..", "..");

describe("capture geometry", () => {
  test("Swift pure-function assertions all pass", () => {
    const bin = join(mkdtempSync(join(tmpdir(), "stc-geom-")), "geom-test");
    const sdk = execFileSync("xcrun", ["--show-sdk-path"], { encoding: "utf8" }).trim();
    execFileSync("swiftc", [
      "-sdk", sdk, "-target", "arm64-apple-macos13.0", "-o", bin,
      join(root, "helper/src/CaptureGeometry.swift"),
      join(root, "helper/test/geometry/main.swift"),
    ], { stdio: "pipe" });
    const out = execFileSync(bin, { encoding: "utf8" });
    expect(out, out).toContain("ALL PASS");
  });
}, 60_000);
