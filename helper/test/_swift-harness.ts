import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..", "..");

/**
 * The bound on the harness RUN. Exported so a harness's OWN inner bounds can be
 * checked against it instead of assumed clear of it — an inner bound set too
 * near this one never gets to print its message, which is STC-259's whole shape.
 */
export const HARNESS_RUN_MS = 45_000;

/**
 * Compiles a Swift source set into a throwaway binary, runs it, and returns
 * stdout.
 *
 * Both steps are bounded, and the SHAPE of the bound is the point.
 *
 * The first attempt used `execFileSync(..., { timeout })`. Being synchronous,
 * it blocks the worker's event loop for its entire duration — so vitest's own
 * `testTimeout` cannot fire while it runs. That timer is a JS timer and a
 * blocked loop never reaches it. The suite therefore had exactly one bound in
 * play (execFileSync's own), and if that one did not fire for any reason there
 * was nothing behind it: on CI the job died silently at its 30-minute limit,
 * twice, in this same file, with no message and a stranded `node` as the only
 * trace. Spawning asynchronously restores vitest's timeout as a second line of
 * defence behind ours.
 *
 * `detached` gives the child its own process group so a timeout can kill
 * grandchildren too, and the timeout path rejects immediately instead of
 * waiting on streams that may never close.
 *
 * NOT verified: exactly why the CI runs hung. A probe that killed a child while
 * a grandchild held the inherited stdout did NOT reproduce it — `execFileSync`
 * returned on schedule — so the tempting "spawnSync waits for pipe EOF" story
 * is unproven and is deliberately not asserted here. What this change buys is a
 * bound that does not depend on that answer.
 */
export async function runSwiftHarness(opts: {
  /** Short name used for the temp dir, the binary, and failure messages. */
  label: string;
  /** Repo-relative Swift sources, compiled together. */
  sources: string[];
  compileMs?: number;
  runMs?: number;
  /**
   * Extra environment for the harness RUN only, never the compile. Used to
   * inject faults so a bound can be watched firing: a bound nobody has seen
   * fire is indistinguishable from one that cannot.
   */
  env?: Record<string, string>;
}): Promise<string> {
  // Deliberately BELOW the callers' vitest testTimeout (120 s). They were equal,
  // so vitest always fired first and our message — the one that names WHICH
  // step hung and prints the output tail — never got the chance. Two bounds set
  // too close together, which is exactly STC-258 repeated: the outer bound must
  // stay clear of the inner one or the inner one is decorative.
  const { label, sources, compileMs = 45_000, runMs = HARNESS_RUN_MS, env } = opts;
  const bin = join(mkdtempSync(join(tmpdir(), `stc-${label}-`)), `${label}-test`);
  // Fast, no child of its own, and a hang here would be a broken toolchain
  // rather than the thing under test.
  const sdk = execFileSync("xcrun", ["--show-sdk-path"], {
    encoding: "utf8",
    timeout: 60_000,
  }).trim();

  await runBounded(
    "swiftc",
    ["-sdk", sdk, "-target", "arm64-apple-macos13.0", "-o", bin,
     ...sources.map((s) => join(root, s))],
    `${label}: swiftc`,
    compileMs,
  );

  return await runBounded(bin, [], `${label}: harness`, runMs, env);
}

/**
 * Runs one command with a bound on the WAIT.
 *
 * A non-zero exit or a fatal signal is reported, not swallowed: a harness dying
 * by SIGSEGV IS the failure writer-gate exists to catch, and a harness that
 * printed why it could not run deserves to have that printed back.
 */
function runBounded(
  cmd: string,
  args: string[],
  what: string,
  ms: number,
  env?: Record<string, string>,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, args, {
      // Its own process group, so a timeout can take the grandchildren too.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : process.env,
    });

    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      err += s;
      // Streamed, not merely collected. When VITEST's timeout fires rather than
      // ours, this promise never settles and everything buffered here is
      // discarded — losing the diagnostics at the exact moment they matter.
      // Seen on CI: writer-gate timed out at 120 s twice and left no clue why.
      process.stderr.write(s);
    });

    let settled = false;
    const tail = (s: string) => s.slice(-2000);
    const detail = () => `\nstdout tail:\n${tail(out)}\nstderr tail:\n${tail(err)}`;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Negative pid = the whole group. Killing only the child is what left
      // grandchildren holding the pipes last time.
      try { process.kill(-(child.pid as number), "SIGKILL"); }
      catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
      // Do not wait for "close": the streams are exactly what may never end.
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      reject(new Error(
        `${what} did not finish within ${ms} ms; killed its process group.${detail()}`,
      ));
    }, ms);

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${what} could not be started: ${e.message}`));
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) return reject(new Error(`${what} died by signal ${signal}.${detail()}`));
      if (code !== 0) return reject(new Error(`${what} exited ${code}.${detail()}`));
      resolve(out);
    });
  });
}
