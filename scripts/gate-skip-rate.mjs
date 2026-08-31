#!/usr/bin/env node
/**
 * How often does each gate actually RUN on CI?
 *
 * A skipped gate is not a passed gate. All four gates label a machine fault
 * ENVIRONMENT and skip rather than redden (STC-259), which is correct — a red X
 * that means either "you broke determinism" or "Apple's shared GPU did not
 * answer" is ambiguous, not loud. The cost is that a gate can stop running
 * entirely without anything going red, which is CLAUDE.md's standing "succeeds
 * by finding nothing to do" trap in a new place.
 *
 * This is the number that detects that. Run it before trusting a green tick:
 *
 *   node scripts/gate-skip-rate.mjs [runs]      # default 20
 *
 * Detection is by each gate's OWN markers, never by step name. An earlier
 * hand-rolled version of this keyed on the step-name text, which for three of
 * the four gates only appears WHEN THEY SKIP — so it scored every healthy run
 * as "no signal" and reported a skip rate built from the skips alone.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const GATES = [
  // [label, CI step, skip marker, pass marker, fail marker, unattributedSafe]
  //
  // Every marker is matched ONLY inside that gate's own step WHEN step
  // attribution is available. The first version of this searched the whole-job
  // log, and `npm test` exercises announceSkip in
  // transform/test/gate-retry.test.ts — which prints a real, verbatim
  // "Determinism gate DID NOT RUN" line into the Test step. That fixture was
  // then read as a live skip and the gate was reported as never running, on
  // runs where it had passed in nine seconds.
  //
  // `unattributedSafe` says whether a gate's markers can be trusted WITHOUT
  // attribution. Only Determinism's are printed by a test, so the other three
  // can be measured on a run whose logs GitHub has not attributed yet — which
  // is every run for its first few hours, and therefore every run anyone
  // actually wants to check after a change. transform/test/gate-skip-rate.test.ts
  // asserts the flag against the test tree rather than trusting this comment.
  //
  // Export and identity share a step; their own markers separate them.
  ["Determinism", /^Determinism gate \(fixture\)$/, "Determinism gate DID NOT RUN",
    /(^|[^A-Z])GATE: PASS/m, /(^|[^A-Z])GATE: FAIL/m, false],
  ["Seek", /^Seek gate \(fixture\)$/, "Seek gate DID NOT RUN",
    /SEEK GATE: PASS/, /SEEK GATE: FAIL/, true],
  ["Export", /^Export and identity gates/, "Export gate DID NOT RUN",
    /EXPORT GATE: PASS/, /EXPORT GATE: FAIL/, true],
  ["Identity", /^Export and identity gates/, "Identity gate DID NOT RUN",
    /IDENTITY GATE: PASS/, /IDENTITY GATE: FAIL/, true],
];

/** Exported so a test can assert the flag against what the test tree prints. */
export const UNATTRIBUTED_SAFE_MARKERS = GATES
  .filter((g) => g[5])
  .flatMap((g) => [g[2], String(g[3]).replace(/^\/|\/[a-z]*$/g, "")]);

/**
 * `gh run view --log` emits `job<TAB>step<TAB>timestamp message`. Slicing by the
 * step column is what keeps a gate's verdict separate from a unit test that
 * merely prints the same words.
 */
function hasStepAttribution(log) {
  for (const line of log.split("\n")) {
    const p = line.split("\t");
    if (p.length >= 3 && p[1] && p[1] !== "UNKNOWN STEP") return true;
  }
  return false;
}

function stepText(log, stepPattern) {
  const out = [];
  for (const line of log.split("\n")) {
    const parts = line.split("\t");
    if (parts.length >= 3 && stepPattern.test(parts[1])) out.push(parts.slice(2).join("\t"));
  }
  return out.join("\n");
}

/**
 * The executable half. Guarded so a test can import the tables above without
 * this reaching for `gh` — the flag those tables carry is only true while no
 * test prints the markers, and that is worth asserting rather than commenting.
 */
