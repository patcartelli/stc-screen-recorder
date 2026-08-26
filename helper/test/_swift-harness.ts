import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..", "..");

/**
 * Compiles a Swift source set into a throwaway binary, runs it, and returns
 * stdout.
 *
 * Both steps are BOUNDED, and that is the point of this module existing.
 * `execFileSync` is synchronous, so vitest's own `testTimeout` cannot interrupt
 * it: a harness that wedges takes the entire run down with it and nothing in
 * the test framework can stop it. On CI run 32997261497 the writer-gate harness
 * hung, burned the job's full 30-minute `timeout-minutes`, and the only trace
 * left behind was GitHub terminating an orphan process — no failing test, no
 * message, just a job that stopped.
 *
 * Four test files had this same unbounded shape copied between them, which is
 * why the bound lives here now rather than in each of them.
 */
export function runSwiftHarness(opts: {
  /** Short name used for the temp dir, the binary, and failure messages. */
  label: string;
  /** Repo-relative Swift sources, compiled together. */
  sources: string[];
  compileMs?: number;
  runMs?: number;
}): string {
  const { label, sources, compileMs = 120_000, runMs = 120_000 } = opts;
  const bin = join(mkdtempSync(join(tmpdir(), `stc-${label}-`)), `${label}-test`);
  const sdk = execFileSync("xcrun", ["--show-sdk-path"], {
    encoding: "utf8",
    timeout: 60_000,
  }).trim();

  bounded(
    () =>
      execFileSync(
        "swiftc",
        [
          "-sdk", sdk, "-target", "arm64-apple-macos13.0", "-o", bin,
          ...sources.map((s) => join(root, s)),
        ],
        { stdio: "pipe", timeout: compileMs, killSignal: "SIGKILL" },
      ),
    `${label}: swiftc`,
    compileMs,
  );

  return bounded(
    () => execFileSync(bin, { encoding: "utf8", timeout: runMs, killSignal: "SIGKILL" }),
    `${label}: harness`,
    runMs,
  );
}

/**
 * Turns a timeout kill into a message that says what was being waited for.
 *
 * Anything else is rethrown untouched — a harness that dies by SIGSEGV or exits
 * non-zero IS the failure some of these tests are looking for, and swallowing
 * that would make the regression they exist to catch invisible.
 */
function bounded<T>(fn: () => T, what: string, ms: number): T {
  try {
    return fn();
  } catch (e: unknown) {
    const err = e as { killed?: boolean; status?: number; signal?: string;
                       stdout?: unknown; stderr?: unknown };
    const tail = (s: unknown) => String(s ?? "").slice(-2000);
    // Always surface the harness's own output. execFileSync's default message
    // is "Command failed: <path>" and nothing else — so a harness that printed
    // exactly why it could not run had that explanation thrown away, leaving a
    // bare exit code to interpret.
    const detail = `\nstdout tail:\n${tail(err.stdout)}\nstderr tail:\n${tail(err.stderr)}`;
    if (err?.killed === true) {
      throw new Error(`${what} did not finish within ${ms} ms and was killed.${detail}`);
    }
    if (err?.signal) {
      throw new Error(`${what} died by signal ${err.signal}.${detail}`);
    }
    throw new Error(`${what} exited ${err?.status ?? "non-zero"}.${detail}`);
  }
}
