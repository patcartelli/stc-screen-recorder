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

const GATES = [
  // [label, skip marker, pass marker, fail marker]
  // Determinism's markers are bare "GATE:", which is a SUBSTRING of the other
  // three ("SEEK GATE: PASS" and friends), so it is matched with a guard.
  ["Determinism", "Determinism gate DID NOT RUN", /(^|[^A-Z])GATE: PASS/m, /(^|[^A-Z])GATE: FAIL/m],
  ["Seek", "Seek gate DID NOT RUN", /SEEK GATE: PASS/, /SEEK GATE: FAIL/],
  ["Export", "Export gate DID NOT RUN", /EXPORT GATE: PASS/, /EXPORT GATE: FAIL/],
  ["Identity", "Identity gate DID NOT RUN", /IDENTITY GATE: PASS/, /IDENTITY GATE: FAIL/],
];

const gh = (args) =>
  execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

const limit = Number(process.argv[2] ?? 20);
const runs = JSON.parse(
  gh(["run", "list", "--limit", String(limit),
      "--json", "databaseId,conclusion,event,headBranch,createdAt"]),
).filter((r) => r.conclusion);

const verdict = (log, [, skip, pass, fail]) =>
  log.includes(skip) ? "SKIP" : pass.test(log) ? "pass" : fail.test(log) ? "FAIL" : "-";

const tally = Object.fromEntries(GATES.map(([g]) => [g, { pass: 0, seen: 0 }]));
const header = GATES.map(([g]) => g.padStart(12)).join("");
console.log(`${"run".padEnd(12)} ${"result".padEnd(10)} ${"date".padEnd(11)}${header}`);
console.log("-".repeat(34 + 12 * GATES.length));

for (const r of runs) {
  let log = "";
  // A run whose logs have expired is skipped rather than counted as anything —
  // scoring it would quietly change the denominator.
  try { log = gh(["run", "view", String(r.databaseId), "--log"]); } catch { continue; }
  const cells = GATES.map((g) => {
    const v = verdict(log, g);
    if (v !== "-") tally[g[0]].seen++;
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
if (worst >= 50) {
  console.log(
    `\nA gate skipping ${worst.toFixed(0)}% of the time is not being checked. ` +
    `Per STC-259 the answer\nat that point is the decoder, NOT more attempts.`,
  );
}
