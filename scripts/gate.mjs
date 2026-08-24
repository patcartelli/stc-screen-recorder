// Increment 0 gate (PHASE-1 increment 0):
//   A. for 200 sampled t, the pre-encode RGBA buffer from the preview sink and
//      the export sink is byte-identical (compared via SHA-256), with preview
//      visiting the t values in shuffled order;
//   B. two independent export runs produce matching pre-encode hashes for all
//      300 output frames;
//   C. the export sink actually encodes (WebCodecs VideoEncoder -> mp4-muxer).
// Encoded MP4 bytes are NOT compared — container timestamps and encoder state
// are not contractually deterministic; the gate lives before the encoder.
import { createServer } from "vite";
import { chromium } from "playwright";

const server = await createServer({ configFile: "harness/vite.config.ts" });
await server.listen(5199);

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

let failed = false;
const fail = (msg) => { failed = true; console.error("FAIL:", msg); };

try {
  await page.goto("http://localhost:5199/");
  await page.waitForFunction(() => window.__ready === true, { timeout: 60_000 });
  const r = await page.evaluate(() => window.runGate());

  console.log(`demuxed frame grid matches frames.json: ${r.framesMatch}`);
  if (!r.framesMatch) fail("demuxed PTS grid != fixtures/basic/frames.json");

  let mismatchA = 0;
  for (let i = 0; i < r.sampledK.length; i++) {
    if (r.previewHash[i] !== r.exportHashA[r.sampledK[i]]) mismatchA++;
  }
  console.log(`gate A — preview vs export, ${r.sampledK.length} sampled t (shuffled preview order): ${mismatchA} mismatches`);
  if (r.sampledK.length !== 200) fail(`expected 200 sampled t, got ${r.sampledK.length}`);
  if (mismatchA > 0) fail(`gate A: ${mismatchA} preview/export hash mismatches`);

  let mismatchB = 0;
  for (let k = 0; k < r.exportHashA.length; k++) {
    if (r.exportHashA[k] !== r.exportHashB[k]) mismatchB++;
  }
  console.log(`gate B — two independent exports, ${r.exportHashA.length} frames: ${mismatchB} mismatches`);
  if (r.exportHashA.length !== 300) fail(`expected 300 export frames, got ${r.exportHashA.length}`);
  if (mismatchB > 0) fail(`gate B: ${mismatchB} export/export hash mismatches`);

  console.log(`gate C — encoded MP4 size: ${r.encodedBytes} bytes`);
  if (!(r.encodedBytes > 0)) fail("gate C: encode pipeline produced no bytes");
} catch (e) {
  fail(String(e));
} finally {
  if (consoleErrors.length) {
    console.error("--- page console errors ---");
    for (const e of consoleErrors) console.error(" ", e);
  }
  await browser.close();
  await server.close();
}
console.log(failed ? "\nGATE: FAIL" : "\nGATE: PASS");
process.exit(failed ? 1 : 0);
