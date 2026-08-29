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
// One direction only: this depends on bounds, bounds depend on nothing. The
// reverse made a cycle that ESM resolves by hanging on the top-level await.
import { ATTEMPTS, ATTEMPT_MS, GATE_PROCESS_MS, GATE_ATTEMPTS } from "./gate-bounds.mjs";

export { ATTEMPTS, ATTEMPT_MS };


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
export function announceSkip(detail, { write = (s) => process.stderr.write(s), gate = "Determinism gate", attempts = ATTEMPTS } = {}) {
  const tries = attempts === 1 ? "on its only attempt" : `after ${attempts} attempts`;
  const line =
    `${gate} DID NOT RUN — the machine could not service the video ` +
    `pipeline ${tries} (STC-259). This is NOT a pass.`;
  // stderr, not console.warn: vitest discards console output from a skipped
  // test, and an annotation that only prints when it is not needed is the
  // silent skip this exists to prevent.
  if (process.env.GITHUB_ACTIONS) write(`::warning title=${gate} skipped::${line}\n`);
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
  announceSkip(last.out, { gate: opts.gate ?? "Determinism gate", attempts });
  return 0;
}

// CLI: run ONE gate under its declared bound, retried only if it declares
// attempts. This is the single entry point for every gate — a gate that is not
// in GATE_PROCESS_MS is refused rather than silently defaulted, because
// defaulting is how a gate ends up unbounded and holding a CI job to its cap.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { basename } = await import("node:path");

  const target = process.argv[2] ?? new URL("./gate.mjs", import.meta.url).pathname;
  // Everything after the target belongs to the GATE, not to this runner — CI
  // calls `npm run gate:export -- "$TAKE"`, and swallowing that argument left
  // export-gate hunting for a session it was never told about ("no session
  // found", exit 2). A wrapper that quietly drops its child's arguments is
  // worse than no wrapper.
  const gateArgs = process.argv.slice(3);
  const name = basename(target);
  const attemptMs = GATE_PROCESS_MS[name];
  if (typeof attemptMs !== "number") {
    console.error(
      `FAIL: no process bound declared for ${name}. Add it to GATE_PROCESS_MS in ` +
      `scripts/gate-bounds.mjs, with a floor in gateFloorMs(), so the CI job's ` +
      `worst case accounts for it.`,
    );
    process.exit(2);
  }
  const attempts = GATE_ATTEMPTS[name] ?? 1;
  const label = name.replace(/-?gate\.mjs$/, "") || "determinism";
  const gate = `${label.charAt(0).toUpperCase()}${label.slice(1)} gate`;
  process.exit(await runWithRetry(process.execPath, [target, ...gateArgs], { attempts, attemptMs, gate }));
}