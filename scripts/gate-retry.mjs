/**
 * Runs a gate, and retries it ONLY when the machine declined.
 *
 * CI's macOS runners are VMs sharing video hardware with other tenants, and
 * that hardware intermittently stops answering: measured on roughly HALF of
 * master's push runs (STC-259). The gate then fails one of two ways, both of
 * them a bound firing rather than a wrong answer:
 *
 *   - the page is alive and an in-page bound fires (`decoder flush did not
 *     complete within 60000ms`)
 *   - the renderer's main thread is wedged, no JS timer can run, and only the
 *     out-of-process bound fires (`the in-page gate run ... did not return
 *     within 180000 ms`)
 *
 * A master that is red half the time is not a loud failure, it is an ambiguous
 * one: the red X means either "you broke determinism" or "Apple's shared GPU
 * did not answer", and nobody can tell which without opening logs. That is how
 * a real breakage survives — one landed on master today behind exactly this
 * noise. So the two outcomes are separated: red always means the code, SKIP
 * means the machine, and the SKIP is annotated rather than quietly green.
 *
 * THE RETRY MUST NEVER ABSORB A REGRESSION. It is keyed strictly on the marker
 * the gate prints on the bound-fired path, and a `FAIL:` line, a death by
 * signal, or this runner's own bound each disqualify a run from being retried —
 * every one of those covered by a test. STC-254 already arrived once wearing an
 * environment failure's clothes.
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

export const ATTEMPTS = 3;
/**
 * The bound on ONE attempt, and it must clear what an attempt can legitimately
 * cost: the in-page bound (EVAL_MS), both teardown bounds, the browser/vite
 * launch, AND the 60 s wait for the page to reach `__ready`. Set it below that and this outer bound fires first, the attempt is
 * labelled with THIS runner's message instead of the gate's `ENVIRONMENT:` one,
 * and isEnvironmentFailure() then correctly refuses to retry it — the retry
 * would silently stop working.
 *
 * It was 600_000 when the retry landed in #39, which made the worst case
 * ATTEMPTS x 10 min = 30 min for this gate ALONE — the entire CI job cap,
 * before the other three gates run. gate-bounds.test.ts models the whole job
 * now and asserts both directions of that.
 */
export const ATTEMPT_MS = 420_000;

/**
 * The machine declined — not the code. `ENVIRONMENT:` alone is not enough:
 * a run that also printed a real `FAIL:` has a regression in it regardless of
 * what else went wrong, and a signal death is never the machine being polite.
 */
export function isEnvironmentFailure(output, { signal = null } = {}) {
  if (signal) return false;
  if (!output.includes("ENVIRONMENT:")) return false;
  if (output.includes("FAIL:")) return false;
  if (output.includes("did not finish within")) return false;  // this runner's own bound
  return true;
}

/** A skipped gate has to be louder than a green tick, or it is just a silent pass. */
export function announceSkip(detail, { write = (s) => process.stderr.write(s) } = {}) {
  const line =
    `Determinism gate DID NOT RUN — the machine could not service the video ` +
    `pipeline after ${ATTEMPTS} attempts (STC-259). This is NOT a pass.`;
  // stderr, not console.warn: vitest discards console output from a skipped
  // test, and an annotation that only prints when it is not needed is the
  // silent skip this exists to prevent.
  if (process.env.GITHUB_ACTIONS) write(`::warning title=Determinism gate skipped::${line}\n`);
  write(`\n${line}\n${detail.slice(-800)}\n`);
  return line;
}

function once(cmd, args, { attemptMs = ATTEMPT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const grab = (c) => { out += c; process.stdout.write(c); };
    child.stdout.on("data", grab);
    child.stderr.on("data", grab);
    const timer = setTimeout(() => {
      out += `\nthe gate attempt did not finish within ${attemptMs} ms\n`;
      child.kill("SIGKILL");
    }, attemptMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out });
    });
  });
}

/**
 * Returns the process exit code. 0 for a pass AND for a skip — a skip is
 * announced, not silently green, and the annotation is the record that the
 * gate did not run.
 */
export async function runWithRetry(cmd, args, opts = {}) {
  const attempts = opts.attempts ?? ATTEMPTS;
  const log = opts.attemptLog ?? process.env.STC_GATE_ATTEMPT_LOG;
  let last = { out: "" };
  for (let n = 1; n <= attempts; n++) {
    if (log) appendFileSync(log, `attempt ${n}\n`);
    last = await once(cmd, args, opts);
    if (last.code === 0 && !last.signal) return 0;
    if (!isEnvironmentFailure(last.out, { signal: last.signal })) {
      // A real failure, a signal, or our own bound: never retried, never skipped.
      return last.code === 0 ? 1 : (last.code ?? 1);
    }
    if (n < attempts) {
      process.stderr.write(`[gate-retry] attempt ${n}/${attempts} failed for an ` +
                           `environment reason; retrying\n`);
    }
  }
  announceSkip(last.out);
  return 0;
}

// CLI: retry the determinism gate.
if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2] ?? new URL("./gate.mjs", import.meta.url).pathname;
  process.exit(await runWithRetry(process.execPath, [target]));
}
