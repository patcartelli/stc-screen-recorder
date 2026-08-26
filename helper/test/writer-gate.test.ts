import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..", "..");

describe("writer gate (STC-254)", () => {
  // A first append racing teardown used to kill the helper outright — SIGSEGV
  // on CI, twice, inside AVFoundation's lazy compressor creation. The harness
  // dies by signal when it regresses, so execFileSync throwing IS the failure.
  test("a first append racing teardown does not kill the process", () => {
    const bin = join(mkdtempSync(join(tmpdir(), "stc-writer-gate-")), "writer-gate-test");
    const sdk = execFileSync("xcrun", ["--show-sdk-path"], { encoding: "utf8" }).trim();
    execFileSync("swiftc", [
      "-sdk", sdk, "-target", "arm64-apple-macos13.0", "-o", bin,
      join(root, "helper/src/WriterGate.swift"),
      join(root, "helper/test/writer-gate/main.swift"),
    ], { stdio: "pipe" });
    const out = execFileSync(bin, { encoding: "utf8" });
    expect(out, out).toContain("ALL PASS");
  });
}, 120_000);
