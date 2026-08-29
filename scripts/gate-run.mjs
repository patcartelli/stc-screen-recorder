/**
 * Runs ONE gate under its declared per-process bound.
 *
 * Every gate had inner bounds and only the determinism gate had an outer one
 * (ATTEMPT_MS, via gate-retry). That gap is not theoretical: on 2026-08-28 the
 * seek gate failed correctly in 10 seconds and then held the CI job for 17.5
 * more minutes in teardown, and the only thing that stopped it was the job cap
 * — which reports as "cancelled", so the log never said what went wrong.
 *
 * An inner bound cannot cover that. Every in-page bound is a JS timer and a
 * timer cannot fire while the renderer's main thread is wedged; teardown runs
 * in `finally`, after the inner bounds have already done their job. Only
 * another PROCESS can notice, which is what this is.
 *
 * It also makes `worstCaseJobMs()` a SUM of declared bounds rather than a model
 * of each gate's internals. A model has to be re-derived whenever a gate
 * changes and rots silently when nobody does — twice already, once omitting the
 * retry and once the readiness wait. A process bound cannot be under-counted:
 * whatever the gate does inside, it cannot exceed this.
 *
 * Usage: node scripts/gate-run.mjs scripts/seek-gate.mjs
 */
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { GATE_PROCESS_MS } from "./gate-bounds.mjs";

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/gate-run.mjs scripts/<gate>.mjs");
  process.exit(2);
}

const name = basename(target);
const ms = GATE_PROCESS_MS[name];
if (typeof ms !== "number") {
  // Refusing beats defaulting. A gate with no declared bound is a gate the job
  // model does not know about, and silently picking one here would put it back
  // in the state this file exists to leave.
  console.error(
    `FAIL: no process bound declared for ${name}. Add it to GATE_PROCESS_MS in ` +
    `scripts/gate-bounds.mjs, with a floor in gateFloorMs(), so the CI job's ` +
    `worst case accounts for it.`,
  );
  process.exit(2);
}

const child = spawn(process.execPath, [target], { stdio: "inherit" });

let killedByBound = false;
const timer = setTimeout(() => {
  killedByBound = true;
  // Said on the way out, not collected for later: a killed process cannot
  // print, and the reason is the whole value of having the bound.
  console.error(
    `\nENVIRONMENT: ${name} did not finish within ${ms} ms and was killed.\n` +
    `Its own inner bounds should have fired first and named what stuck; that ` +
    `they did not means the process was wedged where no JS timer could run, ` +
    `or it hung after reporting (teardown). See STC-259.`,
  );
  child.kill("SIGKILL");
}, ms);

child.on("close", (code, signal) => {
  clearTimeout(timer);
  // OUR SIGKILL is not news — it is the line above. Reporting it again as
  // "died by signal" reads like a second, independent fault, and the next
  // person goes looking for a crash that never happened.
  if (killedByBound) process.exit(1);
  if (signal) {
    console.error(`\n${name} died by signal ${signal} — that is a crash, not a bound firing.`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});

child.on("error", (e) => {
  clearTimeout(timer);
  console.error(`FAIL: could not start ${name}: ${e.message}`);
  process.exit(2);
});
