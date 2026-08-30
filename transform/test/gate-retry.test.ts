import { describe, test, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isEnvironmentFailure, announceSkip, runWithRetry, ATTEMPTS } from "../../scripts/gate-retry.mjs";
import * as retry from "../../scripts/gate-retry.mjs";

/**
 * The retry exists to absorb a CI runner whose shared video hardware stopped
 * answering — measured on roughly half of master's push runs (STC-259). It must
 * NEVER absorb a determinism regression, which is the one thing the gate is for.
 *
 * So the classifier is tested against each disqualifier by name, and the runner
 * is driven end to end with stub gates, counting attempts. A retry nobody has
 * counted is the same trap as a bound nobody has watched fire.
 */
const root = join(__dirname, "..", "..");

/** A stub "gate": prints what it is told, then exits how it is told. */
const stub = (print: string, exit: number) =>
  ["-e", `process.stdout.write(${JSON.stringify(print)}); process.exit(${exit});`];
const suicide = (print: string) =>
  ["-e", `process.stdout.write(${JSON.stringify(print)}); process.kill(process.pid, "SIGKILL");`];

const ENV_LINE = "ENVIRONMENT: decoder flush did not complete within 60000ms\n";

describe("gate retry — what counts as the machine declining", () => {
  test("a bound firing, and nothing else, is the machine", () => {
    expect(isEnvironmentFailure(ENV_LINE)).toBe(true);
  });

  test("a FAIL: line disqualifies it, even alongside ENVIRONMENT", () => {
    // The case that matters: a run that found a real hash mismatch AND timed
    // out somewhere is a regression, and retrying it would bury exactly what
    // the gate exists to catch.
    expect(isEnvironmentFailure(`${ENV_LINE}FAIL: gate A: 7 hash mismatches\n`)).toBe(false);
  });

  test("a death by signal is never the machine being polite", () => {
    // STC-254 arrived as SIGTRAP on CI and SIGSEGV locally. Retrying either
    // three times and calling it a skip would have buried it.
    expect(isEnvironmentFailure(ENV_LINE, { signal: "SIGKILL" })).toBe(false);
  });

  test("this runner's own bound is not an excuse to retry", () => {
    expect(isEnvironmentFailure(`${ENV_LINE}the gate attempt did not finish within 600000 ms\n`))
      .toBe(false);
  });

  test("an ordinary failure with no marker is not the machine", () => {
    expect(isEnvironmentFailure("FAIL: gate C: encode pipeline produced no bytes\n")).toBe(false);
  });
});

describe("gate retry — the runner, driven end to end", () => {
  const attemptLog = () => join(mkdtempSync(join(tmpdir(), "stc-gate-retry-")), "attempts");
  const attempts = (p: string) =>
    existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).length : 0;

  test("a passing gate runs once", async () => {
    const log = attemptLog();
    expect(await runWithRetry(process.execPath, stub("GATE: PASS\n", 0), { attemptLog: log })).toBe(0);
    expect(attempts(log)).toBe(1);
  });

  test("the machine declining is retried to the limit, then SKIPPED, exit 0", async () => {
    const log = attemptLog();
    // Driven with an EXPLICIT count rather than the production ATTEMPTS, which
    // has been 1 since 2026-08-30. `toBe(ATTEMPTS)` would then assert exactly
    // what "a passing gate runs once" already asserts, and would be satisfied
    // by the retry loop having been deleted. The mechanism has to stay covered
    // so restoring the retry is a one-line change rather than archaeology.
    const code = await runWithRetry(
      process.execPath, stub(ENV_LINE, 1), { attemptLog: log, attempts: 3 });
    // 0 because a skip is announced, not failed — the annotation is the record.
    expect(code).toBe(0);
    expect(attempts(log), "every attempt must be counted").toBe(3);
  });

  test("the determinism gate asks for ONE attempt, and that is a measurement", () => {
    // 19 consecutive skips, all three attempts failing identically at the same
    // bound, attempts 2 and 3 never once succeeding where 1 failed — 7 min of
    // CI per run for nothing (docs/STC-259-GATE-SKIP-RATE.md). Changing this
    // back should mean somebody re-measured with scripts/gate-skip-rate.mjs,
    // not that it drifted.
    expect(ATTEMPTS).toBe(1);
  });

  test("a real regression is NOT retried and fails", async () => {
    const log = attemptLog();
    const code = await runWithRetry(
      process.execPath, stub("FAIL: gate A: 7 hash mismatches\n", 1), { attemptLog: log });
    expect(code).toBe(1);
    expect(attempts(log), "a regression must not be attempted twice").toBe(1);
  });

  test("a gate that dies by signal is NOT retried, even printing ENVIRONMENT", async () => {
    const log = attemptLog();
    const code = await runWithRetry(process.execPath, suicide(ENV_LINE), { attemptLog: log });
    expect(code).not.toBe(0);
    expect(attempts(log)).toBe(1);
  });
});

describe("gate retry — the skip is loud", () => {
  test("the notice says the gate did not run, and that it is not a pass", () => {
    // A skip that reads as success is the "succeeds by finding nothing to do"
    // trap this repo keeps re-learning.
    let written = "";
    announceSkip("some detail", { write: (s) => { written += s; } });
    expect(written).toMatch(/DID NOT RUN/);
    expect(written).toMatch(/NOT a pass/);
    expect(written).toMatch(/some detail/);
  });
});

describe("gate retry — the .d.mts stays in step with the module", () => {
  test("every name the declaration file promises exists at runtime", () => {
    const declared = readFileSync(join(root, "scripts", "gate-retry.d.mts"), "utf8")
      .match(/export declare (?:const|function) (\w+)/g)!
      .map((m) => m.split(" ").pop()!);
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) {
      expect(retry, `gate-retry.d.mts declares ${name}, the module does not export it`)
        .toHaveProperty(name);
    }
  });
});
