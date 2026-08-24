/**
 * Turns a recorded session's stats stream into thermal evidence.
 *
 * The helper reports CUMULATIVE counters, so a single number at the end cannot
 * show throttling: 5 minutes at a steady 30 fps and 2 minutes at 60 followed by
 * 3 at 12 look similar in aggregate. Differencing consecutive samples gives the
 * instantaneous rate, which is where a thermal fade actually shows up — phase 0
 * measured 18.7 -> 12.1 fps across a longer benchmark.
 *
 * Usage: node scripts/analyse-take.mjs <transcript.json> [sessionDir]
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const transcript = JSON.parse(readFileSync(process.argv[2], "utf8"));
const dir = process.argv[3];
const lines = transcript.transcript ?? [];
const stats = lines.filter((l) => l.ev === "stats" && l.state === "recording" && l.elapsedMs != null);

if (stats.length < 3) {
  console.error(`only ${stats.length} recording stats samples — nothing to analyse`);
  process.exit(2);
}

const stopped = lines.find((l) => l.ev === "stopped");
const warnings = lines.filter((l) => l.ev === "warning");
const drops = lines.filter((l) => l.ev === "stats-dropped");

console.log("=== totals ===");
if (stopped) {
  console.log(`frames ${stopped.frames}  dropped ${stopped.dropped}  ` +
              `nonMonotonic ${stopped.nonMonotonic}  events ${stopped.events}  ` +
              `tapReenables ${stopped.tapReenables}`);
  console.log(`duration ${(stopped.elapsedMs / 1000).toFixed(1)}s  ` +
              `mean ${(stopped.frames / (stopped.elapsedMs / 1000)).toFixed(1)} fps`);
}
if (drops.length) console.log(`telemetry lines dropped by the lossy channel: ${drops.length} notices`);

// instantaneous fps per interval
const rates = [];
for (let i = 1; i < stats.length; i++) {
  const dt = (stats[i].elapsedMs - stats[i - 1].elapsedMs) / 1000;
  const df = stats[i].frames - stats[i - 1].frames;
  if (dt > 0) rates.push({ at: stats[i].elapsedMs / 1000, fps: df / dt, dropped: stats[i].dropped });
}

const bucketSec = 30;
const buckets = new Map();
for (const r of rates) {
  const b = Math.floor(r.at / bucketSec) * bucketSec;
  if (!buckets.has(b)) buckets.set(b, []);
  buckets.get(b).push(r.fps);
}
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

console.log(`\n=== instantaneous fps by ${bucketSec}s bucket ===`);
const rows = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
for (const [start, fps] of rows) {
  const m = mean(fps);
  const bar = "#".repeat(Math.max(0, Math.round(m / 2)));
  console.log(`  ${String(start).padStart(4)}s  ${m.toFixed(1).padStart(5)} fps  ${bar}`);
}

// Comparing the first bucket to the last is worthless on a VFR capture: the
// rate tracks how much the SCREEN changed, not how hot the machine is. A static
// screen genuinely yields ~7 fps and that is correct behaviour, not throttling.
//
// What distinguishes them is CAPABILITY, not average. Thermal throttling is
// monotonic and irreversible over a run, so if the machine still reaches its
// peak rate late in the recording, it was never throttled — whatever the mean
// did in between. Compare the best each half achieved.
const half = Math.ceil(rows.length / 2);
const peakOf = (rs) => Math.max(...rs.flatMap(([, fps]) => fps));
const earlyPeak = peakOf(rows.slice(0, half));
const latePeak = peakOf(rows.slice(half));
const capability = ((latePeak - earlyPeak) / earlyPeak) * 100;

console.log(`\npeak fps, first half: ${earlyPeak.toFixed(1)}   second half: ${latePeak.toFixed(1)}` +
            `   change ${capability >= 0 ? "+" : ""}${capability.toFixed(1)}%`);
console.log(`(mean rate follows screen activity on a VFR capture and says nothing about heat)`);

const finalDropped = stopped?.dropped ?? rates[rates.length - 1]?.dropped ?? 0;
console.log(`\n=== verdict ===`);
console.log(`dropped frames: ${finalDropped} ${finalDropped === 0 ? "(none — writer kept up)" : "(WRITER FELL BEHIND)"}`);
console.log(`throttling:     ${capability < -25 ? "LIKELY — the machine could not reach its earlier peak late in the run"
                                                : "no evidence — peak capability held to the end"}`);
if (warnings.length) {
  console.log(`warnings:`);
  for (const w of warnings) console.log(`  ${w.code}: ${String(w.detail ?? "").slice(0, 120)}`);
} else {
  console.log("warnings:      none");
}

if (dir && existsSync(join(dir, "anchors.json"))) {
  const a = JSON.parse(readFileSync(join(dir, "anchors.json"), "utf8"));
  console.log(`\nstop reason:   ${a.stop?.reason ?? "(none recorded)"}`);
}