async function main() {
  const gh = (args) =>
    execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

  const limit = Number(process.argv[2] ?? 20);
  const runs = JSON.parse(
    gh(["run", "list", "--limit", String(limit),
        "--json", "databaseId,conclusion,event,headBranch,createdAt"]),
  ).filter((r) => r.conclusion);

  const verdict = (log, [, step, skip, pass, fail, unattributedSafe], attributed) => {
    // With attribution, scope to the gate's own step — always correct.
    // Without it, fall back to the whole log for the gates whose markers no test
    // prints. Determinism is excluded and reported as unmeasurable, because its
    // markers are exactly the ones a unit test emits.
    if (!attributed) return unattributedSafe ? classify(log, skip, pass, fail) : "n/a";
    const text = stepText(log, step);
    if (!text) return "-";                       // the step did not run at all
    return classify(text, skip, pass, fail);
  };

  const classify = (text, skip, pass, fail) =>
    text.includes(skip) ? "SKIP" : pass.test(text) ? "pass" : fail.test(text) ? "FAIL" : "-";

  const tally = Object.fromEntries(GATES.map(([g]) => [g, { pass: 0, seen: 0 }]));
  let unmeasurable = 0;
  const header = GATES.map(([g]) => g.padStart(12)).join("");
  console.log(`${"run".padEnd(12)} ${"result".padEnd(10)} ${"date".padEnd(11)}${header}`);
  console.log("-".repeat(34 + 12 * GATES.length));

  for (const r of runs) {
    let log = "";
    // A run whose logs have expired is skipped rather than counted as anything —
    // scoring it would quietly change the denominator.
    try { log = gh(["run", "view", String(r.databaseId), "--log"]); } catch { continue; }
    // GitHub drops per-step attribution on older runs and reports every line as
    // "UNKNOWN STEP". Verdicts cannot be scoped to a gate there, and scoring such
    // a run on whole-log text is what produced a 100% skip rate for a gate that
    // was passing — `npm test` prints a verbatim skip line of its own. Counted and
    // named, never folded into the denominator as though it were a result.
    const attributed = hasStepAttribution(log);
    if (!attributed) unmeasurable++;
    const cells = GATES.map((g) => {
      const v = verdict(log, g, attributed);
      if (v === "SKIP" || v === "pass" || v === "FAIL") tally[g[0]].seen++;
      if (v === "pass") tally[g[0]].pass++;
      return v.padStart(12);
    });
    console.log(
      `${String(r.databaseId).padEnd(12)} ${r.conclusion.padEnd(10)} ` +
      `${r.createdAt.slice(0, 10).padEnd(11)}${cells.join("")}`,
    );
  }

  console.log(`\n${"GATE".padEnd(14)}${"passed".padStart(8)}${"observed".padStart(10)}${"skip rate".padStart(12)}`);
  let worst = 0;
  for (const [g] of GATES) {
    const { pass, seen } = tally[g];
    const rate = seen ? (100 * (seen - pass)) / seen : 0;
    worst = Math.max(worst, rate);
    console.log(
      `${g.padEnd(14)}${String(pass).padStart(8)}${String(seen).padStart(10)}` +
      `${(seen ? `${rate.toFixed(0)}%` : "n/a").padStart(12)}`,
    );
  }
  if (unmeasurable) {
    console.log(
      `\n${unmeasurable} of ${runs.length} runs had no per-step log attribution — GitHub adds it\n` +
      "some hours after a run, so this is normal for anything recent. Seek, export and\n" +
      "identity are still measured there from markers no test prints; determinism shows\n" +
      "n/a, because its markers are exactly the ones a unit test emits. n/a is excluded\n" +
      "from the rates, never counted as a skip.",
    );
  }
  if (worst >= 50) {
    console.log(
      `\nA gate skipping ${worst.toFixed(0)}% of the time is not being checked. ` +
      `Per STC-259 the answer\nat that point is the decoder, NOT more attempts.`,
    );
  }

}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
