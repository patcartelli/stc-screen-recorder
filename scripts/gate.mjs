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
import {
  bounded, closeQuietly, instrumentPage, EVAL_MS, ENCODER_MS, GATE_DECODER_PREFERENCE,
} from "./gate-bounds.mjs";

const server = await createServer({ configFile: "harness/vite.config.ts" });
await server.listen(5199);

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();

// Mode B: the renderer's main thread blocks, so nothing inside the page can
// report and every in-page bound is dead. The page's checkpoints are collected
// out here instead, where a wedge cannot reach them. This also installs the
// STC_GATE_FAULT=wedge:<checkpoint> injection that makes the path reachable.
const trail = await instrumentPage(page);

const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

let failed = false;
const fail = (msg) => { failed = true; console.error("FAIL:", msg); };

/**
 * The machine declined, as distinct from the gate finding a wrong answer.
 *
 * ONLY a bound firing counts. Every determinism check in this file reports
 * through fail() with a concrete number — a hash mismatch, a frame count, zero
 * encoded bytes — and none of those may ever be retried or skipped, because
 * they are the regressions the gate exists to catch. A timeout is the one
 * failure that carries no information about the code.
 */
const BOUND_FIRED = [
  /did not complete within \d+ms/,        // an in-page bound (decoder, encoder)
  /did not return within \d+ ?ms/,        // the out-of-process bound on the page
];
const environment = (msg) => {
  failed = true;
  console.error("ENVIRONMENT:", msg);
  // Here, not at the catch site: a diagnosis wired per call site is one that
  // gets forgotten at the next one.
  trail.dump();
};

try {
  // A retry nobody has watched happen is the same trap as a bound nobody has
  // watched fire. STC_GATE_FAULT makes the machine-declined path reachable on
  // demand; the tests assert against observed behaviour, not the code reading
  // as though it would work.
  if (process.env.STC_GATE_FAULT === "environment") {
    throw new Error("decoder flush did not complete within 60000ms (INJECTED)");
  }
  if (process.env.STC_GATE_FAULT === "regression") {
    fail("gate A: 7 preview/export hash mismatches (INJECTED)");
    throw new Error("injected regression");
  }
  await page.goto("http://localhost:5199/");
  await page.waitForFunction(() => window.__ready === true, { timeout: 60_000 });
  const r = await bounded(
    page.evaluate((ms) => window.runGate({ encoderMs: ms }), ENCODER_MS),
    EVAL_MS, "the in-page gate run (decode, render, encode)");

  // The page must have used the bound it was handed, not one of its own. Two
  // sides believing they agree is how the bounds drift apart unnoticed.
  if (r.encoderBoundMs !== ENCODER_MS) {
    fail(`page used encoder bound ${r.encoderBoundMs}ms, runner sent ${ENCODER_MS}ms`);
  }
  // The decoder the runner asked for actually reached the page. Without this a
  // failed addInitScript leaves the page on Chromium's default — the path that
  // wedges on CI — and the gate passes having tested the wrong thing.
  if (r.decoderPreference !== GATE_DECODER_PREFERENCE) {
    fail(`page used decoder preference ${JSON.stringify(r.decoderPreference)}, ` +
         `runner sent ${JSON.stringify(GATE_DECODER_PREFERENCE)}`);
  }

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
  const msg = String(e);
  // A bound fired => the machine did not service the pipeline. Anything else
  // thrown here is ours. `failed` is set either way; only the LABEL differs,
  // and scripts/gate-retry.mjs keys on that label alone.
  if (BOUND_FIRED.some((re) => re.test(msg))) environment(msg);
  else fail(msg);
} finally {
  if (consoleErrors.length) {
    console.error("--- page console errors ---");
    for (const e of consoleErrors) console.error(" ", e);
  }
  await closeQuietly(browser, server);
}
console.log(failed ? "\nGATE: FAIL" : "\nGATE: PASS");
process.exit(failed ? 1 : 0);
