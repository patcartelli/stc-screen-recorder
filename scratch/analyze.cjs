// Terminal analyzer — computes the gate 1/2 clock model from the capture sidecars.
const fs = require('fs'), p = require('path');
const dir = process.argv[2] || p.join(process.env.HOME, 'dev/stc-screen-recorder/scratch/out');
const J = n => JSON.parse(fs.readFileSync(p.join(dir, n), 'utf8'));
const a = J('anchors.json'), ev = J('events.json'), fr = J('display-frames.json');
const NSPT = a.nsPerMachTick;
const f2 = n => (Math.round(n * 100) / 100);
const med = arr => { const b = [...arr].sort((x, y) => x - y); return b[b.length >> 1]; };
const avg = x => x.reduce((s, c) => s + c, 0) / x.length;
const P = console.log;

P('════ capture ════');
P(`timebase            ${a.machTimebaseNumer}/${a.machTimebaseDenom} → 1 tick = ${NSPT} ns`);
P(`display             ${a.displayPixelWidth}x${a.displayPixelHeight} px (${a.displayPointWidth}x${a.displayPointHeight} pt, scale ${a.displayBackingScale})`);
P(`frames              real=${a.screenFramesReal} repeat=${a.screenFramesRepeat} dropped=${a.screenFramesDropped}`);
P(`SCK frame statuses  ${JSON.stringify(a.screenStatusCounts)}`);
P(`events              ${a.eventCount} (tap re-enables: ${a.eventTapReenables})`);
P(`camera              auth=${a.cameraAuthorized} dev="${a.cameraDevice}" samples=${a.cameraSampleCount}`);
P(`mic                 auth=${a.micAuthorized} dev="${a.micDevice}" samples=${a.micSampleCount}`);
if (a.notes && a.notes.length) P('NOTES               ' + a.notes.join('\n                    '));

P('\n════ Q1 · CGEvent.timestamp units ════');
if (!ev.length) P('  no events captured — cannot determine'); else {
  const A = ev.map(e => (Number(e.recvMachRaw) - Number(e.tNs)) * NSPT / 1e6); // tNs as mach ticks
  const B = ev.map(e => (Number(e.recvMachNs) - Number(e.tNs)) / 1e6);         // tNs as nanoseconds
  const mA = med(A), mB = med(B);
  P(`  A) tNs is MACH TICKS  → median(recv − t) = ${f2(mA)} ms   [plausible: 0..50 ms]`);
  P(`  B) tNs is NANOSECONDS → median(recv − t) = ${f2(mB)} ms   [plausible: 0..50 ms]`);
  const okA = mA > -1 && mA < 50, okB = mB > -1 && mB < 50;
  P(`  VERDICT: ${okA && !okB ? 'A — CGEvent.timestamp is mach absolute TICKS' : okB && !okA ? 'B — CGEvent.timestamp is nanoseconds' : 'AMBIGUOUS'}`);
  const win = okA && !okB ? A : B;
  const s = [...win].sort((x, y) => x - y);
  P(`  event-tap delivery latency: p50=${f2(s[s.length >> 1])} p95=${f2(s[Math.floor(s.length * .95)])} max=${f2(s[s.length - 1])} ms`);
  P(`  CONVERSION FORMULA: displayTimeNs = displayTimeRaw * ${a.machTimebaseNumer}/${a.machTimebaseDenom}`);
  P(`                      eventNs       = tNs${okA && !okB ? ` * ${a.machTimebaseNumer}/${a.machTimebaseDenom}` : ' (already ns)'}`);
}

P('\n════ displayTime units + SCK capture latency ════');
const real = fr.filter(f => f.kind === 'real');
if (real.length) {
  const lat = real.filter(f => Number(f.recvMachRaw) > 0).map(f => (Number(f.recvMachRaw) - Number(f.displayTimeRaw)) * NSPT / 1e6);
  const s = [...lat].sort((x, y) => x - y);
  P(`  median(recvMachRaw − displayTimeRaw) = ${f2(s[s.length >> 1])} ms  (small+positive ⇒ displayTime IS mach ticks)`);
  P(`  SCK delivery latency: p50=${f2(s[s.length >> 1])} p95=${f2(s[Math.floor(s.length * .95)])} ms`);
  const drift = real.map(f => Number(f.driftNs) / 1e6);
  P(`\n════ Gate 1 · drift of real frames vs a perfect 60 Hz grid ════`);
  P(`  first 10 avg = ${f2(avg(drift.slice(0, 10)))} ms`);
  P(`  last  10 avg = ${f2(avg(drift.slice(-10)))} ms`);
  P(`  end − start  = ${f2(avg(drift.slice(-10)) - avg(drift.slice(0, 10)))} ms   [gate 1 needs |Δ| < 16.7]`);
  P(`  max |drift|  = ${f2(Math.max(...drift.map(Math.abs)))} ms`);
  P(`  → drift gate: ${Math.abs(avg(drift.slice(-10)) - avg(drift.slice(0, 10))) < 16.7 ? 'PASS' : 'FAIL'}`);
}

P('\n════ Q2 · camera/mic clock vs mach host clock ════');
const camP = Number(a.cameraFirstPtsNs), camR = Number(a.cameraFirstRecvMachRaw) * NSPT;
const micP = Number(a.micFirstPtsNs), micR = Number(a.micFirstRecvMachRaw) * NSPT;
if (a.cameraFirstPtsTimescale) {
  P(`  camera firstPTS timescale=${a.cameraFirstPtsTimescale} raw=${a.cameraFirstPtsRaw}`);
  P(`    pts=${f2(camP / 1e6)} ms  concurrent mach=${f2(camR / 1e6)} ms  Δ=${f2((camR - camP) / 1e6)} ms`);
} else P('  camera: no samples');
if (a.micFirstPtsTimescale) {
  P(`  mic    firstPTS timescale=${a.micFirstPtsTimescale} raw=${a.micFirstPtsRaw}`);
  P(`    pts=${f2(micP / 1e6)} ms  concurrent mach=${f2(micR / 1e6)} ms  Δ=${f2((micR - micP) / 1e6)} ms`);
} else P('  mic: no samples');
P(`  screen first displayTime = ${f2(Number(a.screenFirstDisplayTimeNs) / 1e6)} ms (mach ns)`);
if (a.cameraFirstPtsTimescale) P(`  ANCHOR OFFSET camera→screen = ${f2((camP - Number(a.screenFirstDisplayTimeNs)) / 1e6)} ms`);
if (a.micFirstPtsTimescale) P(`  ANCHOR OFFSET mic→screen    = ${f2((micP - Number(a.screenFirstDisplayTimeNs)) / 1e6)} ms`);

const clicks = ev.filter(e => e.typeName === 'leftMouseDown');
P(`\n════ clicks (for the harness viewer) ════`);
clicks.forEach((c, i) => {
  const ns = Number(c.tNs); // measured: CGEvent.timestamp is already nanoseconds
  const k = (ns - Number(a.screenFirstDisplayTimeNs)) / (1e9 / 60);
  P(`  click ${i + 1}: frame ${f2(k)}  at (${f2(c.x)}, ${f2(c.y)}) pt`);
});
